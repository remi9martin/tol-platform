// apps/worker/src/jobs/types.ts
//
// earlier-stage work: WORKER_JOB_NAMES/WorkerJobName/isWorkerJobName moved to
// @tol/queue (the shared apps/api<->apps/worker contract — see that
// package's README) — re-exported here so every existing apps/worker
// import site (`from "./types.js"`) keeps working unchanged. This file
// now owns only what's genuinely apps/worker-internal: the job-execution
// error types and handler shape, none of which apps/api ever needs.

import { UnrecoverableError } from "bullmq";
import type { Job } from "bullmq";
import type { Logger } from "pino";

export { WORKER_JOB_NAMES, isWorkerJobName } from "@tol/queue";
export type { WorkerJobName } from "@tol/queue";

/**
 * Thrown by a job handler to signal "this payload is structurally
 * invalid — do not retry, dead-letter immediately." Distinct from a
 * transient failure (DB/Redis hiccup, timeout), which throws a plain
 * Error/DomainTransitionError and IS retried per the queue's backoff
 * policy. the POISON MESSAGE test is what this exists for — see
 * worker-runtime.ts's processor for how the two are told apart.
 *
 * Extends BullMQ's own `UnrecoverableError`, not a plain `Error` — this
 * is load-bearing, not cosmetic. A real gap an earlier test-writing
 * caught: BullMQ has NO built-in way to tell a generic thrown Error
 * apart from one that's genuinely pointless to retry — every thrown
 * error, regardless of type, gets the full configured `attempts` count
 * (5, `queue.ts`'s `DEFAULT_JOB_OPTIONS`) with exponential backoff before
 * landing in the failed set, UNLESS the handler specifically throws
 * `UnrecoverableError` (or a subclass), which BullMQ's own Worker checks
 * for by name and fails the job IMMEDIATELY regardless of remaining
 * attempts. Without this, an "unknown job name" poison message would
 * have retried 5 times (with backoff delays compounding) before
 * dead-lettering — directly contradicting this class's own "retrying
 * cannot help" reasoning, which was previously just a comment, not
 * enforced behavior.
 */
export class PoisonJobError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = "PoisonJobError";
  }
}

/** Thrown by a job handler (or the timeout wrapper in worker-runtime.ts) when a unit of work exceeded its allotted time. A plain, named error type rather than a generic Error so tests and logs can tell "timed out" apart from "threw for some other reason" without string-matching a message. */
export class JobTimeoutError extends Error {
  constructor(jobName: string, timeoutMs: number) {
    super(`job "${jobName}" exceeded its ${timeoutMs}ms timeout`);
    this.name = "JobTimeoutError";
  }
}

export interface JobHandlerContext {
  readonly logger: Logger;
  /** Wall-clock reference for this job run — passed explicitly (never read internally) so every engine call underneath (classifyCapacityFreshness/classifyFactFreshness/computeReadiness, all of which take an explicit `now: Date`) stays deterministic and test-injectable, matching this codebase's zero-hidden-clock-dependency discipline throughout packages/evidence and packages/domain. */
  readonly now: Date;
}

/** Every job handler has this shape: given the Job (BullMQ's own envelope — `.data`, `.attemptsMade`, `.id`) and a small context, do the real work and return a JSON-serializable result (or throw). Handlers must be idempotent — see shared/job-idempotency.ts. */
export type JobHandler<TData = unknown, TResult = unknown> = (job: Job<TData>, ctx: JobHandlerContext) => Promise<TResult>;
