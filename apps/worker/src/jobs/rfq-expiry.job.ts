// apps/worker/src/jobs/rfq-expiry.job.ts
//
// Automates the rfq-expiry job named (but never built) in P13's own
// the gate table owning-package tracking since earlier — `RFQ.status`
// has always had an `EXPIRED` value in @tol/domain's enum, but nothing
// transitioned a row into it until this job existed (the build log's own
// "what's explicitly NOT done" note, now closed).
//
// the spec's named row for this job: trigger "Scheduled," idempotency
// key "rfqId + dueAt," failure behavior "Transition once; notify
// parties." "Notify parties" is notification-dispatch.job.ts's job
// (named, not built this pass — see apps/worker/README.md's honest gap
// list); this job owns the transition-once half — the DomainEvent it
// writes (rfq.expired) IS the durable, queryable record a future
// notification-dispatch job would consume, same "one job's output is
// another job's input" shape the spec's own outbox-publish row
// describes.
//
// CONCURRENCY: locks on the RFQ's own id (shared/lock.ts) before
// re-reading its status fresh, same pg_advisory_xact_lock pattern
// apps/api/src/modules/claims/service.ts already proves — without it, two
// concurrent invocations (the scheduled sweep racing an event-triggered
// enqueue for the SAME rfqId, or two worker instances) could both read
// the same pre-transition status and both attempt the same transition;
// only one should ever "win" and the other should observe the result,
// not silently re-derive a second, possibly-diverging AuditEvent/
// DomainEvent pair for what is really one logical expiry.

import { prisma, rfqRepository, auditRepository, domainEventRepository } from "@tol/db";
import { assertValidRfqTransition, isRfqStatus, type RfqStatus } from "@tol/domain";
import { withJobIdempotency } from "../shared/job-idempotency.js";
import { withTransaction } from "../shared/transaction.js";
import { lockAggregate } from "../shared/lock.js";
import type { JobHandler } from "./types.js";
import type { RfqExpiryJobData } from "@tol/queue";

// earlier-stage work: moved to @tol/queue — re-exported so existing import sites keep working.
export type { RfqExpiryJobData };

export interface RfqExpiryJobResult {
  scanned: number;
  expired: number;
}

/** @tol/domain's RFQ_TRANSITIONS: SENT/ACKNOWLEDGED/QUESTIONS/QUOTED all have an edge to EXPIRED; DRAFT/EXPIRED/DECLINED/SELECTED don't (a DRAFT RFQ was never sent, so it can't be "overdue"; the other three are already terminal). Declared here as the job's own precondition check — assertValidRfqTransition is still called too, so a @tol/domain enum change can never silently desync from this list without a real error surfacing. */
const EXPIRABLE_STATUSES: ReadonlySet<RfqStatus> = new Set(["SENT", "ACKNOWLEDGED", "QUESTIONS", "QUOTED"]);

/** Takes an id, not a pre-loaded RFQ — the lock only protects a read taken AFTER it's acquired; any RFQ snapshot read beforehand (including the caller's own "is this overdue" check) may already be stale by the time the lock is granted. */
async function expireOne(rfqId: string, dueAtForKey: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    await lockAggregate(tx, rfqId);

    const fresh = await rfqRepository.findById(tx, rfqId);
    if (!fresh) return false; // deleted between the caller's own lookup and this lock
    if (!isRfqStatus(fresh.status) || !EXPIRABLE_STATUSES.has(fresh.status)) return false; // a concurrent actor already moved it somewhere terminal (or it was never expirable)

    const fromStatus = fresh.status;
    await withJobIdempotency(
      tx,
      {
        scope: "worker.rfq-expiry",
        // the spec's own named idempotency key, verbatim: "rfqId + dueAt".
        key: `${rfqId}:${dueAtForKey}`,
        requestPayload: { rfqId, dueAt: dueAtForKey, fromStatus },
      },
      async () => {
        assertValidRfqTransition(fromStatus, "EXPIRED");
        await rfqRepository.updateStatus(tx, rfqId, "EXPIRED", null);
        await auditRepository.write(tx, {
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
          subjectOrgId: null,
          action: "rfq.expired",
          resourceType: "rfq",
          resourceId: rfqId,
          afterValue: { from: fromStatus, dueAt: dueAtForKey },
        });
        await domainEventRepository.write(tx, {
          eventType: "rfq.expired",
          aggregateType: "rfq",
          aggregateId: rfqId,
          payload: { from: fromStatus, dueAt: dueAtForKey },
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
        });
        return { expired: true };
      },
    );
    return true;
  });
}

export const rfqExpiryJob: JobHandler<RfqExpiryJobData, RfqExpiryJobResult> = async (job, ctx) => {
  const { rfqId } = job.data;

  if (rfqId) {
    const rfq = await rfqRepository.findById(prisma, rfqId);
    if (!rfq) {
      ctx.logger.warn({ rfqId }, "rfq-expiry: RFQ not found, nothing to expire (already deleted, or a stale enqueue)");
      return { scanned: 0, expired: 0 };
    }
    if (rfq.dueAt.getTime() > ctx.now.getTime()) {
      // Not actually overdue (yet) — a real, non-error outcome: an
      // event-triggered enqueue racing slightly ahead of dueAt, or a
      // caller passing a specific rfqId speculatively. FAILURE RULE
      // (the spec): never silently pretend a transition happened.
      // Safe to check against this OUTER, pre-lock read — dueAt is
      // immutable once an RFQ is created (nothing in this codebase ever
      // updates it), so unlike `status` there is no race on its value.
      ctx.logger.info({ rfqId, dueAt: rfq.dueAt.toISOString(), now: ctx.now.toISOString() }, "rfq-expiry: not yet overdue, no-op");
      return { scanned: 1, expired: 0 };
    }
    const expired = await expireOne(rfqId, rfq.dueAt.toISOString());
    return { scanned: 1, expired: expired ? 1 : 0 };
  }

  const overdue = await rfqRepository.listOverdue(prisma, ctx.now, { limit: 500 });
  let expired = 0;
  for (const rfq of overdue) {
    if (await expireOne(rfq.id, rfq.dueAt.toISOString())) expired++;
  }
  return { scanned: overdue.length, expired };
};
