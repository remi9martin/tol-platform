// packages/queue/src/names.ts
//
// earlier: moved here from apps/worker/src/jobs/types.ts (this stage) — the
// job-name vocabulary and the queue name itself are the ONE part of the
// api<->worker contract BOTH sides must agree on byte-for-byte; keeping
// it in apps/worker made apps/api's own enqueue calls either duplicate
// the string literals (real drift risk — a typo'd job name enqueued by
// apps/api would silently become an earlier POISON MESSAGE scenario
// in production) or reach across the app boundary into another app's
// src/ (this codebase's own convention, the spec, forbids exactly
// that — cross-cutting concerns live in packages/*, apps consume them).
// Same "closed, typed vocabulary" discipline packages/events uses for
// DomainEvent types, applied to BullMQ job names instead.

export const WORKER_QUEUE_NAME = "tol-worker";

export const WORKER_JOB_NAMES = [
  "worker.ping",
  "passport-readiness",
  "capacity-freshness",
  "rfq-expiry",
  "economics-accrual",
] as const;
export type WorkerJobName = (typeof WORKER_JOB_NAMES)[number];
export function isWorkerJobName(value: string): value is WorkerJobName {
  return (WORKER_JOB_NAMES as readonly string[]).includes(value);
}
