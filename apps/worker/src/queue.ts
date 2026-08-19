// apps/worker/src/queue.ts
//
// ONE BullMQ queue for every job this app runs (scope's own file tree
// names this file "queues.ts" but does not require literally-separate
// Queue instances per job type — ADR-0014 part 1 records this
// choice explicitly: a single queue, jobs distinguished by `name`, gives
// ONE consolidated dead-letter view ("A dead-letter view is mandatory in
// operator controls," the spec) instead of N separate ones an operator
// would have to check individually).
//
// Queue name is a PARAMETER (defaulting to WORKER_QUEUE_NAME), not a
// hardcoded constant used directly — real Redis is shared across every
// vitest file in this app (fileParallelism: true, vitest.config.ts), and
// BullMQ queues are named/namespaced IN REDIS ITSELF, not per-process:
// two test files both creating a Worker/Queue named "tol-worker" against
// the same real Redis would cross-process each other's jobs. Each
// integration test file picks its own unique queue name (see
// tests/integration/*.test.ts); only server.ts uses the bare default.
//
// earlier-stage work: WORKER_QUEUE_NAME itself now lives in @tol/queue (the
// shared apps/api<->apps/worker contract) — re-exported here so every
// existing import site in this app keeps working unchanged.

import { Queue, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { WORKER_QUEUE_NAME } from "@tol/queue";
import type { WorkerJobName } from "@tol/queue";

export { WORKER_QUEUE_NAME };

/**
 * Applies to every job unless overridden per-enqueue-call. `attempts`+
 * `backoff` is the actual retry policy the TIMEOUT/OUTAGE tests
 * exercise — exponential, capped, never infinite. `removeOnFail` is
 * deliberately generous (not the BullMQ default of "keep forever" nor
 * "remove immediately") — a job that exhausts its retries stays visible
 * via queue.getFailed() for a real dead-letter view (health.ts's
 * `/status` route) instead of vanishing.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
};

const queues = new Map<string, Queue>();

export function getQueue(connection: Redis, queueName: string = WORKER_QUEUE_NAME): Queue {
  let queue = queues.get(queueName);
  if (!queue) {
    queue = new Queue(queueName, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(queueName, queue);
  }
  return queue;
}

/** Typed enqueue — every this stage/4 call site names the job explicitly rather than building a raw queue.add() call, so a typo'd job name is a compile error, not a silent no-op (nothing would ever process a job named "passport-readines"). */
export async function enqueueJob<TData extends Record<string, unknown>>(
  connection: Redis,
  name: WorkerJobName,
  data: TData,
  opts?: JobsOptions,
  queueName: string = WORKER_QUEUE_NAME,
): Promise<Job<TData>> {
  return getQueue(connection, queueName).add(name, data, opts) as Promise<Job<TData>>;
}

export async function closeQueue(queueName: string = WORKER_QUEUE_NAME): Promise<void> {
  const queue = queues.get(queueName);
  if (queue) {
    await queue.close();
    queues.delete(queueName);
  }
}

export async function closeAllQueuesForTests(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

/** Test-only escape hatch, mirroring @tol/config's resetConfigCacheForTests() — clears WITHOUT closing (use closeAllQueuesForTests() when the underlying Queue objects need a clean close too). */
export function resetQueueForTests(): void {
  queues.clear();
}
