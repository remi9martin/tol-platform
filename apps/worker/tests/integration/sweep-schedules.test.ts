// apps/worker/tests/integration/sweep-schedules.test.ts
//
// earlier-stage work (identified gap, review earlier-stage work/5
// entries): proves the sweep schedules are actually REGISTERED and
// REACHABLE as real BullMQ Job Schedulers — not merely that each job
// handler's own no-id "scan everything" branch works in isolation
// (already proven per-job in passport-readiness/capacity-freshness/
// rfq-expiry's own integration tests since this stage). Queries the real
// BullMQ Job Scheduler API (queue.getJobSchedulers()) against a real
// Redis, the only way to actually confirm a schedule exists rather than
// assume registerSweepSchedules() ran correctly.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createRedisConnection } from "../../src/redis.js";
import { getQueue, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerSweepSchedules, SWEEP_SCHEDULES } from "../../src/sweeps.js";

const TEST_QUEUE_NAME = `tol-worker-test-sweeps-${randomUUID()}`;

describe("Sweep schedules — the reconciliation backstop for a dropped enqueue, registered as real BullMQ Job Schedulers", () => {
  let connection: Redis | undefined;

  afterEach(async () => {
    await closeQueue(TEST_QUEUE_NAME);
    resetQueueForTests();
    if (connection) {
      await connection.quit();
      connection = undefined;
    }
  });

  it("registers all three sweep-capable job types as real, independently-queryable Job Schedulers, each with a concrete upcoming run", async () => {
    connection = createRedisConnection();
    const queue = getQueue(connection, TEST_QUEUE_NAME);

    await registerSweepSchedules(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(SWEEP_SCHEDULES.length);

    for (const { schedulerId, jobName, everyMs } of SWEEP_SCHEDULES) {
      // BullMQ's own JobSchedulerJson.id field is not what upsertJobScheduler's
      // first argument populates in practice (confirmed by direct inspection
      // against a real Redis, not assumed from the .d.ts alone) — the real
      // identifier is `.key`.
      const found = schedulers.find((s) => s.key === schedulerId);
      expect(found, `scheduler "${schedulerId}" was not registered`).toBeDefined();
      expect(found?.name).toBe(jobName);
      expect(found?.every).toBe(everyMs);
      // A concrete, real UPCOMING run must exist for each scheduler — not
      // just registration metadata — proving BullMQ genuinely intends to
      // dispatch this job, not merely recorded a schedule that goes
      // nowhere. Allows a small clock-skew margin either side of "now."
      expect(found?.next).toBeGreaterThan(Date.now() - 5_000);
      expect(found?.next).toBeLessThanOrEqual(Date.now() + everyMs + 5_000);
    }
  });

  it("re-registering (exactly what happens on every worker restart) is idempotent — no duplicate schedulers", async () => {
    connection = createRedisConnection();
    const queue = getQueue(connection, TEST_QUEUE_NAME);

    await registerSweepSchedules(queue);
    const firstCount = await queue.getJobSchedulersCount();
    expect(firstCount).toBe(SWEEP_SCHEDULES.length);

    await registerSweepSchedules(queue);
    await registerSweepSchedules(queue);
    const afterRepeatedCalls = await queue.getJobSchedulersCount();

    expect(afterRepeatedCalls).toBe(SWEEP_SCHEDULES.length);
  });

  it("economics-accrual deliberately has NO sweep schedule — the spec names its trigger as always specific to one revenueEventId, never bulk-swept (see EconomicsAccrualJobData's own comment)", async () => {
    connection = createRedisConnection();
    const queue = getQueue(connection, TEST_QUEUE_NAME);

    await registerSweepSchedules(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.some((s) => s.name === "economics-accrual")).toBe(false);
  });
});
