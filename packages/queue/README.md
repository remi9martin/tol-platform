# packages/queue — apps/api <-> apps/worker job contract

earlier, this stage. The shared producer-side contract both apps depend on: queue/job names (`names.ts`), per-job data shapes (`job-data.ts`), a producer-tuned Redis connection (`connection.ts` — deliberately different retry/timeout behavior from apps/worker's own consumer connection, see that file's header comment), and typed, safe-by-construction enqueue functions (`enqueue.ts`) apps/api's services call directly.

apps/worker's own job **processing** (handlers, registry, worker-runtime, the consumer-side Redis connection) stays in `apps/worker/src/` — this package is the producer-side contract only, not a general "queue" abstraction. `WorkerJobName`/`WORKER_JOB_NAMES` here and in `apps/worker/src/jobs/types.ts` (which now imports from here) are the same closed vocabulary — one source of truth, no drift risk between what apps/api can enqueue and what apps/worker knows how to process.
