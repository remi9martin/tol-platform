// apps/worker/src/jobs/capacity-freshness.job.ts
//
// Automates P8 (Capacity) — deferred from earlier per ADR-0011 part
// 3, same additive framing as passport-readiness.job.ts: apps/capacity's
// own service (apps/api/src/modules/capacity/service.ts) ALWAYS
// recomputes freshness LIVE on every read via the real
// classifyCapacityFreshness() — that stays exactly as it was and remains
// the correctness source for any live viewer. The stored `freshnessClass`
// column is explicitly documented there as "only a write-time cache";
// this job's whole purpose is keeping that cache reasonably current for
// AT-SCALE filtering/listing use cases (D11: proactive reclassification
// of profiles nobody is actively viewing), never a replacement for the
// live-on-read value.
//
// the spec's own named idempotency key for this job: "profileId +
// asOfDate." Failure behavior per that same row: "Downgrade freshness;
// recompute affected matches" — the "recompute affected matches" half is
// P12's match-recompute.job.ts, named but not built this pass (see
// apps/worker/README.md's honest gap list) — this job owns the freshness
// downgrade itself only.
//
// CONCURRENCY: locks on the profile's own id (shared/lock.ts) before
// re-reading fresh, same pg_advisory_xact_lock pattern apps/api/src/
// modules/claims/service.ts already proves — without it, two concurrent
// invocations (two worker instances, or a worker racing an apps/api
// mutation) could both read the same pre-update freshnessClass and both
// "successfully" write, the second silently clobbering the first with a
// STALE decision. See shared/lock.ts's own header for the full reasoning.

import { prisma, capacityProfileRepository, domainEventRepository } from "@tol/db";
import { classifyCapacityFreshness } from "@tol/evidence";
import { withJobIdempotency } from "../shared/job-idempotency.js";
import { withTransaction } from "../shared/transaction.js";
import { lockAggregate } from "../shared/lock.js";
import type { JobHandler } from "./types.js";
import type { CapacityFreshnessJobData } from "@tol/queue";

// earlier-stage work: moved to @tol/queue — re-exported so existing import sites keep working.
export type { CapacityFreshnessJobData };

export interface CapacityFreshnessJobResult {
  scanned: number;
  reclassified: number;
}

/** Takes an id, not a pre-loaded CapacityProfile — the whole point of the lock is that any profile snapshot read BEFORE acquiring it might already be stale by the time this function actually runs; the only trustworthy read is the one taken AFTER the lock, inside the transaction. */
async function recomputeOne(profileId: string, now: Date, trigger: "event" | "sweep"): Promise<boolean> {
  return withTransaction(async (tx) => {
    await lockAggregate(tx, profileId);

    const fresh = await capacityProfileRepository.findById(tx, profileId);
    if (!fresh) return false; // deleted between the caller's own lookup and this lock — nothing left to do

    const newFreshnessClass = classifyCapacityFreshness({ asOf: fresh.asOf, sourceType: fresh.sourceType }, now);
    // Compare-before-write, now against the LOCKED, freshly-re-read row —
    // no longer just a sequential-duplicate fast path (as it was
    // pre-lock); this IS the actual concurrency guard now, since every
    // concurrent caller serializes through the lock above before reaching
    // this comparison.
    if (newFreshnessClass === fresh.freshnessClass) return false;

    await withJobIdempotency(
      tx,
      {
        scope: "worker.capacity-freshness",
        key: `${fresh.id}:${fresh.asOf.toISOString()}:${newFreshnessClass}`,
        requestPayload: { profileId: fresh.id, asOf: fresh.asOf.toISOString(), newFreshnessClass },
      },
      async () => {
        await capacityProfileRepository.updateFreshnessClass(tx, fresh.id, newFreshnessClass, null);
        await domainEventRepository.write(tx, {
          eventType: "capacity_profile.freshness_recomputed",
          aggregateType: "capacity_profile",
          aggregateId: fresh.id,
          payload: { providerOrgId: fresh.providerOrgId, previousFreshnessClass: fresh.freshnessClass, newFreshnessClass, trigger },
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
        });
        return { reclassified: true };
      },
    );
    return true;
  });
}

export const capacityFreshnessJob: JobHandler<CapacityFreshnessJobData, CapacityFreshnessJobResult> = async (job, ctx) => {
  const { profileId } = job.data;

  if (profileId) {
    const exists = await capacityProfileRepository.findById(prisma, profileId);
    if (!exists) {
      ctx.logger.warn({ profileId }, "capacity-freshness: profile not found, nothing to recompute (already deleted, or a stale enqueue)");
      return { scanned: 0, reclassified: 0 };
    }
    const changed = await recomputeOne(profileId, ctx.now, "event");
    return { scanned: 1, reclassified: changed ? 1 : 0 };
  }

  const profiles = await capacityProfileRepository.list(prisma, { limit: 500 });
  let reclassified = 0;
  for (const profile of profiles) {
    if (await recomputeOne(profile.id, ctx.now, "sweep")) reclassified++;
  }
  return { scanned: profiles.length, reclassified };
};
