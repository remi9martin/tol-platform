// apps/worker/src/sweeps.ts
//
// Registers the three sweep-capable job types (passport-readiness,
// capacity-freshness, rfq-expiry) as REAL, recurring BullMQ Job
// Schedulers — the actual scheduling mechanism the event-triggered
// enqueue path (earlier-stage work, apps/api's enqueue*() calls) was always
// documented as having a "fallback/catch-all" for, but which nothing
// ever registered until now. A real, honestly-logged gap (review
// earlier-stage work/5 entries, this day's review) — each of
// these three jobs' own handler has supported a no-id "scan everything,
// process what qualifies" branch since this stage (economics-accrual is
// deliberately excluded: the spec names its trigger as
// activation->accrual, always specific to one revenueEventId, never
// swept in bulk — see EconomicsAccrualJobData's own "Always specific"
// comment in packages/queue/src/job-data.ts), only the SCHEDULE to
// actually invoke that branch was missing.
//
// upsertJobScheduler is idempotent BY THE SCHEDULER ID this file chooses
// (BullMQ's own documented behavior, distinct from the older, still-
// supported-but-superseded `repeat` option on a plain add() call) —
// every worker instance calling this at its own startup is safe, not a
// source of duplicate schedules; BullMQ deduplicates on the id, and a
// re-registration with the same id/options is a clean no-op update.
//
// INTERVALS are a documented, stated inference — the spec names no
// numeric SLA for background reconciliation. RFQ sweeps more often
// because a missed dueAt is more immediately user-visible than passport/
// capacity staleness (whose own windows — READINESS_STALE_AFTER_DAYS=90
// in apps/api's passport/service.ts, capacityFreshnessWindowDays in
// @tol/evidence — are measured in days, not minutes). Passport/capacity
// share a more relaxed cadence since their own real, deterministic
// on-read checks (P6/P8, DONE since earlier) remain the correctness source
// for any human-facing view regardless of this schedule's cadence — this
// sweep only closes the gap for records nobody is actively viewing.

import type { Queue } from "bullmq";

export interface SweepSchedule {
  jobName: "passport-readiness" | "capacity-freshness" | "rfq-expiry";
  schedulerId: string;
  everyMs: number;
}

export const SWEEP_SCHEDULES: readonly SweepSchedule[] = [
  { jobName: "passport-readiness", schedulerId: "sweep:passport-readiness", everyMs: 15 * 60 * 1000 },
  { jobName: "capacity-freshness", schedulerId: "sweep:capacity-freshness", everyMs: 15 * 60 * 1000 },
  { jobName: "rfq-expiry", schedulerId: "sweep:rfq-expiry", everyMs: 5 * 60 * 1000 },
];

/** Called once at worker startup (server.ts's own main(), after registerAllJobs()). Safe to call from every worker instance — see this file's own header on upsertJobScheduler's idempotency. */
export async function registerSweepSchedules(queue: Queue): Promise<void> {
  for (const { jobName, schedulerId, everyMs } of SWEEP_SCHEDULES) {
    // Empty data ({}) is deliberate — every one of these three handlers
    // treats an absent id (passportId/profileId/rfqId all undefined) as
    // "scan everything, process what qualifies," the exact branch this
    // schedule exists to invoke.
    await queue.upsertJobScheduler(schedulerId, { every: everyMs }, { name: jobName, data: {} });
  }
}
