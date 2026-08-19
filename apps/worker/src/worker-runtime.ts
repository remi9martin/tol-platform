// apps/worker/src/worker-runtime.ts
//
// Wraps BullMQ's own Worker with: (1) a per-job timeout race (BullMQ has
// no built-in "kill the handler after N ms" — only lock-based STALLED
// detection, a different mechanism for a different failure shape, see
// below), (2) job-name dispatch through jobs/registry.ts, with an unknown
// name treated as the POISON MESSAGE case rather than a crash, and
// (3) job-lifecycle audit writes (P16: "Advance P16 — worker/job actions
// audited") reusing @tol/db's EXISTING auditRepository directly — no new
// table, actorUserId/actorOrgId/actorRole left null (system-triggered,
// not a persona action) with resourceType "worker_job" identifying it.
//
// Timeout vs. stall, why both exist (ADR-0014 part 3 has the
// full reasoning): a STALLED job is BullMQ's own detection that a
// worker PROCESS died (or was starved) while holding a job's lock —
// the fix is another worker picking the job back up (the
// worker-crash-mid-job test). A TIMED-OUT job is a worker process that's
// alive and responding but whose handler is taking too long against a
// live dependency (the TIMEOUT test) — the fix is failing that
// attempt fast so BullMQ's own backoff/attempts policy can retry it,
// rather than holding the lock until stalledInterval eventually notices.

import { Worker, type Job, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import { prisma, auditRepository } from "@tol/db";
import { WORKER_QUEUE_NAME } from "./queue.js";
import { getJobHandler } from "./jobs/registry.js";
import { isWorkerJobName, JobTimeoutError, PoisonJobError } from "./jobs/types.js";
import { getLogger } from "./logger.js";

export interface WorkerRuntimeOptions {
  connection: Redis;
  concurrency?: number;
  /** ms — how long a job's lock is held before BullMQ's stalled-check considers it abandoned. Kept low in tests (this stage) so a killed-worker-process recovery test doesn't need to wait 30s+ for real. */
  lockDuration?: number;
  /** ms — how often BullMQ scans for stalled jobs. */
  stalledInterval?: number;
  /** ms — this file's own per-attempt timeout race, independent of lockDuration/stalledInterval (see header comment). */
  jobTimeoutMs?: number;
  /** Defaults to WORKER_QUEUE_NAME (queue.ts) — see that file's header comment on why tests override this to a unique per-file name against the shared real Redis. */
  queueName?: string;
}

const DEFAULT_JOB_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, jobName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(jobName, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

const AUDIT_WRITE_MAX_ATTEMPTS = 3;

/**
 * review (review) correctly
 * flagged the original version of this call as fire-and-forget with no
 * retry — a transient DB hiccup at the EXACT moment a job completes would
 * silently drop that one audit row forever, logged but never recovered.
 * The audit trail is secondary observability, not the job's own business
 * effect (P17's actual correctness property — exactly-once DB writes for
 * what a job DOES — is untouched either way, proven independently by
 * this stage/3's own tests), but "best-effort" doesn't have to mean
 * "first-failure-and-done" when a bounded retry costs almost nothing.
 * Still fire-and-forget from the CALLER's perspective (a slow/failing
 * audit write must never block or fail the job itself) — this just makes
 * the background attempt itself more persistent before giving up.
 */
async function recordJobAudit(job: Job, action: string, reason: string | null = null): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AUDIT_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      await auditRepository.write(prisma, {
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
        subjectOrgId: null,
        action,
        resourceType: "worker_job",
        resourceId: job.id ?? null,
        afterValue: { jobName: job.name, attemptsMade: job.attemptsMade, data: job.data as Record<string, unknown> },
        reason,
      });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < AUDIT_WRITE_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }
  throw lastErr;
}

/** BullMQ job.opts.attempts is only ever a plain number by the time a job is actually processing (BullMQ resolves any default at add() time) — this narrows it defensively rather than asserting, matching this codebase's "never throw on a plausible edge" stance for non-money-critical bookkeeping. */
function attemptsExhausted(job: Job): boolean {
  const max = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
  return job.attemptsMade >= max;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): Worker {
  const logger = getLogger();
  const timeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  const workerOptions: WorkerOptions = {
    connection: options.connection,
    concurrency: options.concurrency ?? 4,
    lockDuration: options.lockDuration ?? 30_000,
    stalledInterval: options.stalledInterval ?? 30_000,
  };

  const worker = new Worker(
    options.queueName ?? WORKER_QUEUE_NAME,
    async (job: Job) => {
      if (!isWorkerJobName(job.name)) {
        throw new PoisonJobError(`unknown job name "${job.name}" — no such job is ever registered, retrying cannot help`);
      }
      const handler = getJobHandler(job.name);
      if (!handler) {
        throw new PoisonJobError(`job name "${job.name}" has no registered handler — registerAllJobs() likely wasn't called before this Worker started`);
      }
      const jobLogger = logger.child({ jobId: job.id, jobName: job.name, attemptsMade: job.attemptsMade });
      return withTimeout(handler(job, { logger: jobLogger, now: new Date() }), timeoutMs, job.name);
    },
    workerOptions,
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, jobName: job.name, attemptsMade: job.attemptsMade }, "job completed");
    void recordJobAudit(job, "worker.job_completed").catch((err: unknown) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "failed to write job-completed audit event"),
    );
  });

  worker.on("failed", (job, err) => {
    const poison = err instanceof PoisonJobError;
    const timedOut = err instanceof JobTimeoutError;
    const exhausted = job ? attemptsExhausted(job) || poison : true;
    logger.warn(
      { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message, poison, timedOut, deadLettered: exhausted },
      "job attempt failed",
    );
    if (job && exhausted) {
      void recordJobAudit(job, "worker.job_dead_lettered", err.message).catch((auditErr: unknown) =>
        logger.error({ err: auditErr instanceof Error ? auditErr.message : String(auditErr) }, "failed to write job-dead-lettered audit event"),
      );
    }
  });

  worker.on("error", (err) => {
    logger.error({ err: err.message }, "worker-level error (connection/infra — not tied to a specific job)");
  });

  worker.on("stalled", (jobId) => {
    logger.warn({ jobId }, "job stalled — a worker holding its lock went dark; BullMQ will hand it to another attempt");
  });

  return worker;
}
