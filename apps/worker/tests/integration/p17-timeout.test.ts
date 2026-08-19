// apps/worker/tests/integration/p17-timeout.test.ts
//
// P17 gate — the spec scenario #1, verbatim: "API timeout after DB
// commit: idempotency returns original result instead of duplicating
// submission." Re-cast for a worker job rather than an HTTP request (the
// scope's own wording is API-shaped, but the underlying distributed-
// systems trap is identical): a job's real DB write can COMMIT
// successfully even while the CALLER (here: worker-runtime.ts's own
// per-attempt timeout race, see that file's header comment on why it
// exists as a mechanism distinct from BullMQ's stalled-job detection)
// gives up waiting and marks the attempt failed. The retry must observe
// the already-committed effect and NOT re-apply it.
//
// Uses a dedicated, test-only job (registered directly here, not via
// registerAllJobs/jobs/index.ts) rather than instrumenting one of Block
// 2's real production jobs with a test-only delay hook — this keeps
// production job code free of test-only branches while still exercising
// the REAL, SHARED mechanism every real job relies on: worker-runtime.ts's
// timeout wrapper, BullMQ's real retry/backoff, and shared/job-
// idempotency.ts's real dedup against the real idempotency_keys table.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { prisma } from "@tol/db";
import { createRedisConnection } from "../../src/redis.js";
import { enqueueJob, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerJob, resetRegistryForTests } from "../../src/jobs/registry.js";
import { createWorkerRuntime } from "../../src/worker-runtime.js";
import { withJobIdempotency } from "../../src/shared/job-idempotency.js";
import type { JobHandler } from "../../src/jobs/types.js";

const TEST_QUEUE_NAME = `tol-worker-test-p17-timeout-${randomUUID()}`;

interface SlowCommitJobData {
  key: string;
  /** Real ms delay AFTER the DB write below has already committed — applied ONLY on the very first attempt (attemptsMade === 0), simulating "the underlying operation was slow exactly once" rather than a permanently-broken dependency. */
  delayAfterCommitOnFirstAttemptMs: number;
}

/**
 * Does a REAL, idempotent Postgres write (an AuditEvent — cheap, real,
 * queryable) THEN delays. worker-runtime.ts's outer `withTimeout` races
 * this whole handler against `jobTimeoutMs`; on the first attempt the
 * write wins (commits fast) but the delay AFTER it is what actually
 * trips the timeout — proving the DB effect landed before the caller
 * (BullMQ, standing in for an HTTP caller) ever "knew" about it.
 */
const slowCommitJob: JobHandler<SlowCommitJobData, { auditId: string }> = async (job: Job<SlowCommitJobData>) => {
  const result = await withJobIdempotency(
    prisma,
    { scope: "test.p17-timeout", key: job.data.key, requestPayload: { key: job.data.key } },
    async () => {
      const audit = await prisma.auditEvent.create({
        data: {
          id: randomUUID(),
          action: "test.p17_timeout_commit",
          resourceType: "test_fixture",
          resourceId: job.data.key,
          afterValue: { key: job.data.key },
        },
      });
      return { auditId: audit.id };
    },
  );

  if (job.attemptsMade === 0 && job.data.delayAfterCommitOnFirstAttemptMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, job.data.delayAfterCommitOnFirstAttemptMs));
  }

  return result;
};

describe("P17 scenario: TIMEOUT after DB commit (the spec #1) — idempotency returns the original result instead of duplicating", () => {
  let connection: Redis | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await closeQueue(TEST_QUEUE_NAME);
    resetQueueForTests();
    resetRegistryForTests();
    if (connection) {
      await connection.quit();
      connection = undefined;
    }
  });

  it(
    "attempt 1's write REALLY commits, then REALLY times out (worker-runtime's own JobTimeoutError, not a mock); attempt 2 sees the completed idempotency record and skips the write — exactly one AuditEvent, not two",
    async () => {
      connection = createRedisConnection();
      // worker-runtime.ts's dispatcher rejects any job.name outside
      // WORKER_JOB_NAMES's closed vocabulary as a poison message (by
      // design — see jobs/types.ts) — this test's registry is isolated
      // (resetRegistryForTests() in afterEach, and registerAllJobs() is
      // never called here), so it's safe to register a TEST-ONLY handler
      // under the real "worker.ping" name for the duration of this one
      // test, without registering the real ping job at all.
      registerJob("worker.ping", slowCommitJob);
      worker = createWorkerRuntime({
        connection,
        queueName: TEST_QUEUE_NAME,
        jobTimeoutMs: 300, // short — the delay below (2000ms) will genuinely exceed it
        lockDuration: 10_000,
      });

      const idempotencyKey = `p17-timeout-${randomUUID()}`;
      const job = await enqueueJob(
        connection,
        "worker.ping",
        { key: idempotencyKey, delayAfterCommitOnFirstAttemptMs: 2000 },
        { attempts: 3, backoff: { type: "fixed", delay: 200 } },
        TEST_QUEUE_NAME,
      );

      const attemptOutcomes: Array<{ type: "failed" | "completed"; attemptsMade: number; err?: string }> = [];
      await new Promise<void>((resolve, reject) => {
        const onFailed = (failedJob: { id?: string; attemptsMade: number } | undefined, err: Error) => {
          if (!failedJob || failedJob.id !== job.id) return;
          attemptOutcomes.push({ type: "failed", attemptsMade: failedJob.attemptsMade, err: err.name });
        };
        const onCompleted = (completedJob: { id?: string; attemptsMade: number }) => {
          if (completedJob.id !== job.id) return;
          attemptOutcomes.push({ type: "completed", attemptsMade: completedJob.attemptsMade });
          resolve();
        };
        worker!.on("failed", onFailed);
        worker!.on("completed", onCompleted);
        setTimeout(() => reject(new Error(`timed out waiting for job ${job.id} to eventually complete`)), 15_000);
      });

      // THE fault was real: attempt 1 genuinely failed with a genuine
      // JobTimeoutError (not skipped, not mocked) before attempt 2
      // genuinely succeeded.
      expect(attemptOutcomes[0]?.type).toBe("failed");
      expect(attemptOutcomes[0]?.err).toBe("JobTimeoutError");
      expect(attemptOutcomes.at(-1)?.type).toBe("completed");

      // THE proof: exactly one row, from attempt 1's real commit —
      // attempt 2 replayed the cached idempotency result rather than
      // writing a second AuditEvent.
      const rows = await prisma.auditEvent.findMany({ where: { resourceType: "test_fixture", resourceId: idempotencyKey } });
      expect(rows).toHaveLength(1);
    },
    20_000,
  );
});
