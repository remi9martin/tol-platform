// apps/worker/tests/integration/economics-accrual.job.test.ts
//
// Real Postgres, real @tol/domain computeCommissionSplits engine — money
// exactness proven by summing real persisted BigInt amountMinor values,
// never a hand-typed number. This is the job most directly answering
// P17 scenario #3 ("Worker crashes mid-job: job is retried safely;
// external mutation uses idempotency/reference check") against genuine
// money logic, per this job's own header comment.

import { afterAll, describe, expect, it } from "vitest";
import { disconnectPrisma, prisma, commissionAccrualRepository } from "@tol/db";
import { economicsAccrualJob } from "../../src/jobs/economics-accrual.job.js";
import { createActivatedDealRoomFixture, createActiveScheduleFixture, createRevenueEventFixture, createOrg } from "../fixtures.js";
import type { Job } from "bullmq";
import type { EconomicsAccrualJobData } from "../../src/jobs/economics-accrual.job.js";

function fakeJob(data: EconomicsAccrualJobData): Job<EconomicsAccrualJobData> {
  return { id: "test-job", name: "economics-accrual", data, attemptsMade: 0 } as unknown as Job<EconomicsAccrualJobData>;
}

const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} } as never, now: new Date() };

describe("economics-accrual.job", () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("reconciles a RevenueEvent that has NO accrual entries yet — the exact gap this job exists to close (a RevenueEvent committed by apps/api's synchronous path failing before ITS OWN accrual write) — real 80/20 split, zero leakage", async () => {
    const { provider, dealRoom } = await createActivatedDealRoomFixture();
    const platform = await createOrg("Platform", "PLATFORM");
    const { schedule } = await createActiveScheduleFixture(dealRoom, provider.id, platform.id);
    const revenueEvent = await createRevenueEventFixture(dealRoom, schedule, 10_000_00n); // $10,000.00

    const result = await economicsAccrualJob(fakeJob({ revenueEventId: revenueEvent.id }), ctx);

    expect(result.status).toBe("accrued");
    expect(result.entryCount).toBe(2);

    const entries = await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id);
    expect(entries).toHaveLength(2);

    // MONEY EXACTNESS — summed from real persisted BigInt values, never
    // asserted via the engine's own internal claim.
    const total = entries.reduce((sum, e) => sum + e.amountMinor, 0n);
    expect(total).toBe(10_000_00n);

    const providerEntry = entries.find((e) => e.recipientOrgId === provider.id);
    const platformEntry = entries.find((e) => e.recipientOrgId === platform.id);
    expect(providerEntry!.amountMinor).toBe(8_000_00n); // 80%
    expect(platformEntry!.amountMinor).toBe(2_000_00n); // 20%
    expect(providerEntry!.entryType).toBe("ACCRUAL");
    expect(providerEntry!.direction).toBe("CREDIT");
  });

  it("ALREADY ACCRUED: a RevenueEvent that already has entries (the normal case — apps/api's synchronous path already did it) is a clean no-op, never a double-credit (P17: exactly-once, not merely at-least-once)", async () => {
    const { provider, dealRoom } = await createActivatedDealRoomFixture();
    const platform = await createOrg("Platform", "PLATFORM");
    const { schedule, contributorComponentId } = await createActiveScheduleFixture(dealRoom, provider.id, platform.id);
    const revenueEvent = await createRevenueEventFixture(dealRoom, schedule, 5_000_00n);

    // Simulates "the synchronous apps/api path already accrued this" —
    // real repository call, real persisted ledger entries (against the
    // REAL component id the schedule fixture created — CommissionAccrual.
    // componentId is a real FK, a fabricated id 400s at the DB layer, not
    // a fixture detail worth faking), exactly what recordRevenueEvent
    // itself would have done.
    await commissionAccrualRepository.createMany(prisma, [
      {
        entryType: "ACCRUAL",
        direction: "CREDIT",
        amountMinor: 4_000_00n,
        currency: "USD",
        dealRoomId: dealRoom.id,
        revenueEventId: revenueEvent.id,
        scheduleId: schedule.id,
        scheduleVersion: schedule.versionNumber,
        componentId: contributorComponentId,
        recipientOrgId: provider.id,
        calculationVersion: "test-v1",
        inputVersions: ["test:v1"],
        computedAt: new Date(),
      },
    ]);

    const result = await economicsAccrualJob(fakeJob({ revenueEventId: revenueEvent.id }), ctx);

    expect(result).toEqual({ status: "already_accrued", entryCount: 1 });
    const entries = await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id);
    expect(entries).toHaveLength(1); // still exactly 1 — the job did NOT add a second, competing accrual
  });

  it("DUPLICATE / WORKER-CRASH-MID-JOB simulation: running the job 3 times concurrently on a fresh RevenueEvent produces EXACTLY ONE set of ledger entries, not three (P17 scenario #3, against real money)", async () => {
    const { provider, dealRoom } = await createActivatedDealRoomFixture();
    const platform = await createOrg("Platform", "PLATFORM");
    const { schedule } = await createActiveScheduleFixture(dealRoom, provider.id, platform.id);
    const revenueEvent = await createRevenueEventFixture(dealRoom, schedule, 1_000_00n);

    // Genuine concurrency — 3 "attempts" (as if 3 retries/duplicate
    // deliveries raced) processing the SAME revenueEventId at once.
    const results = await Promise.all([
      economicsAccrualJob(fakeJob({ revenueEventId: revenueEvent.id }), ctx),
      economicsAccrualJob(fakeJob({ revenueEventId: revenueEvent.id }), ctx),
      economicsAccrualJob(fakeJob({ revenueEventId: revenueEvent.id }), ctx),
    ]);

    const entries = await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id);
    expect(entries).toHaveLength(2); // one ACCRUAL row per component (provider + platform) — never 6 (2 x 3 racers)
    const total = entries.reduce((sum, e) => sum + e.amountMinor, 0n);
    expect(total).toBe(1_000_00n); // exact — no leakage, no double-credit from the race

    // At least one of the 3 concurrent attempts genuinely computed it
    // fresh; the rest either saw it already-existing (via the
    // listByRevenueEvent guard) or lost the idempotency-table race and
    // fell through gracefully (withJobIdempotency's own P2002 catch) —
    // either way, every attempt's OWN return value reports a real,
    // non-throwing outcome.
    expect(results.every((r) => r.status === "accrued" || r.status === "already_accrued")).toBe(true);
  });

  it("skips (not silently accrues) when the schedule that was ACTIVE at RevenueEvent-record-time has since been SUPERSEDED — FAILURE RULE: exposes the degraded condition rather than guessing", async () => {
    const { provider, dealRoom } = await createActivatedDealRoomFixture();
    const platform = await createOrg("Platform", "PLATFORM");
    const { schedule } = await createActiveScheduleFixture(dealRoom, provider.id, platform.id);
    const revenueEvent = await createRevenueEventFixture(dealRoom, schedule, 1_000_00n);

    await prisma.commissionSchedule.update({ where: { id: schedule.id }, data: { status: "SUPERSEDED" } });

    const result = await economicsAccrualJob(fakeJob({ revenueEventId: revenueEvent.id }), ctx);

    expect(result).toEqual({ status: "skipped_no_active_schedule", entryCount: 0 });
    const entries = await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id);
    expect(entries).toHaveLength(0);
  });

  it("a missing revenueEventId is a clean no-op, never a thrown error", async () => {
    const result = await economicsAccrualJob(fakeJob({ revenueEventId: "00000000-0000-7000-8000-00000000dead" }), ctx);
    expect(result).toEqual({ status: "skipped_no_active_schedule", entryCount: 0 });
  });
});
