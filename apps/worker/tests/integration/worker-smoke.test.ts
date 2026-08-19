// apps/worker/tests/integration/worker-smoke.test.ts
//
// an earlier end-to-end proof: a REAL Redis connection (the
// docker-compose `redis` service, via REDIS_URL), a REAL BullMQ Queue +
// Worker, enqueue -> process -> complete, plus the health/ready/status
// HTTP surface against real dependencies. This file — not a mock — is
// what "graceful startup/shutdown and a health/readiness signal" (earlier
// task this stage) means proven, not just typed.
//
// Uses its own unique queue name (not the shared WORKER_QUEUE_NAME) —
// see queue.ts's header comment: real Redis is shared across every
// vitest file in this app, and BullMQ queues are namespaced IN REDIS,
// not per-process.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { prisma } from "@tol/db";
import { createRedisConnection } from "../../src/redis.js";
import { getQueue, enqueueJob, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerAllJobs, resetAllJobsForTests } from "../../src/jobs/index.js";
import { createWorkerRuntime } from "../../src/worker-runtime.js";
import { buildHealthServer } from "../../src/health.js";
import type { PingJobResult } from "../../src/jobs/ping.job.js";

const TEST_QUEUE_NAME = `tol-worker-test-block1-${randomUUID()}`;

describe("apps/worker this stage — real Redis end-to-end smoke", () => {
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

  it("enqueue -> real BullMQ Worker -> processed -> completed, end to end against the real docker-compose Redis", async () => {
    connection = createRedisConnection();
    registerAllJobs();
    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, lockDuration: 5000, stalledInterval: 2000 });

    const job = await enqueueJob(connection, "worker.ping", { nonce: "block1-smoke" }, undefined, TEST_QUEUE_NAME);

    const result = await new Promise<PingJobResult>((resolve, reject) => {
      const onCompleted = (completedJob: { id?: string }, returnvalue: unknown) => {
        if (completedJob.id === job.id) resolve(returnvalue as PingJobResult);
      };
      const onFailed = (failedJob: { id?: string } | undefined, err: Error) => {
        if (failedJob?.id === job.id) reject(err);
      };
      worker!.on("completed", onCompleted);
      worker!.on("failed", onFailed);
      setTimeout(() => reject(new Error("timed out waiting for job completion")), 10_000);
    });

    expect(result.pong).toBe("block1-smoke");
    // BullMQ's `attemptsMade` counts PRIOR (already-completed) attempts,
    // not the one currently in flight — 0 on a first-try success,
    // confirmed by actually running this test against real BullMQ before
    // writing this assertion (the value observed was 0, not the 1
    // originally assumed here).
    expect(result.attemptsMade).toBe(0);
  });

  it("health/ready/status endpoints reflect real state against the real DB + Redis", async () => {
    connection = createRedisConnection();
    const queue = getQueue(connection, TEST_QUEUE_NAME);
    const app = buildHealthServer({ db: prisma, redis: connection, queue });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", app: "tol-worker" });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, database: { ok: true }, redis: { ok: true } });

    const status = await app.inject({ method: "GET", url: "/status" });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as { queue: string; counts: Record<string, number>; deadLetter: unknown[] };
    expect(statusBody.queue).toBe(TEST_QUEUE_NAME);
    expect(statusBody.counts).toHaveProperty("waiting");
    expect(statusBody.counts).toHaveProperty("active");
    expect(statusBody.counts).toHaveProperty("completed");
    expect(statusBody.counts).toHaveProperty("failed");
    expect(statusBody.counts).toHaveProperty("delayed");
    expect(Array.isArray(statusBody.deadLetter)).toBe(true);

    await app.close();
  });

  it("/ready reports ok:false (503) when Redis is unreachable — a real disconnected connection, not a mock", async () => {
    // A connection deliberately pointed at a port nothing listens on —
    // real ioredis, real (failed) TCP attempt, never touches the shared
    // production connection or the shared Redis container's own state.
    const brokenConnection = createRedisConnection("redis://localhost:1");
    const queue = getQueue(brokenConnection, `${TEST_QUEUE_NAME}-broken`);
    const app = buildHealthServer({ db: prisma, redis: brokenConnection, queue });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    const body = ready.json() as { ok: boolean; redis: { ok: boolean; error?: string } };
    expect(body.ok).toBe(false);
    expect(body.redis.ok).toBe(false);

    await app.close();
    await queue.close();
    brokenConnection.disconnect();
  }, 15_000);

  it("graceful shutdown: worker.close() resolves cleanly with no active job", async () => {
    connection = createRedisConnection();
    registerAllJobs();
    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME });
    await worker.close();
    worker = undefined; // already closed — afterEach shouldn't double-close
  });

  it("worker.ping smoke job supports a real, induced timeout (delayMs) — the exact knob the TIMEOUT test builds on", async () => {
    connection = createRedisConnection();
    registerAllJobs();
    worker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, jobTimeoutMs: 300, lockDuration: 5000 });

    const job = await enqueueJob(
      connection,
      "worker.ping",
      { nonce: "will-timeout", delayMs: 2000 },
      { attempts: 1 },
      TEST_QUEUE_NAME,
    );

    const failure = await new Promise<Error>((resolve, reject) => {
      const onFailed = (failedJob: { id?: string } | undefined, err: Error) => {
        if (failedJob?.id === job.id) resolve(err);
      };
      worker!.on("failed", onFailed);
      worker!.on("completed", (completedJob: { id?: string }) => {
        if (completedJob.id === job.id) reject(new Error("expected this job to time out, not complete"));
      });
      setTimeout(() => reject(new Error("timed out waiting for the job's OWN failure event")), 10_000);
    });

    expect(failure.name).toBe("JobTimeoutError");
    expect(failure.message).toMatch(/300ms timeout/);
  });
});
