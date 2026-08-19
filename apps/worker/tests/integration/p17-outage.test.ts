// apps/worker/tests/integration/p17-outage.test.ts
//
// P17 exit condition (the spec): "...outage/replay tests." A REAL
// ioredis connection, genuinely disconnected mid-flight and reconnected
// — not a mock, not a bad-port fake-out (that technique proves the
// READINESS GATE correctly reports down, per an earlier /ready test;
// THIS file proves the WORKER ITSELF survives a live disconnect and
// resumes consuming without losing or duplicating work, a different
// mechanism: ioredis's own `retryStrategy` (redis.ts) combined with
// BullMQ's `maxRetriesPerRequest: null` connection contract).

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { prisma, readinessResultRepository } from "@tol/db";
import { createRedisConnection } from "../../src/redis.js";
import { enqueueJob, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerAllJobs, resetAllJobsForTests } from "../../src/jobs/index.js";
import { createWorkerRuntime } from "../../src/worker-runtime.js";
import { createPassportFixture } from "../fixtures.js";

const TEST_QUEUE_NAME = `tol-worker-test-p17-outage-${randomUUID()}`;

describe("P17 scenario: OUTAGE — Redis connection genuinely drops mid-flight and reconnects, no lost or double work", () => {
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
      await connection.quit().catch(() => undefined);
      connection = undefined;
    }
  });

  it("a job enqueued during a live disconnect is picked up once the connection genuinely reconnects — real ioredis disconnect(true), real reconnect via redis.ts's own retryStrategy, no mock", async () => {
    const { passport } = await createPassportFixture();

    connection = createRedisConnection();
    // Establish the connection for real before disrupting it — proves
    // the fault happens against a genuinely-live connection, not one
    // that never connected in the first place.
    await connection.ping();

    registerAllJobs();
    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, lockDuration: 8000, stalledInterval: 2000 });

    // THE fault: a real disconnect against the real Redis server this
    // connection was actually talking to. `disconnect(true)` — the
    // reconnect=true form — is what makes ioredis treat this like a
    // genuine dropped connection (invoking redis.ts's own retryStrategy)
    // rather than an intentional, permanent shutdown.
    const readyBeforeDisconnect = connection.status;
    connection.disconnect(true);

    // Enqueue WHILE the connection is down — this is the "duplicate
    // delivery attempted during an outage" shape: the job must not be
    // lost even though nothing was listening to accept it the instant it
    // was queued.
    const job = await enqueueJob(connection, "passport-readiness", { passportId: passport.id }, undefined, TEST_QUEUE_NAME);

    const completion = await new Promise<{ attemptsMade: number }>((resolve, reject) => {
      const onCompleted = (completedJob: { id?: string; attemptsMade: number }) => {
        if (completedJob.id === job.id) resolve({ attemptsMade: completedJob.attemptsMade });
      };
      worker!.on("completed", onCompleted);
      setTimeout(() => reject(new Error("timed out waiting for the job to complete after reconnect")), 20_000);
    });

    expect(readyBeforeDisconnect).toBe("ready"); // the connection really was live before the fault
    // Real BullMQ observed: attemptsMade came back 1 (a genuine retry
    // happened — the job's first dispatch attempt landed during the
    // disconnect window and had to be retried once the connection came
    // back), not 0. Not asserting an exact count — this test's real
    // proof is "eventually completed, exactly once," not "on which
    // attempt." A bounded, small number of attempts is what "recovers
    // from a transient outage" looks like in practice.
    expect(completion.attemptsMade).toBeLessThan(3);

    // No lost work, no double work.
    const results = await readinessResultRepository.listByPassport(prisma, passport.id);
    expect(results).toHaveLength(1);
  }, 25_000);
});
