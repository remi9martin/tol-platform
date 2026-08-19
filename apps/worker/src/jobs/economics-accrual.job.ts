// apps/worker/src/jobs/economics-accrual.job.ts
//
// P15 activation -> accrual. IMPORTANT, deliberate design note (also in
// ADR-0014 part 4): apps/api's economics service
// (recordRevenueEvent, apps/api/src/modules/economics/service.ts)
// ALREADY computes and persists CommissionAccrual ledger entries
// SYNCHRONOUSLY, inside the same HTTP request/transaction that records a
// RevenueEvent — that path is earlier work, DONE, live-verified, and this
// job does NOT replace or duplicate it. "Activation -> accrual" describes
// the CAUSAL CHAIN this job sits at the end of: a DealRoom reaching
// ACTIVATION is what makes recording a RevenueEvent possible at all
// (ECONOMICS_ELIGIBLE_DEAL_STATUSES), and recording a RevenueEvent is
// what actually triggers accrual — there is no "activation" event with
// money attached before a RevenueEvent exists.
//
// What this job actually adds, on top of the synchronous path (this stage
// enqueues it RIGHT ALONGSIDE, not instead of, the synchronous
// computation, immediately after a RevenueEvent commits): a DURABLE,
// RETRIABLE, IDEMPOTENT confirmation/reconciliation pass over the same
// revenueEventId. Its own idempotency check — "does this revenueEventId
// already have ACCRUAL ledger entries?" via
// commissionAccrualRepository.listByRevenueEvent — makes it PROVABLY safe
// to enqueue redundantly or retry after a crash: if the synchronous path
// already accrued it (the overwhelmingly common case), this job is a
// cheap read and a no-op; if the synchronous path somehow committed the
// RevenueEvent but failed before completing its own accrual write (a
// narrow but real failure window this job exists specifically to close),
// this job computes and persists it. This is the exact "worker crashes
// mid-job: job is retried safely; external mutation uses
// idempotency/reference check" scenario (the spec, scenario #3) proven
// against REAL money logic, not a toy example.
//
// CONCURRENCY: locks on revenueEventId (shared/lock.ts) BEFORE the
// "already accrued" check and BEFORE reading the schedule/components,
// same pg_advisory_xact_lock pattern apps/api/src/modules/claims/
// service.ts already proves. This is the single highest-stakes place in
// this entire day's work for that pattern: without the lock, N concurrent
// attempts at the SAME revenueEventId (duplicate delivery, a crash-retry
// racing the original attempt, or two worker instances) could each
// independently read "zero existing entries," each pass the check, and
// each proceed to computeCommissionSplits + createMany — a genuine
// DOUBLE-CREDIT of real money, not a cosmetic duplicate row. The lock
// serializes every such attempt on this exact revenueEventId; only the
// first to acquire it ever reaches a state where `existingEntries` is
// still empty, every later one (whether concurrent or a later retry)
// re-reads AFTER that first one's commit and correctly observes
// "already_accrued."

import {
  prisma,
  dealRoomRepository,
  revenueEventRepository,
  commissionScheduleRepository,
  commissionComponentRepository,
  commissionAccrualRepository,
  auditRepository,
  domainEventRepository,
} from "@tol/db";
import { computeCommissionSplits, selectComponentsForBasis, EconomicsInvariantError, type CommissionBasis, type EconomicsComponentInput } from "@tol/domain";
import { withJobIdempotency } from "../shared/job-idempotency.js";
import { withTransaction } from "../shared/transaction.js";
import { lockAggregate } from "../shared/lock.js";
import type { JobHandler } from "./types.js";
import type { EconomicsAccrualJobData } from "@tol/queue";

// earlier-stage work: moved to @tol/queue — re-exported so existing import sites keep working.
export type { EconomicsAccrualJobData };

export interface EconomicsAccrualJobResult {
  status: "already_accrued" | "accrued" | "skipped_no_active_schedule";
  entryCount: number;
}

export const economicsAccrualJob: JobHandler<EconomicsAccrualJobData, EconomicsAccrualJobResult> = async (job, ctx) => {
  const { revenueEventId } = job.data;

  const exists = await revenueEventRepository.findById(prisma, revenueEventId);
  if (!exists) {
    ctx.logger.warn({ revenueEventId }, "economics-accrual: RevenueEvent not found — nothing to reconcile (already deleted, or a stale enqueue)");
    return { status: "skipped_no_active_schedule", entryCount: 0 };
  }

  return withTransaction(async (tx) => {
    await lockAggregate(tx, revenueEventId);

    // Every read below happens AFTER the lock, INSIDE the same
    // transaction — this is the trustworthy read; the outer existence
    // check above is only for the friendlier early-warning log message.
    const revenueEvent = await revenueEventRepository.findById(tx, revenueEventId);
    if (!revenueEvent) {
      return { status: "skipped_no_active_schedule" as const, entryCount: 0 };
    }

    // THE idempotency/reference check this job's whole design rests on —
    // real, direct, against the actual ledger table, now genuinely
    // race-safe because it runs after acquiring the lock above. Every
    // concurrent/retried attempt serializes through this exact check.
    const existingEntries = await commissionAccrualRepository.listByRevenueEvent(tx, revenueEventId);
    if (existingEntries.length > 0) {
      ctx.logger.info({ revenueEventId, entryCount: existingEntries.length }, "economics-accrual: already accrued (by the synchronous apps/api path, or a prior run of this job) — no-op");
      return { status: "already_accrued" as const, entryCount: existingEntries.length };
    }

    const dealRoom = await dealRoomRepository.findById(tx, revenueEvent.dealRoomId);
    if (!dealRoom) {
      throw new Error(`economics-accrual: RevenueEvent ${revenueEventId} references DealRoom ${revenueEvent.dealRoomId}, which does not exist — data integrity issue, not a retryable transient failure`);
    }

    const schedule = await commissionScheduleRepository.findById(tx, revenueEvent.scheduleId);
    if (!schedule || schedule.status !== "ACTIVE") {
      // Real, non-error outcome: the schedule that was ACTIVE when the
      // RevenueEvent was recorded has since been superseded. Accruing
      // against a no-longer-active schedule would be wrong; this is a named
      // gap for a human to resolve (a superseded-schedule reconciliation
      // policy), not something this job silently guesses at. FAILURE RULE
      // (the spec): expose the degraded condition, never a false green.
      ctx.logger.warn({ revenueEventId, scheduleId: revenueEvent.scheduleId, scheduleStatus: schedule?.status ?? "not_found" }, "economics-accrual: schedule is not ACTIVE — skipping, needs human reconciliation");
      return { status: "skipped_no_active_schedule" as const, entryCount: 0 };
    }

    return withJobIdempotency(
      tx,
      {
        scope: "worker.economics-accrual",
        key: revenueEventId,
        requestPayload: { revenueEventId, scheduleId: schedule.id, scheduleVersion: schedule.versionNumber },
      },
      async () => {
        const allComponents = await commissionComponentRepository.listBySchedule(tx, schedule.id);
        const componentInputs: EconomicsComponentInput[] = allComponents.map((c) => ({
          componentId: c.id,
          recipientOrgId: c.recipientOrgId,
          componentType: c.componentType,
          bps: c.bps,
          fixedAmountMinor: c.fixedAmountMinor,
          claimId: c.claimId,
          priority: c.priority,
        }));
        const basisOverrideMap = new Map(allComponents.map((c) => [c.id, c.calculationBasis as CommissionBasis | null]));
        const targetedComponents = selectComponentsForBasis(componentInputs, schedule.basis, revenueEvent.basis, basisOverrideMap);
        if (targetedComponents.length === 0) {
          throw new Error(`economics-accrual: schedule ${schedule.id} has zero components covering basis "${revenueEvent.basis}" — same misconfiguration apps/api's synchronous path would also reject; this RevenueEvent was recorded against a schedule that cannot actually split it`);
        }

        let split: ReturnType<typeof computeCommissionSplits>;
        try {
          split = computeCommissionSplits({
            netDistributableMinor: revenueEvent.netDistributableMinor,
            components: targetedComponents,
            scheduleId: schedule.id,
            scheduleVersion: schedule.versionNumber,
            now: revenueEvent.recognizedAt,
          });
        } catch (err) {
          if (err instanceof EconomicsInvariantError) {
            throw new Error(`economics-accrual: cannot compute the commission split for RevenueEvent ${revenueEventId}: ${err.message}`);
          }
          throw err;
        }

        const ledgerEntries = await commissionAccrualRepository.createMany(
          tx,
          split.entries.map((e) => ({
            entryType: "ACCRUAL" as const,
            direction: e.direction,
            amountMinor: e.amountMinor,
            currency: revenueEvent.currency,
            dealRoomId: revenueEvent.dealRoomId,
            revenueEventId: revenueEvent.id,
            scheduleId: schedule.id,
            scheduleVersion: schedule.versionNumber,
            componentId: e.componentId,
            recipientOrgId: e.recipientOrgId,
            claimId: e.claimId,
            calculationVersion: split.calculationVersion,
            inputVersions: split.inputVersions,
            computedAt: revenueEvent.recognizedAt,
            privacyClass: "RESTRICTED" as const,
            createdByUserId: null,
            createdByOrgId: null,
          })),
        );

        await auditRepository.write(tx, {
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
          subjectOrgId: dealRoom.merchantOrgId,
          action: "commission.accrued",
          resourceType: "revenue_event",
          resourceId: revenueEvent.id,
          afterValue: {
            dealRoomId: revenueEvent.dealRoomId,
            netDistributableMinor: revenueEvent.netDistributableMinor.toString(),
            entryCount: ledgerEntries.length,
            calculationVersion: split.calculationVersion,
            trigger: "worker_reconciliation",
          },
        });
        await domainEventRepository.write(tx, {
          eventType: "commission.accrued",
          aggregateType: "deal_room",
          aggregateId: revenueEvent.dealRoomId,
          payload: {
            revenueEventId: revenueEvent.id,
            scheduleId: schedule.id,
            netDistributableMinor: revenueEvent.netDistributableMinor.toString(),
            entryCount: ledgerEntries.length,
          },
          actorUserId: null,
          actorOrgId: null,
          actorRole: null,
        });

        return { status: "accrued" as const, entryCount: ledgerEntries.length };
      },
    );
  });
};
