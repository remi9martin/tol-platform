// apps/worker/src/jobs/registry.ts
//
// A job module (e.g. passport-readiness.job.ts) exports its handler
// function; jobs/index.ts's registerAllJobs() is the ONE place that maps
// each WorkerJobName to its handler. worker-runtime.ts's processor looks
// the handler up by `job.name` at dispatch time — an unregistered name
// (typo, or a job enqueued by a stale apps/api build after a rename) is
// the POISON MESSAGE case, not a crash.

import type { JobHandler, WorkerJobName } from "./types.js";

// The map is stored as JobHandler<any, unknown> deliberately, not
// JobHandler<never, unknown> — `any` (not `never`) is the correct erasure
// for "a heterogeneous registry whose per-entry TData varies and is
// looked up by a runtime string, not narrowed by the type system." A
// stored `never` makes the real `Job<SomeConcreteData>` a caller
// (worker-runtime.ts) actually holds fail to satisfy the handler's
// parameter type, since `never` accepts nothing — worker-runtime.ts's
// own dispatch is where real type safety belongs (each this stage job
// module still types its own exported handler precisely).
const registry = new Map<WorkerJobName, JobHandler<any, unknown>>();

export function registerJob<TData, TResult>(name: WorkerJobName, handler: JobHandler<TData, TResult>): void {
  if (registry.has(name)) {
    throw new Error(`registerJob: "${name}" is already registered — each job name may only be registered once`);
  }
  registry.set(name, handler as JobHandler<any, unknown>);
}

export function getJobHandler(name: WorkerJobName): JobHandler<any, unknown> | undefined {
  return registry.get(name);
}

export function registeredJobNames(): WorkerJobName[] {
  return [...registry.keys()];
}

/** Test-only escape hatch — lets a test register a fake handler for a controlled scenario without carrying every other test's registrations along. */
export function resetRegistryForTests(): void {
  registry.clear();
}
