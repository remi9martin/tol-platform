// apps/worker/src/jobs/passport-readiness.job.ts
//
// Automates P6 (Passport) — deferred from earlier per ADR-0011 part
// 3's own stated boundary: apps/api's on-read computation
// (loadDetailWithStalenessCheck, passport/service.ts) stays exactly as it
// was and remains the source of correctness for any live viewer; this
// job is ADDITIVE — proactive reclassification of Passports nobody is
// currently reading, on a schedule, plus an event-triggered immediate
// recompute when apps/api enqueues one on a real fact/evidence change
// (this stage).
//
// Mirrors apps/api/src/modules/passport/service.ts's own
// recomputeReadinessAndStatus function EXACTLY in shape (same engine
// calls, same persisted ReadinessResult shape, same status-decision rule)
// — the status decision itself (@tol/domain's targetStatusAfterRecompute)
// was moved to a shared location this same day specifically so this job
// and apps/api's service can never silently disagree about what status a
// given readiness result implies (see that function's own header
// comment). Everything else (snapshot-building, audit/event writing)
// stays independently written here because the ORCHESTRATION shape
// genuinely differs — apps/api has a RequestContext/Actor and an HTTP
// caller; this job has neither and writes audit/timeline events directly
// via @tol/db's repositories rather than apps/api's request-scoped
// auditWriter/timelineWriter wrappers.
//
// CONCURRENCY: locks on the passport's own id (shared/lock.ts) before
// re-reading its status AND facts fresh, same pg_advisory_xact_lock
// pattern apps/api/src/modules/claims/service.ts already proves —
// without it, two concurrent invocations (a sweep and an event-triggered
// enqueue for the SAME passportId, landing at nearly the same instant)
// could each read the same pre-mutation status/facts, both compute a
// (possibly different, if one read stale evidence expiry) target status,
// and both write — the second silently clobbering the first's transition
// with no error, exactly the "silent double-process" class of bug P17
// exists to rule out.

import { prisma, passportRepository, factRepository, evidenceRepository, readinessResultRepository, auditRepository, domainEventRepository } from "@tol/db";
import { computeReadiness, isReadinessBlocked, classifyFactFreshness, type FactSnapshot } from "@tol/evidence";
import { assertValidPassportTransition, isPassportReadinessStale, targetStatusAfterRecompute, type PassportStatus } from "@tol/domain";
import { withJobIdempotency } from "../shared/job-idempotency.js";
import { withTransaction } from "../shared/transaction.js";
import { lockAggregate } from "../shared/lock.js";
import type { JobHandler } from "./types.js";
import type { PassportReadinessJobData } from "@tol/queue";

// earlier-stage work: PassportReadinessJobData now lives in @tol/queue (the
// shared apps/api<->apps/worker contract) — re-exported here so every
// existing import site in this app keeps working unchanged.
export type { PassportReadinessJobData };

export interface PassportReadinessJobResult {
  scanned: number;
  recomputed: number;
}

/** Matches apps/api/src/modules/passport/service.ts's own constant exactly — see that file's comment for the sourcing (documented inference from @tol/evidence's capacityFreshnessWindowDays.aging). Duplicated as a literal, not imported, since it's apps/api's own service-layer policy choice, not a shared domain constant — same category distinction as the status-decision function that WAS shared (a business RULE both callers must agree on) vs. a tunable POLICY NUMBER either caller could reasonably set independently. */
const READINESS_STALE_AFTER_DAYS = 90;

function buildSnapshots(
  facts: Awaited<ReturnType<typeof factRepository.listByPassport>>,
  evidenceById: ReadonlyMap<string, Awaited<ReturnType<typeof evidenceRepository.findById>>>,
): FactSnapshot[] {
  return facts.map((f) => {
    const evidence = f.evidenceId ? (evidenceById.get(f.evidenceId) ?? null) : null;
    return {
      fieldKey: f.fieldKey,
      sectionType: f.sectionType,
      hasValue: f.normalizedValue !== null,
      verification: f.verification,
      expiresAt: evidence?.expiresAt ?? null,
      updatedAt: f.updatedAt,
    };
  });
}

/** Takes an id, not a pre-loaded Passport — the lock only protects a read taken AFTER it's acquired; any Passport/Fact snapshot read beforehand may already be stale by the time the lock is granted. */
async function recomputePassport(passportId: string, now: Date): Promise<void> {
  await withTransaction(async (tx) => {
    await lockAggregate(tx, passportId);

    const passport = await passportRepository.findById(tx, passportId);
    if (!passport) return; // deleted between the caller's own lookup and this lock

    const facts = await factRepository.listByPassport(tx, passport.id);
    const evidenceEntries = await Promise.all(
      facts
        .filter((f): f is typeof f & { evidenceId: string } => f.evidenceId !== null)
        .map(async (f) => [f.evidenceId, await evidenceRepository.findById(tx, f.evidenceId)] as const),
    );
    const evidenceById = new Map(evidenceEntries);
    const snapshots = buildSnapshots(facts, evidenceById);
    // review (review) correctly
    // caught a real gap: a bare `fact:id:version` string never changes
    // just because WALL-CLOCK TIME passed — but computeReadiness's own
    // result DOES change purely from time passing (an unchanged Fact's
    // linked Evidence can decay from FRESH -> AGING -> STALE with zero
    // row-level mutation). Without the freshness class baked in here, a
    // sweep-triggered recompute of a passport whose facts/status are
    // unchanged but whose evidence has since expired would get silently
    // short-circuited by withJobIdempotency's cache — replaying a NOW-
    // STALE cached readiness result instead of computing the correct,
    // newly-degraded one. Including each fact's CURRENT freshness class
    // (as of THIS `now`) makes a freshness transition its own distinct
    // logical operation, exactly like a status change already was (see
    // this file's own comment on why status was added to the key) — and
    // is a genuinely more accurate provenance record for
    // ReadinessResult.inputVersions either way, not just a workaround.
    const inputVersions = facts.map((f) => {
      const evidence = f.evidenceId ? (evidenceById.get(f.evidenceId) ?? null) : null;
      const freshness = classifyFactFreshness({ expiresAt: evidence?.expiresAt ?? null }, now);
      return `fact:${f.id}:v${f.version}:${freshness}`;
    });

    await withJobIdempotency(
      tx,
      {
        scope: "worker.passport-readiness",
        // Deterministic on the exact (fact/version set, CURRENT status) pair
        // this recompute is against — a genuine duplicate (same passport,
        // same status, same underlying facts unchanged) replays the cached
        // result instead of appending a redundant ReadinessResult row. The
        // status component is load-bearing, not decorative — a real bug
        // this job's own this stage integration test caught: WITHOUT it, a
        // passport forced to STALE by an external actor (e.g. apps/api's
        // own on-read staleness check) with its facts otherwise unchanged
        // would hash to the SAME key as its prior recompute and get
        // silently short-circuited by the cache — never re-evaluated, never
        // given the chance targetStatusAfterRecompute("STALE", ...)
        // provides to transition back to READY. Including status makes a
        // status change its own distinct logical operation, exactly like a
        // fact change already was.
        key: `${passport.id}:${passport.status}:${inputVersions.join(",") || "no-facts"}`,
        requestPayload: { passportId: passport.id, status: passport.status, inputVersions },
      },
      async () => {
        const result = computeReadiness(snapshots, now, inputVersions);
        const blocked = isReadinessBlocked(result);

        await readinessResultRepository.create(tx, {
          passportId: passport.id,
          score: result.score,
          blockers: result.blockers as unknown as Record<string, unknown>[],
          warnings: result.warnings as unknown as Record<string, unknown>[],
          ruleVersion: result.ruleVersion,
          algorithmVersion: result.algorithmVersion,
          inputVersions: result.inputVersions,
          computedAt: now,
          createdByUserId: null,
          createdByOrgId: null,
          sourceType: "SYSTEM",
        });

        await auditRepository.write(tx, {
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
          subjectOrgId: passport.organizationId,
          action: "passport.readiness_computed",
          resourceType: "passport",
          resourceId: passport.id,
          afterValue: { score: result.score, blockerCount: result.blockers.length, warningCount: result.warnings.length, trigger: "worker" },
        });
        await domainEventRepository.write(tx, {
          eventType: "passport.readiness_computed",
          aggregateType: "passport",
          aggregateId: passport.id,
          payload: { score: result.score, blockerCount: result.blockers.length, warningCount: result.warnings.length, algorithmVersion: result.algorithmVersion },
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
        });

        const targetStatus = targetStatusAfterRecompute(passport.status, facts.length > 0, blocked);
        if (targetStatus !== passport.status) {
          assertValidPassportTransition(passport.status, targetStatus);
          await passportRepository.updateStatus(tx, passport.id, targetStatus, null);
          await domainEventRepository.write(tx, {
            eventType: "passport.status_changed",
            aggregateType: "passport",
            aggregateId: passport.id,
            payload: { from: passport.status, to: targetStatus },
            actorUserId: null,
            actorOrgId: null,
            actorRole: null,
          });
        }

        return { recomputed: true };
      },
    );
  });
}

/**
 * STALE is deliberately NOT covered by @tol/domain's own
 * isPassportReadinessStale (that function's precondition is "currently
 * READY or VERIFIED" — a passport ALREADY at STALE needs a fresh compute
 * to possibly LEAVE that status, which is exactly what the sweep should
 * give it a chance to do). A DRAFT/INCOMPLETE passport with an aging
 * ReadinessResult isn't "stale" in the the spec sense — it's just still
 * incomplete — so it's excluded here unless it has NO ReadinessResult at
 * all yet (the `!latest` branch), matching isPassportReadinessStale's own
 * documented precondition exactly.
 */
function needsSweepRecompute(status: PassportStatus, latest: { computedAt: Date } | null, now: Date): boolean {
  if (!latest) return true;
  if (status === "STALE") return true;
  return isPassportReadinessStale(status, latest.computedAt, now, READINESS_STALE_AFTER_DAYS);
}

export const passportReadinessJob: JobHandler<PassportReadinessJobData, PassportReadinessJobResult> = async (job, ctx) => {
  const { passportId } = job.data;

  if (passportId) {
    const exists = await passportRepository.findById(prisma, passportId);
    if (!exists) {
      ctx.logger.warn({ passportId }, "passport-readiness: passport not found, nothing to recompute (already deleted, or a stale enqueue)");
      return { scanned: 0, recomputed: 0 };
    }
    await recomputePassport(passportId, ctx.now);
    return { scanned: 1, recomputed: 1 };
  }

  // Sweep mode — bounded to 500 per pass (same limit passportRepository.list
  // already defaults to elsewhere in this codebase); a genuinely larger
  // backlog than that is a scale concern for a later day, not silently
  // hidden here.
  const passports = await passportRepository.list(prisma, { limit: 500 });
  let recomputed = 0;
  for (const passport of passports) {
    const latest = await readinessResultRepository.findLatestByPassport(prisma, passport.id);
    if (needsSweepRecompute(passport.status, latest, ctx.now)) {
      await recomputePassport(passport.id, ctx.now);
      recomputed++;
    }
  }
  return { scanned: passports.length, recomputed };
};
