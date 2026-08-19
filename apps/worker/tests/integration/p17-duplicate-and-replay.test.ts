// apps/worker/tests/integration/p17-duplicate-and-replay.test.ts
//
// P17 gate — the spec scenario #2: "Webhook delivered twice: persisted
// event ID dedupes processing" + the REPLAY leg of the P17 exit
// condition's own summary phrase ("Duplicate/timeout/outage/replay
// tests," the spec). Both proven here through the REAL queue: jobs are
// enqueued via the actual BullMQ Queue and processed by a REAL Worker
// against real Postgres — not a direct function call bypassing the
// queue, unlike this day's this stage job tests (which correctly proved
// each job's OWN idempotency logic in isolation; this file proves the
// SAME property survives the full, real enqueue -> dispatch -> process
// pipeline, end to end).
//
// economics-accrual is the chosen job for this proof deliberately — it's
// this day's highest-stakes job (real money), so "duplicate processing
// is safe" here means something concrete and falsifiable (an exact
// BigInt sum), not just "no error was thrown."

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { prisma, commissionAccrualRepository } from "@tol/db";
import { createRedisConnection } from "../../src/redis.js";
import { enqueueJob, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerAllJobs, resetAllJobsForTests } from "../../src/jobs/index.js";
import { createWorkerRuntime } from "../../src/worker-runtime.js";
import { createActivatedDealRoomFixture, createActiveScheduleFixture, createRevenueEventFixture, createOrg } from "../fixtures.js";

const TEST_QUEUE_NAME = `tol-worker-test-p17-dup-${randomUUID()}`;

/** Waits for the queue to drain (every job this test enqueued has either completed or failed) by polling BullMQ's own counts — real queue state, not a fixed sleep. */
async function waitForQueueIdle(worker: Worker, expectedSettled: number, timeoutMs = 10_000): Promise<void> {
  const settled: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const onSettle = (jobId: string) => {
      settled.push(jobId);
      if (settled.length >= expectedSettled) {
        worker.off("completed", onCompleted);
        worker.off("failed", onFailed);
        resolve();
      }
    };
    const onCompleted = (job: { id?: string }) => onSettle(job.id ?? "");
    const onFailed = (job: { id?: string } | undefined) => onSettle(job?.id ?? "");
    worker.on("completed", onCompleted);
    worker.on("failed", onFailed);
    setTimeout(() => {
      worker.off("completed", onCompleted);
      worker.off("failed", onFailed);
      reject(new Error(`timed out waiting for ${expectedSettled} jobs to settle, only saw ${settled.length}`));
    }, timeoutMs);
  });
}

describe("P17 scenario: DUPLICATE delivery (the spec #2) — processed once, real queue end to end", () => {
  let connection: Redis | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await closeQueue(TEST_QUEUE_NAME);
    resetQueueForTests();
    resetAllJobsForTests();
    if (connection) {
      await connection.quit();
      connection = undefined;
    }
  });

  it("enqueuing the SAME economics-accrual job twice through the real queue produces exactly one accrual, not two — real money, real BullMQ, real Postgres", async () => {
    const { provider, dealRoom } = await createActivatedDealRoomFixture();
    const platform = await createOrg("Platform", "PLATFORM");
    const { schedule } = await createActiveScheduleFixture(dealRoom, provider.id, platform.id);
    const revenueEvent = await createRevenueEventFixture(dealRoom, schedule, 2_500_00n);

    connection = createRedisConnection();
    registerAllJobs();
    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, lockDuration: 5000, stalledInterval: 2000 });

    // THE duplicate delivery — same logical revenueEventId, enqueued
    // twice, exactly as a webhook re-POST or a network-retry redelivery
    // would look at the BullMQ level (two distinct job.ids, identical
    // business payload).
    await enqueueJob(connection, "economics-accrual", { revenueEventId: revenueEvent.id }, undefined, TEST_QUEUE_NAME);
    await enqueueJob(connection, "economics-accrual", { revenueEventId: revenueEvent.id }, undefined, TEST_QUEUE_NAME);

    await waitForQueueIdle(worker, 2);

    const entries = await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id);
    expect(entries).toHaveLength(2); // 2 components (provider+platform) split ONCE, not 4 (split twice)
    const total = entries.reduce((sum, e) => sum + e.amountMinor, 0n);
    expect(total).toBe(2_500_00n); // exact — no double-credit from the real duplicate delivery
  });
});

describe("P17 scenario: REPLAY (the spec's own exit-condition phrase) — re-processing an entire batch is safe", () => {
  let connection: Redis | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await closeQueue(TEST_QUEUE_NAME);
    resetQueueForTests();
    resetAllJobsForTests();
    if (connection) {
      await connection.quit();
      connection = undefined;
    }
  });

  it("replaying an ENTIRE batch of already-processed jobs (3 revenue events, all previously accrued) through the real queue a second time changes nothing — the batch-level generalization of single-job idempotency", async () => {
    const { provider, dealRoom } = await createActivatedDealRoomFixture();
    const platform = await createOrg("Platform", "PLATFORM");
    const { schedule } = await createActiveScheduleFixture(dealRoom, provider.id, platform.id);
    const revenueEvents = await Promise.all([
      createRevenueEventFixture(dealRoom, schedule, 1_000_00n),
      createRevenueEventFixture(dealRoom, schedule, 2_000_00n),
      createRevenueEventFixture(dealRoom, schedule, 3_000_00n),
    ]);

    connection = createRedisConnection();
    registerAllJobs();
    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, lockDuration: 5000, stalledInterval: 2000 });

    // FIRST pass — the original, real processing of the "event stream."
    for (const re of revenueEvents) {
      await enqueueJob(connection, "economics-accrual", { revenueEventId: re.id }, undefined, TEST_QUEUE_NAME);
    }
    await waitForQueueIdle(worker, 3);

    const afterFirstPass = await Promise.all(revenueEvents.map((re) => commissionAccrualRepository.listByRevenueEvent(prisma, re.id)));
    const firstPassIds = afterFirstPass.map((entries) => entries.map((e) => e.id).sort());
    expect(afterFirstPass.every((entries) => entries.length === 2)).toBe(true); // each event split into 2 (provider+platform)

    // REPLAY — the SAME 3 jobs, re-submitted as if a consumer offset was
    // rewound and the whole stream re-delivered from the start.
    for (const re of revenueEvents) {
      await enqueueJob(connection, "economics-accrual", { revenueEventId: re.id }, undefined, TEST_QUEUE_NAME);
    }
    await waitForQueueIdle(worker, 3);

    const afterReplay = await Promise.all(revenueEvents.map((re) => commissionAccrualRepository.listByRevenueEvent(prisma, re.id)));
    const replayIds = afterReplay.map((entries) => entries.map((e) => e.id).sort());

    // Byte-identical row-id sets before and after the replay — not just
    // "the same count," the actual same rows, proving the replay
    // recomputed nothing and created nothing new.
    expect(replayIds).toEqual(firstPassIds);
    const totalAfterReplay = afterReplay.flat().reduce((sum, e) => sum + e.amountMinor, 0n);
    expect(totalAfterReplay).toBe(1_000_00n + 2_000_00n + 3_000_00n); // exact — the replay didn't inflate the ledger
  });
});
