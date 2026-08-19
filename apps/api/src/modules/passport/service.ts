// apps/api/src/modules/passport/service.ts
//
// the spec (P6 gate). Every mutation follows earlier phases's pattern
// exactly: can() first, @tol/domain state-transition validation second,
// a transaction that persists + writes BOTH an AuditEvent and a
// DomainEvent. Readiness goes through @tol/evidence's REAL
// computeReadiness() — never a hand-typed number, same anti-fabrication
// discipline as the real scoreClaim().
//
// READINESS/STATUS RECOMPUTE, the mechanism this whole module exists to
// prove real (P6 exit condition: "Missing evidence blocks readiness;
// provenance/freshness visible"):
//   1. Every MUTATION (upsertFact, addEvidence, verify's own pre-check)
//      re-reads ALL of this passport's Facts fresh (with their linked
//      Evidence for expiresAt), builds FactSnapshot[], calls the REAL
//      computeReadiness(snapshots, now, inputVersions), and PERSISTS a
//      new ReadinessResult row (append-only history, same precedent as
//      ClaimDecision snapshotting scoreBreakdown).
//   2. The resulting status target is computed by targetStatusAfterRecompute
//      (below) and, if it differs from the current status, written
//      through @tol/domain's assertValidPassportTransition — never an
//      arbitrary field write (p.5 STATE RULE).
//   3. Every READ (getById/getByOrganizationId) additionally runs the
//      CHEAP, side-effect-free isPassportReadinessStale() check against
//      the LATEST persisted ReadinessResult's computedAt — if the
//      passport has aged past the staleness window with no fresh
//      recompute, it transitions to STALE on this read before
//      returning. This is the "synchronous/on-read computation"
//      the P6 gate can be satisfied with per this day's own build
//      instructions, given apps/worker doesn't exist until earlier.

import { can, type Actor } from "@tol/authz";
import { assertValidPassportTransition, targetStatusAfterRecompute } from "@tol/domain";
import {
  evidenceRepository,
  factRepository,
  passportRepository,
  prisma,
  readinessResultRepository,
  type Evidence,
  type Fact,
  type Passport,
  type Prisma,
  type ReadinessResult,
} from "@tol/db";
import { computeReadiness, isReadinessBlocked, type FactSnapshot } from "@tol/evidence";
import { enqueuePassportReadiness } from "@tol/queue";
import { isPassportReadinessStale, type PassportStatus } from "@tol/domain";
import type { CreateEvidenceRequest, UpsertFactRequest, VerifyPassportRequest } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

/** Every role with a cross-org passport.read/list grant (packages/authz/src/matrix.ts) — everyone except the three own-org-only maintainer roles and FINANCE_OPERATOR (no grant at all). */
const CROSS_ORG_PASSPORT_READ_ROLES = new Set([
  "PLATFORM_OWNER",
  "MARKETPLACE_OPERATOR",
  "PARTNERSHIP_LEAD",
  "UNDERWRITING_ANALYST",
  "COMPLIANCE_REVIEWER",
  "AUDITOR_READONLY",
]);

/** the spec acceptance-adjacent: how long a computed ReadinessResult stays trustworthy before a fresh read demotes the passport to STALE — not scope-specified numerically, documented inference matching @tol/evidence's own capacityFreshnessWindowDays.aging (90 days), reused here rather than inventing a third unrelated constant. */
const READINESS_STALE_AFTER_DAYS = 90;

export interface PassportDetail {
  passport: Passport;
  facts: Fact[];
  evidence: Evidence[];
  readiness: ReadinessResult | null;
}

function buildSnapshots(facts: (Fact & { evidence: Evidence | null })[]): FactSnapshot[] {
  return facts.map((f) => ({
    fieldKey: f.fieldKey,
    sectionType: f.sectionType,
    hasValue: f.normalizedValue !== null,
    verification: f.verification,
    expiresAt: f.evidence?.expiresAt ?? null,
    updatedAt: f.updatedAt,
  }));
}

/** Re-reads Facts fresh, computes readiness via the REAL engine, persists a new ReadinessResult, and applies the resulting status transition (if any) — the one place this module's mutations converge. Must run INSIDE the caller's transaction. Status-decision logic itself lives in @tol/domain's targetStatusAfterRecompute (moved there earlier so apps/worker's own passport-readiness job shares the identical rule — see that function's own header comment). */
async function recomputeReadinessAndStatus(
  tx: Prisma.TransactionClient,
  passport: Passport,
  now: Date,
  actorUserId: string,
  actorOrgId: string,
  context: RequestContext,
): Promise<{ readiness: ReadinessResult; newStatus: PassportStatus }> {
  const facts = await factRepository.listByPassport(tx, passport.id);
  const factsWithEvidence = await Promise.all(
    facts.map(async (f) => ({ ...f, evidence: f.evidenceId ? await evidenceRepository.findById(tx, f.evidenceId) : null })),
  );
  const snapshots = buildSnapshots(factsWithEvidence);
  const inputVersions = facts.map((f) => `fact:${f.id}:v${f.version}`);
  const result = computeReadiness(snapshots, now, inputVersions);
  const blocked = isReadinessBlocked(result);

  const readiness = await readinessResultRepository.create(tx, {
    passportId: passport.id,
    score: result.score,
    blockers: result.blockers as unknown as Record<string, unknown>[],
    warnings: result.warnings as unknown as Record<string, unknown>[],
    ruleVersion: result.ruleVersion,
    algorithmVersion: result.algorithmVersion,
    inputVersions: result.inputVersions,
    computedAt: now,
    createdByUserId: actorUserId,
    createdByOrgId: actorOrgId,
  });

  await auditWriter(context).write(tx, {
    actorUserId,
    actorOrgId,
    actorRole: null,
    subjectOrgId: passport.organizationId,
    action: "passport.readiness_computed",
    resourceType: "passport",
    resourceId: passport.id,
    afterValue: { score: result.score, blockerCount: result.blockers.length, warningCount: result.warnings.length },
  });
  await timelineWriter(context).write(tx, {
    eventType: "passport.readiness_computed",
    aggregateType: "passport",
    aggregateId: passport.id,
    payload: { score: result.score, blockerCount: result.blockers.length, warningCount: result.warnings.length, algorithmVersion: result.algorithmVersion },
    actorUserId,
    actorOrgId,
    actorRole: null,
  });

  const targetStatus = targetStatusAfterRecompute(passport.status, facts.length > 0, blocked);
  if (targetStatus !== passport.status) {
    assertValidPassportTransition(passport.status, targetStatus);
    await passportRepository.updateStatus(tx, passport.id, targetStatus, actorUserId);
    await timelineWriter(context).write(tx, {
      eventType: "passport.status_changed",
      aggregateType: "passport",
      aggregateId: passport.id,
      payload: { from: passport.status, to: targetStatus },
      actorUserId,
      actorOrgId,
      actorRole: null,
    });
  }

  return { readiness, newStatus: targetStatus };
}

/**
 * Shared by getById/getByOrganizationId — can() check, the staleness
 * transition, then the full detail load. A plain module-level function
 * rather than a `passportService` method reached via `this` (the
 * service object below is a plain object literal, not a class — calling
 * a sibling method via `this.foo()` is only safe as long as every
 * caller invokes it as `passportService.foo()`, never through a
 * destructured reference; avoiding `this` entirely here removes that
 * whole footgun class rather than relying on callers always getting it
 * right).
 */
async function loadDetailWithStalenessCheck(actor: Actor, passport: Passport): Promise<PassportDetail> {
  const decision = can(actor, "passport.read", { type: "passport", id: passport.id, ownerOrgId: passport.organizationId });
  if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

  const now = new Date();
  const latest = await readinessResultRepository.findLatestByPassport(prisma, passport.id);
  let current = passport;
  let freshLatest = latest;
  if (latest && isPassportReadinessStale(passport.status, latest.computedAt, now, READINESS_STALE_AFTER_DAYS)) {
    // Re-read fresh INSIDE the transaction before writing — the
    // established check-then-act race guard, applied here after
    // investigating a review finding that (as literally stated) was false, but pointed
    // at a real gap this file's own pass then found independently: the
    // ORIGINAL code closed over the outer `passport.status` read BEFORE
    // this transaction even started, so a genuinely concurrent mutation
    // (e.g. upsertFact() landing a real regression READY -> INCOMPLETE
    // on another connection between this function's outer read and this
    // transaction committing) would have its result SILENTLY OVERWRITTEN
    // by this stale-check blindly writing STALE over it — a real
    // correctness bug, not merely a benign double-write. Re-reading here
    // and re-validating the transition against the FRESH status closes
    // that gap: if the passport is no longer at the status this
    // function originally observed, the stale-check simply no-ops
    // (a concurrent mutation already changed it to something current).
    current = await withTransaction(async (tx) => {
      // earlier-stage work fix — see passportService.upsertFact()'s identical
      // comment for the full reasoning: without this lock, a concurrent
      // passport-readiness worker job or verify() call can commit a fresh,
      // non-stale status in the window between this function's re-read and
      // its own write, which this GET-triggered auto-transition would then
      // silently overwrite back to STALE.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passport.id}))`;
      const fresh = await passportRepository.findById(tx, passport.id);
      if (!fresh) return passport;

      // identified fix (earlier-stage work, 3465bf4 review): staleness
      // depends on BOTH the passport's status AND the latest
      // ReadinessResult's computedAt — re-reading only `fresh` (status)
      // while still checking against the OUTER `latest.computedAt`
      // (captured before this lock, at the top of this function) reopens
      // the exact class of bug this lock exists to close. A concurrent
      // recompute (a passport-readiness worker job, or another request)
      // can commit a FRESH ReadinessResult in the window between this
      // function's outer read and this transaction acquiring the lock;
      // checking that fresh status against the now-superseded OLD
      // computedAt would judge it stale anyway and wrongly clobber the
      // just-recomputed value back to STALE. Re-read the ReadinessResult
      // fresh too, inside the same lock, and use THAT — never the outer
      // `latest` — for both the staleness decision and the value this
      // function ultimately returns (below): no input to this decision may
      // come from before the lock.
      const freshReadiness = await readinessResultRepository.findLatestByPassport(tx, passport.id);
      freshLatest = freshReadiness ?? latest;
      if (!freshReadiness || !isPassportReadinessStale(fresh.status, freshReadiness.computedAt, now, READINESS_STALE_AFTER_DAYS)) {
        return fresh;
      }
      assertValidPassportTransition(fresh.status, "STALE");
      return passportRepository.updateStatus(tx, passport.id, "STALE", null);
    });
  }

  const [facts, evidence] = await Promise.all([
    factRepository.listByPassport(prisma, passport.id),
    evidenceRepository.listByPassport(prisma, passport.id),
  ]);
  return { passport: current, facts, evidence, readiness: freshLatest };
}

export const passportService = {
  async list(actor: Actor): Promise<Passport[]> {
    const decision = can(actor, "passport.list", { type: "passport", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (actor.role !== null && CROSS_ORG_PASSPORT_READ_ROLES.has(actor.role)) {
      return passportRepository.list(prisma);
    }
    if (!actor.organizationId) return [];
    const own = await passportRepository.findByOrganizationId(prisma, actor.organizationId);
    return own ? [own] : [];
  },

  async getById(actor: Actor, id: string): Promise<PassportDetail> {
    const passport = await passportRepository.findById(prisma, id);
    if (!passport) throw ProblemError.notFound("Passport not found.");
    return loadDetailWithStalenessCheck(actor, passport);
  },

  async getByOrganizationId(actor: Actor, organizationId: string): Promise<PassportDetail> {
    const passport = await passportRepository.findByOrganizationId(prisma, organizationId);
    if (!passport) throw ProblemError.notFound("No Passport exists yet for this organization.");
    return loadDetailWithStalenessCheck(actor, passport);
  },

  async create(actor: Actor, context: RequestContext): Promise<Passport> {
    if (!actor.organizationId) throw ProblemError.forbidden("Actor has no active organization membership.");

    const decision = can(actor, "passport.create", { type: "passport", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const existing = await passportRepository.findByOrganizationId(prisma, actor.organizationId);
    if (existing) throw ProblemError.conflict("This organization already has a Passport — use the existing one.");

    const result = await withTransaction(async (tx) => {
      const created = await passportRepository.create(tx, {
        organizationId: actor.organizationId!,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: actor.organizationId,
        action: "passport.created",
        resourceType: "passport",
        resourceId: created.id,
        afterValue: { organizationId: actor.organizationId },
      });
      await timelineWriter(context).write(tx, {
        eventType: "passport.created",
        aggregateType: "passport",
        aggregateId: created.id,
        payload: { organizationId: actor.organizationId! },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      // A zero-fact Passport still gets an initial ReadinessResult
      // (score reflecting zero of N required facts present) — same
      // "score atomically on creation" precedent as Claim's
      // file-then-score-in-one-transaction (earlier).
      await recomputeReadinessAndStatus(tx, created, new Date(), actor.userId, actor.organizationId!, context);

      return created;
    });

    // earlier-stage work: event-triggered enqueue — a durable, idempotent
    // reconciliation safety-net over the synchronous
    // recomputeReadinessAndStatus call just above (same additive design as
    // apps/worker's economics-accrual.job.ts). safeEnqueue-backed and
    // called AFTER the transaction commits, never from inside it, so an
    // unreachable Redis can neither fail this already-committed HTTP
    // response nor extend how long the transaction holds its Postgres locks.
    await enqueuePassportReadiness(result.id);

    return result;
  },

  async upsertFact(actor: Actor, passportId: string, input: UpsertFactRequest, context: RequestContext): Promise<{ fact: Fact; readiness: ReadinessResult; status: PassportStatus }> {
    const passport = await passportRepository.findById(prisma, passportId);
    if (!passport) throw ProblemError.notFound("Passport not found.");

    const decision = can(actor, "passport.update", { type: "passport", id: passport.id, ownerOrgId: passport.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (input.evidenceId) {
      const evidence = await evidenceRepository.findById(prisma, input.evidenceId);
      if (!evidence || evidence.passportId !== passportId) {
        throw ProblemError.badRequest("evidenceId does not reference evidence belonging to this Passport.");
      }
    }

    const result = await withTransaction(async (tx) => {
      // earlier-stage work fix (real bug — caught by the new worker-integration
      // test racing a real spawned worker against this endpoint for the
      // first time in this codebase's history): pg_advisory_xact_lock
      // BEFORE any read, same pattern as claims/service.ts:363 and
      // apps/worker's own passport-readiness.job.ts. Without it, a
      // concurrent passport-readiness worker job (enqueued by an earlier
      // mutation on this same passport, still in flight) can read this
      // passport's status BEFORE this transaction commits and then write
      // its OWN, now-stale, computed target status AFTER this transaction
      // commits — silently clobbering whatever this call just set (e.g. a
      // human reviewer's VERIFIED, or this very call's own fresh
      // recompute). Re-reading fresh alone (the pre-existing earlier
      // pattern, kept below) only protects against a race where the OTHER
      // side already committed — it does not serialize two genuinely
      // concurrent transactions the way this lock does.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passportId}))`;
      const freshPassport = await passportRepository.findById(tx, passportId);
      if (!freshPassport) throw ProblemError.internal("Passport disappeared mid-transaction.");

      const fact = await factRepository.upsertByFieldKey(tx, {
        passportId,
        sectionType: input.sectionType,
        fieldKey: input.fieldKey,
        normalizedValue: input.normalizedValue,
        verification: input.verification ?? "SELF_REPORTED",
        evidenceId: input.evidenceId ?? null,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
        updatedByUserId: actor.userId,
      });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: passport.organizationId,
        action: "passport.fact_updated",
        resourceType: "passport",
        resourceId: passportId,
        afterValue: { fieldKey: input.fieldKey, sectionType: input.sectionType, verification: fact.verification },
      });
      await timelineWriter(context).write(tx, {
        eventType: "passport.fact_updated",
        aggregateType: "passport",
        aggregateId: passportId,
        payload: { fieldKey: input.fieldKey, sectionType: input.sectionType, verification: fact.verification },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      const { readiness, newStatus } = await recomputeReadinessAndStatus(tx, freshPassport, new Date(), actor.userId, freshPassport.organizationId, context);
      return { fact, readiness, status: newStatus };
    });

    // earlier-stage work: event-triggered enqueue — see create()'s identical
    // comment above for the full reasoning (additive safety-net, fired
    // after commit, safeEnqueue-backed).
    await enqueuePassportReadiness(passportId);

    return result;
  },

  async addEvidence(actor: Actor, passportId: string, input: CreateEvidenceRequest, context: RequestContext): Promise<Evidence> {
    const passport = await passportRepository.findById(prisma, passportId);
    if (!passport) throw ProblemError.notFound("Passport not found.");

    const decision = can(actor, "passport.update", { type: "passport", id: passport.id, ownerOrgId: passport.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const result = await withTransaction(async (tx) => {
      const evidence = await evidenceRepository.create(tx, {
        passportId,
        type: input.type,
        objectRef: input.objectRef,
        checksum: input.checksum ?? null,
        issuer: input.issuer ?? null,
        collectedAt: new Date(input.collectedAt),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: passport.organizationId,
        action: "passport.evidence_added",
        resourceType: "passport",
        resourceId: passportId,
        afterValue: { evidenceId: evidence.id, type: evidence.type },
      });
      await timelineWriter(context).write(tx, {
        eventType: "passport.evidence_added",
        aggregateType: "passport",
        aggregateId: passportId,
        payload: { evidenceId: evidence.id, type: evidence.type },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return evidence;
    });

    // earlier-stage work: event-triggered enqueue — see create()'s identical
    // comment above for the full reasoning. Evidence isn't linked to a
    // Fact until a separate upsertFact({evidenceId}) call references it
    // (this endpoint creates a standalone Evidence row), so this is
    // frequently a no-op recompute today — enqueued anyway per this day's
    // own instruction (passport/fact change -> readiness recompute) and
    // because it is a genuinely free, idempotent no-op when nothing
    // changed, not a wasted one.
    await enqueuePassportReadiness(passportId);

    return result;
  },

  /**
   * The reviewer step (READY -> VERIFIED). Deliberately MORE
   * restrictive than @tol/domain's bare state machine allows (which
   * also permits STALE -> VERIFIED structurally) — this service only
   * ever verifies a passport that is CURRENTLY READY, never one that has
   * aged into STALE, same class of service-layer narrowing as claims
   * service's self-certification guard (a business rule can() alone
   * cannot express).
   */
  async verify(actor: Actor, passportId: string, input: VerifyPassportRequest, context: RequestContext): Promise<Passport> {
    const passport = await passportRepository.findById(prisma, passportId);
    if (!passport) throw ProblemError.notFound("Passport not found.");

    const decision = can(actor, "passport.verify", { type: "passport", id: passport.id, ownerOrgId: passport.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (passport.status !== "READY") {
      throw ProblemError.conflict(`Passport cannot be verified from its current status (${passport.status}); must be READY.`);
    }

    return withTransaction(async (tx) => {
      // earlier-stage work fix — see upsertFact()'s identical comment above for
      // the full reasoning: without this lock, a concurrent
      // passport-readiness worker job (or another concurrent verify()/
      // upsertFact() call) can race this transaction and clobber the
      // VERIFIED status this call is about to set, or vice versa.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passportId}))`;
      const fresh = await passportRepository.findById(tx, passportId);
      if (!fresh) throw ProblemError.internal("Passport disappeared mid-transaction.");
      if (fresh.status !== "READY") {
        throw ProblemError.conflict(`Passport cannot be verified from its current status (${fresh.status}); must be READY.`);
      }
      assertValidPassportTransition(fresh.status, "VERIFIED");

      const updated = await passportRepository.updateStatus(tx, passportId, "VERIFIED", actor.userId);

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: passport.organizationId,
        action: "passport.verified",
        resourceType: "passport",
        resourceId: passportId,
        reason: input.reason,
        afterValue: { reviewerOrgId: actor.organizationId },
      });
      await timelineWriter(context).write(tx, {
        eventType: "passport.verified",
        aggregateType: "passport",
        aggregateId: passportId,
        payload: { reviewerOrgId: actor.organizationId!, reason: input.reason },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return updated;
    });
  },
};
