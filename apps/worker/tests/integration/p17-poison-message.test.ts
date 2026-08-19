// apps/worker/tests/integration/p17-poison-message.test.ts
//
// P17 gate — the spec: "A dead-letter view is mandatory in operator
// controls." Not one of the scope's 7 named recovery scenarios verbatim,
// but explicitly required by this day's own task instructions
// (the "at minimum" list) and directly implied by the P17 exit
// condition's own summary phrase — a queue with no working dead-letter
// path IS a queue that can silently lose work forever on any malformed
// message, which is exactly the class of failure P17 exists to rule out.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { prisma, readinessResultRepository } from "@tol/db";
import { createRedisConnection } from "../../src/redis.js";
import { getQueue, enqueueJob, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerAllJobs, resetAllJobsForTests } from "../../src/jobs/index.js";
import { createWorkerRuntime } from "../../src/worker-runtime.js";
import { createPassportFixture } from "../fixtures.js";
import type { WorkerJobName } from "../../src/jobs/types.js";

const TEST_QUEUE_NAME = `tol-worker-test-p17-poison-${randomUUID()}`;

describe("P17 scenario: POISON MESSAGE — a bad job dead-letters without wedging the queue for the good job behind it", () => {
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

  it("an unknown job name fails IMMEDIATELY (UnrecoverableError, zero wasted retries) and lands in the real dead-letter set, while a valid job enqueued right after it still completes normally", async () => {
    const { passport } = await createPassportFixture();

    connection = createRedisConnection();
    registerAllJobs();
    // Raw queue.add(), bypassing the typed enqueueJob() wrapper — this
    // is the point: a typo'd/stale/since-renamed job name is exactly the
    // kind of thing TypeScript can't catch at the boundary where a REAL
    // poison message would actually originate (a different, older
    // apps/api deploy enqueueing a job name this worker no longer knows,
    // or literal message corruption).
    const poisonJob = await getQueue(connection, TEST_QUEUE_NAME).add(
      "not-a-real-job-name" as WorkerJobName,
      { anything: "goes here" },
      // Explicit, globally-unique jobId — real bug this test's own full-
      // suite run caught: BullMQ's default auto-incrementing id ("1",
      // "2", ...) is only unique WITHIN one queue, and AuditEvent.
      // resourceId carries no queue-name column to disambiguate against.
      // With fileParallelism running every P17 file concurrently, two
      // DIFFERENT test files' own id-"1" jobs can both write an audit row
      // with the SAME resourceId, and an unscoped `WHERE resourceId = ...`
      // query below picks up both. A real, unique id closes this for good.
      { attempts: 5, backoff: { type: "fixed", delay: 100 }, jobId: `poison-${randomUUID()}` },
    );
    const goodJob = await enqueueJob(connection, "passport-readiness", { passportId: passport.id }, undefined, TEST_QUEUE_NAME);

    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, lockDuration: 5000, stalledInterval: 2000 });

    const settled = new Map<string, { type: "failed" | "completed"; attemptsMade: number; errName?: string }>();
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (settled.has(poisonJob.id!) && settled.has(goodJob.id!)) resolve();
      };
      worker!.on("failed", (job, err) => {
        if (!job) return;
        settled.set(job.id!, { type: "failed", attemptsMade: job.attemptsMade, errName: err.name });
        check();
      });
      worker!.on("completed", (job) => {
        settled.set(job.id!, { type: "completed", attemptsMade: job.attemptsMade });
        check();
      });
      setTimeout(() => reject(new Error("timed out waiting for both jobs to settle")), 10_000);
    });

    // THE poison job failed permanently, FAST — attemptsMade stayed low
    // (UnrecoverableError skips the remaining 4 configured attempts
    // entirely; without the fix this test's own writing caught, this
    // would have retried 5 times with backoff before reaching here).
    const poisonOutcome = settled.get(poisonJob.id!);
    expect(poisonOutcome?.type).toBe("failed");
    expect(poisonOutcome?.errName).toBe("PoisonJobError");
    expect(poisonOutcome?.attemptsMade).toBeLessThanOrEqual(1);

    // THE good job, enqueued right after the poison one, was NOT
    // blocked/wedged by it — real proof, not an assumption: it actually
    // completed and actually wrote its real DB effect.
    const goodOutcome = settled.get(goodJob.id!);
    expect(goodOutcome?.type).toBe("completed");
    const results = await readinessResultRepository.listByPassport(prisma, passport.id);
    expect(results).toHaveLength(1);

    // THE dead-letter view itself — the real, queryable mechanism
    // health.ts's /status route exposes to operators (the spec: "A
    // dead-letter view is mandatory in operator controls").
    const failedJobs = await getQueue(connection, TEST_QUEUE_NAME).getFailed(0, 49);
    const poisonInDeadLetter = failedJobs.find((j) => j.id === poisonJob.id);
    expect(poisonInDeadLetter).toBeDefined();
    expect(poisonInDeadLetter?.failedReason).toContain("not-a-real-job-name");

    // And the audit trail (P16: worker/job actions audited) records the
    // dead-lettering as a real event, not just a log line nobody can
    // query. worker-runtime.ts's own audit write is DELIBERATELY
    // fire-and-forget relative to the "failed" event (a slow/failing
    // audit write must never block or fail the job itself — see that
    // file's own comment) — a real race this test's own full-suite run
    // caught: this test's "failed" listener can resolve before the
    // async audit write actually commits. Polling briefly (not asserting
    // the instant the event fires) is the correct fix on THIS side, not
    // a production behavior change.
    const auditRows = await waitForRows(() => prisma.auditEvent.findMany({ where: { resourceId: poisonJob.id, action: "worker.job_dead_lettered" } }), 1);
    expect(auditRows).toHaveLength(1);
  }, 15_000);
});

async function waitForRows<T>(query: () => Promise<T[]>, minLength: number, timeoutMs = 5000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await query();
    if (rows.length >= minLength || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
