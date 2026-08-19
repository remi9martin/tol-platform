// apps/worker/src/jobs/ping.job.ts
//
// an earlier smoke-test job — proves enqueue -> BullMQ -> processor
// dispatch -> handler -> completed event travels end to end through a
// REAL Redis and a REAL Worker before any this stage job (which also
// touches Postgres) exists to muddy whether a failure is in the queue
// plumbing or in a specific job's business logic. Kept (not deleted)
// after this stage — health.ts's own smoke check and the generic
// fault-injection tests (DUPLICATE/TIMEOUT/POISON) reuse it as a minimal
// job with no DB side effects, isolating "does the queue mechanism
// itself recover" from "does this specific job's DB write stay correct."

import type { Job } from "bullmq";
import type { JobHandler, JobHandlerContext } from "./types.js";
import type { PingJobData } from "@tol/queue";

// earlier-stage work: moved to @tol/queue — re-exported so existing import sites keep working.
export type { PingJobData };

export interface PingJobResult {
  pong: string;
  processedAt: string;
  attemptsMade: number;
}

export const pingJob: JobHandler<PingJobData, PingJobResult> = async (job: Job<PingJobData>, ctx: JobHandlerContext) => {
  if (job.data.delayMs && job.data.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, job.data.delayMs));
  }
  ctx.logger.info({ jobId: job.id, nonce: job.data.nonce, attemptsMade: job.attemptsMade }, "worker.ping processed");
  return { pong: job.data.nonce, processedAt: ctx.now.toISOString(), attemptsMade: job.attemptsMade };
};
