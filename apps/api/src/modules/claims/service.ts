// apps/api/src/modules/claims/service.ts
//
// the spec/p.18 (P10 gate). Every mutation follows earlier phases's pattern
// exactly: can() first, @tol/domain state-transition validation second,
// a transaction that persists + writes BOTH an AuditEvent and a
// DomainEvent, re-read-inside-transaction for every check-then-act race
// (the established guard, reused here for dispute-filing and
// deciding). Scoring goes through @tol/attribution's REAL scoreClaim() —
// never a hand-computed or fabricated number, same anti-fabrication
// discipline as the real AES-256-GCM (never a mock hash).
//
// TWO BUSINESS RULES THIS FILE EXISTS TO ENFORCE, NEITHER OF WHICH THE
// AUTHZ MATRIX CAN EXPRESS ON ITS OWN (both flagged during an earlier
// review — carried forward
// as explicit this stage requirements, not silently dropped):
//   1. SELF-CERTIFICATION GUARD (decide()): a reviewer can never decide a
//      claim their OWN organization filed, regardless of which decider
//      role is calling — `can()` correctly grants claim.decide cross-org
//      (a coarse, correct action-level authority), but "not YOUR org's
//      claim specifically" is an instance-level rule this service checks
//      against a freshly-read row, the same category of check as the
//      isParticipant standing verification.
//   2. DISPUTE STANDING (fileDispute()): a challenger needs a real reason
//      to dispute a claim — either being the claim's own subjectOrg, or
//      holding a competing claim on the same (subjectOrgId,
//      opportunityId) pair — computed here from a real repository lookup
//      and passed as `context.isParticipant`, never trusted from client
//      input (ADR-0008/ADR-0010's isParticipant discipline).

import { can, type Actor } from "@tol/authz";
import { assertValidClaimTransition } from "@tol/domain";
import {
  claimDecisionRepository,
  claimDisputeRepository,
  claimEvidenceRepository,
  claimRepository,
  newClaimDecisionId,
  newClaimDisputeId,
  newClaimEvidenceId,
  newClaimId,
  opportunityRepository,
  organizationRepository,
  prisma,
  type Claim,
  type ClaimDecision,
  type ClaimDispute,
  type ClaimEvidence,
} from "@tol/db";
import { rankClaims, scoreClaim, type RankableClaim } from "@tol/attribution";
import type { ClaimDecisionOutcome, ClaimRankEntry, CreateClaimRequest, DecideClaimRequest, FileClaimDisputeRequest } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

/** Every role with a cross-org claim.read/list grant (packages/authz/src/matrix.ts) — everyone except the three claimant-side roles. */
const CROSS_ORG_CLAIM_READ_ROLES = new Set([
  "PLATFORM_OWNER",
  "MARKETPLACE_OPERATOR",
  "PARTNERSHIP_LEAD",
  "UNDERWRITING_ANALYST",
  "COMPLIANCE_REVIEWER",
  "FINANCE_OPERATOR",
  "AUDITOR_READONLY",
]);

/** the spec: "Provisional claims expire if the contributor cannot validate the relationship within a configurable window." Fixed literal this pass — no rule-config surface exists yet, same "fixed placeholder until real config exists" precedent as ADR-0004. */
const PROVISIONAL_WINDOW_DAYS = 30;

function decisionEventType(decision: ClaimDecisionOutcome): "claim.verified" | "claim.partial" | "claim.rejected" {
  if (decision === "VERIFIED") return "claim.verified";
  if (decision === "PARTIAL") return "claim.partial";
  return "claim.rejected";
}

function disputeResolutionFor(decision: ClaimDecisionOutcome): "UPHELD_ORIGINAL" | "PARTIAL_ATTRIBUTION" | "REJECTED_ORIGINAL" {
  if (decision === "VERIFIED") return "UPHELD_ORIGINAL";
  if (decision === "PARTIAL") return "PARTIAL_ATTRIBUTION";
  return "REJECTED_ORIGINAL";
}

/**
 * Real standing verification (ADR-0008/ADR-0010's isParticipant
 * discipline) — computed from actual repository lookups, never trusted
 * from client input. A challenger has standing when it either IS the
 * claim's own subjectOrg (the org whose relationship is being claimed
 * has an obvious, direct interest in who gets credit for it) or holds
 * its own competing Claim on the same (subjectOrgId, opportunityId)
 * pair.
 */
async function computeDisputeStanding(challengerOrgId: string, claim: Claim): Promise<boolean> {
  if (claim.subjectOrgId === challengerOrgId) return true;
  const competing = await claimRepository.listBySubject(prisma, claim.subjectOrgId, claim.opportunityId);
  return competing.some((c) => c.claimantOrgId === challengerOrgId && c.id !== claim.id);
}

export interface ClaimDetail {
  claim: Claim;
  evidence: ClaimEvidence[];
  decisions: ClaimDecision[];
  disputes: ClaimDispute[];
  /** null for claimant-side callers and whenever no ranking is possible — see getById's own comment. */
  rank: ClaimRankEntry | null;
}

export const claimsService = {
  async list(actor: Actor): Promise<Claim[]> {
    const decision = can(actor, "claim.list", { type: "claim", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (actor.role !== null && CROSS_ORG_CLAIM_READ_ROLES.has(actor.role)) {
      return claimRepository.list(prisma);
    }
    if (!actor.organizationId) return [];
    return claimRepository.listByClaimant(prisma, actor.organizationId);
  },

  /**
   * `rank` is populated ONLY for reviewer-tier callers (CROSS_ORG_CLAIM_
   * READ_ROLES) — a claimant-side actor reading its OWN claim never sees
   * a competing claim's rank/total, matching the spec's "cannot inspect
   * private competing records" as conservatively as this pass reasonably
   * can (see ADR-0010 for the full reasoning on why even a bare
   * rank number, not just evidence, stays reviewer-only).
   */
  async getById(actor: Actor, claimId: string): Promise<ClaimDetail> {
    const claim = await claimRepository.findById(prisma, claimId);
    if (!claim) throw ProblemError.notFound("Claim not found.");

    const decision = can(actor, "claim.read", { type: "claim", id: claim.id, ownerOrgId: claim.claimantOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const [evidence, decisions, disputes] = await Promise.all([
      claimEvidenceRepository.listByClaim(prisma, claimId),
      claimDecisionRepository.listByClaim(prisma, claimId),
      claimDisputeRepository.listByClaim(prisma, claimId),
    ]);

    let rank: ClaimRankEntry | null = null;
    const isReviewer = actor.role !== null && CROSS_ORG_CLAIM_READ_ROLES.has(actor.role);
    if (isReviewer) {
      const competing = await claimRepository.listBySubject(prisma, claim.subjectOrgId, claim.opportunityId);
      const rankable: RankableClaim[] = competing
        .filter((c): c is Claim & { scoreTotal: number } => c.scoreTotal !== null)
        .map((c) => ({ claimId: c.id, score: { total: c.scoreTotal }, submittedAt: c.createdAt.toISOString() }));
      if (rankable.length > 0) {
        const ranked = rankClaims(rankable);
        const mine = ranked.find((r) => r.claimId === claim.id);
        rank = mine ? { claimId: mine.claimId, rank: mine.rank, total: mine.total, tiedWith: [...mine.tiedWith] } : null;
      }
    }

    return { claim, evidence, decisions, disputes, rank };
  },

  /**
   * The ONLY action that creates a Claim row — files it (FILED) and
   * scores it (SCORED) atomically in one transaction, matching Lockbox's
   * "one API call, multiple individually-validated internal hops"
   * precedent (the release cascade). Real scoring via
   * @tol/attribution's scoreClaim(), never simulated.
   */
  async create(actor: Actor, input: CreateClaimRequest, context: RequestContext): Promise<Claim> {
    if (!actor.organizationId) throw ProblemError.forbidden("No active organization membership.");

    const decision = can(actor, "claim.create", { type: "claim", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const subjectOrg = await organizationRepository.findById(prisma, input.subjectOrgId);
    if (!subjectOrg) throw ProblemError.badRequest("subjectOrgId does not reference a real organization.");
    if (input.opportunityId) {
      const opportunity = await opportunityRepository.findById(prisma, input.opportunityId);
      if (!opportunity) throw ProblemError.badRequest("opportunityId does not reference a real opportunity.");
    }

    const claimId = newClaimId();
    const evidenceForScoring = input.evidenceItems.map((item) => ({
      evidenceType: item.evidenceType,
      verificationState: item.verificationState ?? ("SELF_REPORTED" as const),
    }));
    // Computed OUTSIDE the transaction — scoreClaim is pure and has zero
    // DB dependency (packages/attribution's own "zero-DB" discipline),
    // so there is nothing to gain by computing it inside; keeping it
    // outside makes the transaction body shorter and easier to reason
    // about.
    const breakdown = scoreClaim({
      priorCommercialHistoryMonths: input.priorCommercialHistoryMonths,
      directnessTier: input.directnessTier,
      evidenceItems: evidenceForScoring,
      submissionLagDays: input.submissionLagDays,
      inputVersions: [`claim-scoring-input:${claimId}:v1`],
    });

    return withTransaction(async (tx) => {
      const filed = await claimRepository.create(tx, {
        id: claimId,
        claimantOrgId: actor.organizationId!,
        claimantUserId: actor.userId,
        subjectOrgId: input.subjectOrgId,
        relationshipType: input.relationshipType,
        directnessTier: input.directnessTier,
        opportunityId: input.opportunityId ?? null,
        claimScope: input.claimScope ?? {},
        priorCommercialHistoryMonths: input.priorCommercialHistoryMonths,
        submissionLagDays: input.submissionLagDays,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });
      assertValidClaimTransition(filed.status, "SCORED");

      if (input.evidenceItems.length > 0) {
        await claimEvidenceRepository.createMany(
          tx,
          input.evidenceItems.map((item) => ({
            id: newClaimEvidenceId(),
            claimId,
            evidenceType: item.evidenceType,
            assertedFact: item.assertedFact,
            verificationState: item.verificationState ?? "SELF_REPORTED",
            evidenceRef: item.evidenceRef ?? null,
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          })),
        );
      }

      const scoredAt = new Date();
      const scored = await claimRepository.markScored(tx, claimId, {
        scoreBreakdown: breakdown as unknown as object,
        scoreTotal: breakdown.total,
        algorithmVersion: breakdown.algorithmVersion,
        inputVersions: breakdown.inputVersions,
        scoredAt,
        provisionalExpiresAt: new Date(scoredAt.getTime() + PROVISIONAL_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        updatedByUserId: actor.userId,
      });

      // SAFE-FIELD DISCIPLINE (same as the lockbox service): afterValue
      // below never carries evidence content or the full score breakdown —
      // just safe references. The full breakdown is readable via claim.read.
      const auditor = auditWriter(context);
      await auditor.write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: actor.organizationId,
        action: "claim.submitted",
        resourceType: "claim",
        resourceId: claimId,
        afterValue: {
          subjectOrgId: input.subjectOrgId,
          relationshipType: input.relationshipType,
          directnessTier: input.directnessTier,
          opportunityId: input.opportunityId ?? null,
          evidenceItemCount: input.evidenceItems.length,
        },
      });
      const timeline = timelineWriter(context);
      await timeline.write(tx, {
        eventType: "claim.submitted",
        aggregateType: "claim",
        aggregateId: claimId,
        payload: {
          claimantOrgId: actor.organizationId,
          subjectOrgId: input.subjectOrgId,
          relationshipType: input.relationshipType,
          directnessTier: input.directnessTier,
          opportunityId: input.opportunityId ?? null,
        },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });
      await auditor.write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: actor.organizationId,
        action: "claim.scored",
        resourceType: "claim",
        resourceId: claimId,
        afterValue: { scoreTotal: breakdown.total, algorithmVersion: breakdown.algorithmVersion },
      });
      await timeline.write(tx, {
        eventType: "claim.scored",
        aggregateType: "claim",
        aggregateId: claimId,
        payload: { scoreTotal: breakdown.total, algorithmVersion: breakdown.algorithmVersion },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return scored;
    });
  },

  /**
   * Files a dispute against a claim. Standing is verified BEFORE can()
   * is even called (computeDisputeStanding, a real repository lookup) —
   * see this file's header comment. A claimant can never dispute its own
   * claim (a service-layer business rule can() alone cannot express —
   * withdraw exists for that case instead).
   */
  async fileDispute(actor: Actor, claimId: string, input: FileClaimDisputeRequest, context: RequestContext): Promise<ClaimDispute> {
    if (!actor.organizationId) throw ProblemError.forbidden("No active organization membership.");

    const claim = await claimRepository.findById(prisma, claimId);
    if (!claim) throw ProblemError.notFound("Claim not found.");

    if (claim.claimantOrgId === actor.organizationId) {
      throw ProblemError.badRequest("Cannot dispute your own claim — withdraw it instead.");
    }

    const isParticipant = await computeDisputeStanding(actor.organizationId, claim);
    const decision = can(actor, "claim.dispute", { type: "claim", id: claim.id, ownerOrgId: claim.claimantOrgId }, { isParticipant });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // Fast, cheap pre-transaction rejection (same discipline as
    // rfqs/service.ts's selectQuote) — the AUTHORITATIVE check is the
    // re-read-inside-transaction below.
    //
    // ORDER IS LOAD-BEARING: the open-dispute check runs BEFORE the
    // transition assertion, not after. In this design a claim's status is
    // ALWAYS "DISPUTED" if and only if it has an open dispute (both are
    // set atomically in the same transaction, see below) — so once a
    // claim is already disputed, `assertValidClaimTransition(claim.status,
    // "DISPUTED")` would ALSO reject it (DISPUTED -> DISPUTED is not a
    // legal same-state transition), but with a generic 400
    // "invalid_state_transition" instead of this more specific, more
    // actionable 409 "already has an open dispute." Caught by this
    // block's own integration test (claims.test.ts) expecting 409 and
    // getting 400 before this reordering — fixed here, not by loosening
    // the test's expectation, since 409 is genuinely the more correct
    // status for "a real conflicting resource already exists."
    const existingOpen = await claimDisputeRepository.findOpenByClaim(prisma, claimId);
    if (existingOpen) throw ProblemError.conflict("This claim already has an open dispute.");
    assertValidClaimTransition(claim.status, "DISPUTED");

    const disputeId = newClaimDisputeId();

    return withTransaction(async (tx) => {
      // ADVISORY LOCK, keyed by the claim's own id — closes a genuine gap
      // the standard "re-read fresh inside the transaction" pattern alone
      // does NOT close (review, correctly caught this): under Postgres's default
      // READ COMMITTED isolation, two truly concurrent fileDispute() calls
      // for the SAME claim could each independently re-read "no open
      // dispute" (neither sees the other's still-uncommitted insert) and
      // both proceed to create a dispute row — a genuine TOCTOU race the
      // re-read pattern doesn't structurally prevent by itself, since
      // re-reading only helps once one side has actually COMMITTED.
      // pg_advisory_xact_lock serializes concurrent transactions on the
      // SAME claimId (hashed to a bigint key): the second transaction
      // blocks here until the first commits or rolls back, so its
      // subsequent findOpenByClaim below is guaranteed to see the first
      // transaction's result. Automatically released at transaction end
      // (commit or rollback) — no separate unlock call, no cleanup path
      // to forget. Scoped to `claim_id` alone (not claim+challenger),
      // so it also serializes against a concurrent decide() call
      // resolving the SAME claim's dispute at the same instant.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${claimId}))`;

      // Re-read fresh INSIDE the transaction (and now inside the lock) —
      // the established check-then-act race guard: a concurrent
      // dispute filing or decision could have changed the claim's status
      // between the pre-checks above and this transaction actually
      // starting. Same ordering rule as above: open-dispute check before
      // the transition assertion.
      const freshClaim = await claimRepository.findById(tx, claimId);
      if (!freshClaim) throw ProblemError.internal("Claim disappeared mid-transaction.");
      const freshOpen = await claimDisputeRepository.findOpenByClaim(tx, claimId);
      if (freshOpen) throw ProblemError.conflict("This claim already has an open dispute.");
      assertValidClaimTransition(freshClaim.status, "DISPUTED");

      const dispute = await claimDisputeRepository.create(tx, {
        id: disputeId,
        claimId,
        challengerOrgId: actor.organizationId!,
        challengerUserId: actor.userId,
        basis: input.basis,
        evidence: input.evidence ?? [],
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });
      await claimRepository.updateStatus(tx, claimId, "DISPUTED", actor.userId);

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: claim.claimantOrgId,
        action: "claim.disputed",
        resourceType: "claim",
        resourceId: claimId,
        reason: input.basis,
        afterValue: { challengerOrgId: actor.organizationId, disputeId },
      });
      await timelineWriter(context).write(tx, {
        eventType: "claim.disputed",
        aggregateType: "claim",
        aggregateId: claimId,
        payload: { challengerOrgId: actor.organizationId, basis: input.basis },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return dispute;
    });
  },

  /**
   * Records the reviewer's decision — resolves either a fresh SCORED
   * claim or the claim's current OPEN dispute, determined purely from
   * the claim's own current status (never client-supplied). Enforces the
   * self-certification guard (see this file's header comment) before
   * anything else.
   */
  async decide(actor: Actor, claimId: string, input: DecideClaimRequest, context: RequestContext): Promise<ClaimDecision> {
    const claim = await claimRepository.findById(prisma, claimId);
    if (!claim) throw ProblemError.notFound("Claim not found.");

    const decision = can(actor, "claim.decide", { type: "claim", id: claim.id, ownerOrgId: claim.claimantOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // SELF-CERTIFICATION GUARD — see this file's header comment.
    if (actor.organizationId !== null && actor.organizationId === claim.claimantOrgId) {
      throw ProblemError.forbidden("Cannot decide a claim your own organization filed — self-certification is never permitted.");
    }

    if (claim.status !== "SCORED" && claim.status !== "DISPUTED") {
      throw ProblemError.conflict(`Claim cannot be decided from its current status (${claim.status}); must be SCORED or DISPUTED.`);
    }
    assertValidClaimTransition(claim.status, input.decision);
    if (!claim.scoreBreakdown || !claim.algorithmVersion) {
      throw ProblemError.internal("Claim has no scoreBreakdown/algorithmVersion to snapshot — internal consistency error.");
    }

    return withTransaction(async (tx) => {
      // Same advisory-lock reasoning as fileDispute() above — without it,
      // two concurrent decide() calls on the same claim could each read a
      // stale pre-lock status (both SCORED), both pass their own
      // transition check, and both insert a ClaimDecision row — the
      // second UPDATE only blocks on Postgres's row lock AFTER the first
      // commits, by which point it's too late for Tx2's ALREADY-PASSED
      // transition check to reflect Tx1's outcome, since claimRepository.
      // updateStatus's UPDATE has no `WHERE status = ...` guard of its
      // own to re-fail against the new state. The lock forces full
      // serialization instead: Tx2 cannot even start its fresh read until
      // Tx1's transaction (lock included) has fully committed or rolled back.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${claimId}))`;

      const freshClaim = await claimRepository.findById(tx, claimId);
      if (!freshClaim) throw ProblemError.internal("Claim disappeared mid-transaction.");
      if (freshClaim.status !== "SCORED" && freshClaim.status !== "DISPUTED") {
        throw ProblemError.conflict(`Claim cannot be decided from its current status (${freshClaim.status}).`);
      }
      assertValidClaimTransition(freshClaim.status, input.decision);
      if (!freshClaim.scoreBreakdown || !freshClaim.algorithmVersion) {
        throw ProblemError.internal("Claim has no scoreBreakdown/algorithmVersion to snapshot.");
      }

      let freshOpenDispute: ClaimDispute | null = null;
      if (freshClaim.status === "DISPUTED") {
        freshOpenDispute = await claimDisputeRepository.findOpenByClaim(tx, claimId);
        if (!freshOpenDispute) throw ProblemError.internal("Claim is DISPUTED but has no open dispute row — internal consistency error.");
      }

      const decisionRow = await claimDecisionRepository.create(tx, {
        id: newClaimDecisionId(),
        claimId,
        disputeId: freshOpenDispute?.id ?? null,
        decision: input.decision,
        scoreBreakdown: freshClaim.scoreBreakdown as object,
        algorithmVersion: freshClaim.algorithmVersion!,
        reviewerUserId: actor.userId,
        reviewerOrgId: actor.organizationId!,
        reason: input.reason,
      });
      await claimRepository.updateStatus(tx, claimId, input.decision, actor.userId);

      if (freshOpenDispute) {
        const resolution = disputeResolutionFor(input.decision);
        await claimDisputeRepository.markDecided(tx, freshOpenDispute.id, { resolution, updatedByUserId: actor.userId });
        await auditWriter(context).write(tx, {
          actorUserId: actor.userId,
          actorOrgId: actor.organizationId,
          actorRole: actor.role,
          subjectOrgId: freshClaim.claimantOrgId,
          action: "claim.dispute_decided",
          resourceType: "claim_dispute",
          resourceId: freshOpenDispute.id,
          reason: input.reason,
          afterValue: { resolution, reviewerOrgId: actor.organizationId },
        });
        await timelineWriter(context).write(tx, {
          eventType: "claim.dispute_decided",
          aggregateType: "claim",
          aggregateId: claimId,
          payload: { disputeId: freshOpenDispute.id, resolution, reviewerOrgId: actor.organizationId! },
          actorUserId: actor.userId,
          actorOrgId: actor.organizationId,
          actorRole: actor.role,
        });
      }

      const eventType = decisionEventType(input.decision);
      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: freshClaim.claimantOrgId,
        action: eventType,
        resourceType: "claim",
        resourceId: claimId,
        reason: input.reason,
        afterValue: { decision: input.decision, reviewerOrgId: actor.organizationId },
      });
      await timelineWriter(context).write(tx, {
        eventType,
        aggregateType: "claim",
        aggregateId: claimId,
        payload: { reviewerOrgId: actor.organizationId!, reason: input.reason, disputeId: freshOpenDispute?.id ?? null },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return decisionRow;
    });
  },
};
