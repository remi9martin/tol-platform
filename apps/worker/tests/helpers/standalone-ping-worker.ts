// apps/worker/tests/helpers/standalone-ping-worker.ts
//
// A REAL, separate OS process — not an in-process simulation — spawned
// by p17-worker-crash.test.ts via `child_process.spawn`, so that test
// can SIGKILL it (a genuine, ungraceful crash: no chance to release its
// BullMQ job lock, no chance to run any shutdown handler) while it's
// mid-flight processing a job. This is what makes the spec scenario #3
// ("Worker crashes mid-job: job is retried safely") a REAL fault
// injection rather than a simulated one.
//
// Args (positional): [queueName, redisUrl]
//
// The artificial slowness lives HERE, hardcoded, independent of the
// job's own data — deliberately, so that once the parent test's own
// "worker B" reclaims the abandoned job and runs it through the REAL,
// unmodified production `pingJob` (ping.job.ts), that recovery attempt
// completes at NORMAL speed (job.data carries no delay instruction) —
// only THIS standalone process is artificially slow, and only so the
// parent test has a reliable window to observe "genuinely processing"
// before sending SIGKILL.
//
// Logs a single line `PROCESSING_STARTED <jobId>` to stdout the instant
// a job begins (before the hardcoded delay), which the parent test waits
// for as proof the job is genuinely locked/active before killing this
// process — killing before this line would just be "enqueued but never
// picked up," a different (already-covered) scenario, not this one.

import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { registerJob, getJobHandler } from "../../src/jobs/registry.js";
import type { JobHandler } from "../../src/jobs/types.js";
import type { PingJobData, PingJobResult } from "../../src/jobs/ping.job.js";

const [, queueName, redisUrl] = process.argv;
if (!queueName || !redisUrl) {
  console.error("usage: standalone-ping-worker.ts <queueName> <redisUrl>");
  process.exit(1);
}

const HARDCODED_SLOWNESS_MS = 6000;

const slowPingJob: JobHandler<PingJobData, PingJobResult> = async (job) => {
  console.log(`PROCESSING_STARTED ${job.id}`);
  await new Promise((resolve) => setTimeout(resolve, HARDCODED_SLOWNESS_MS));
  return { pong: job.data.nonce, processedAt: new Date().toISOString(), attemptsMade: job.attemptsMade };
};

registerJob("worker.ping", slowPingJob);

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const worker = new Worker(
  queueName,
  async (job) => {
    const handler = getJobHandler("worker.ping");
    if (!handler) throw new Error("worker.ping not registered in standalone process");
    return handler(job, { logger: noopLogger as never, now: new Date() });
  },
  { connection, lockDuration: 2000, stalledInterval: 500 },
);

worker.on("error", (err) => console.error("STANDALONE_WORKER_ERROR", err.message));

console.log("STANDALONE_WORKER_READY");
