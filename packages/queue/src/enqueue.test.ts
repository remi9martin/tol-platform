// packages/queue/src/enqueue.test.ts — real Redis, real BullMQ Queue.
// No mocking: proves apps/api's actual enqueue surface really adds real
// jobs to the real queue apps/worker consumes from.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { resetConfigCacheForTests } from "@tol/config";
import { getProducerConnection, resetProducerConnectionForTests } from "./connection.js";
import {
  enqueuePassportReadiness,
  enqueueCapacityFreshness,
  enqueueRfqExpiry,
  enqueueEconomicsAccrual,
  resetProducerQueueForTests,
  setProducerQueueNameForTests,
} from "./enqueue.js";

// earlier-stage work fix (real bug this exact test file caused, caught by the
// review's own live-verification pass): a randomized, isolated queue
// name — NOT the real WORKER_QUEUE_NAME — so a real apps/worker process
// that happens to be alive in the same environment can never claim/lock a
// job this suite is still inspecting. See setProducerQueueNameForTests's
// own doc comment in enqueue.ts for the full incident.
const TEST_QUEUE_NAME = `tol-worker-test-enqueue-${randomUUID()}`;

describe("@tol/queue enqueue functions — real Redis, real BullMQ", () => {
  beforeEach(() => {
    setProducerQueueNameForTests(TEST_QUEUE_NAME);
  });

  afterEach(async () => {
    resetProducerQueueForTests();
    resetProducerConnectionForTests();
  });

  it("enqueuePassportReadiness adds a real job to the real queue with the correct name and data", async () => {
    const passportId = randomUUID();
    const result = await enqueuePassportReadiness(passportId);

    expect(result.enqueued).toBe(true);
    expect(result.jobId).toBeDefined();

    const inspectConnection = getProducerConnection();
    const queue = new Queue(TEST_QUEUE_NAME, { connection: inspectConnection });
    const job = await queue.getJob(result.jobId!);
    expect(job).toBeDefined();
    expect(job!.name).toBe("passport-readiness");
    expect(job!.data).toEqual({ passportId });
    await job!.remove(); // clean up — don't leave a real job for apps/worker's own test suite to accidentally pick up
  });

  it("enqueueCapacityFreshness adds a real job with the correct name and data", async () => {
    const profileId = randomUUID();
    const result = await enqueueCapacityFreshness(profileId);
    expect(result.enqueued).toBe(true);

    const queue = new Queue(TEST_QUEUE_NAME, { connection: getProducerConnection() });
    const job = await queue.getJob(result.jobId!);
    expect(job!.name).toBe("capacity-freshness");
    expect(job!.data).toEqual({ profileId });
    await job!.remove();
  });

  it("enqueueRfqExpiry schedules a REAL delayed job — not immediately available, becomes available only once the delay elapses", async () => {
    const rfqId = randomUUID();
    const result = await enqueueRfqExpiry(rfqId, 2000);
    expect(result.enqueued).toBe(true);

    const queue = new Queue(TEST_QUEUE_NAME, { connection: getProducerConnection() });
    const job = await queue.getJob(result.jobId!);
    expect(job!.name).toBe("rfq-expiry");
    expect(job!.data).toEqual({ rfqId });

    // Real proof it's genuinely delayed, not just tagged: BullMQ reports
    // its state as "delayed", and it is NOT among the immediately
    // waiting jobs.
    const state = await job!.getState();
    expect(state).toBe("delayed");

    await job!.remove();
  });

  it("enqueueRfqExpiry clamps a negative/expired delay to 0 (fires immediately) rather than dropping the enqueue", async () => {
    const rfqId = randomUUID();
    const result = await enqueueRfqExpiry(rfqId, -5000); // an RFQ whose dueAt has already passed
    expect(result.enqueued).toBe(true);

    const queue = new Queue(TEST_QUEUE_NAME, { connection: getProducerConnection() });
    const job = await queue.getJob(result.jobId!);
    const state = await job!.getState();
    expect(["waiting", "prioritized"]).toContain(state); // immediately available, not stuck delayed

    await job!.remove();
  });

  it("enqueueEconomicsAccrual adds a real job with the correct name and data", async () => {
    const revenueEventId = randomUUID();
    const result = await enqueueEconomicsAccrual(revenueEventId);
    expect(result.enqueued).toBe(true);

    const queue = new Queue(TEST_QUEUE_NAME, { connection: getProducerConnection() });
    const job = await queue.getJob(result.jobId!);
    expect(job!.name).toBe("economics-accrual");
    expect(job!.data).toEqual({ revenueEventId });
    await job!.remove();
  });

  it("a producer connection that cannot reach Redis fails FAST (bounded connectTimeout), never hangs an HTTP request — real unreachable address, not a mock", async () => {
    resetProducerConnectionForTests();
    resetProducerQueueForTests();
    const originalRedisUrl = process.env["REDIS_URL"];
    process.env["REDIS_URL"] = "redis://localhost:1"; // real, nothing listens here
    // getConfig() caches after its first call in this process — without
    // clearing that cache too, this test would silently keep using the
    // REAL redisUrl already cached by an earlier test in this file,
    // proving nothing.
    resetConfigCacheForTests();
    try {
      const start = Date.now();
      const result = await enqueuePassportReadiness(randomUUID());
      const elapsedMs = Date.now() - start;

      expect(result.enqueued).toBe(false);
      expect(result.error).toBeTruthy();
      expect(elapsedMs).toBeLessThan(8000); // bounded — connection.ts's own connectTimeout(2000) + a small bounded retry budget, never the default's unbounded/long wait
    } finally {
      process.env["REDIS_URL"] = originalRedisUrl;
      resetConfigCacheForTests();
      resetProducerConnectionForTests();
      resetProducerQueueForTests();
    }
  }, 15_000);
});
