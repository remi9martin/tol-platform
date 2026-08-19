// apps/worker/src/jobs/index.ts
//
// The one place every job module is imported and registered. server.ts
// (real process boot) and every Block-2/3 test call registerAllJobs()
// exactly once before creating a Worker — worker-runtime.ts's processor
// assumes the registry is populated; it does not call this itself, so a
// test can register a DIFFERENT/fake handler set instead when that's
// what the scenario needs (see jobs/registry.ts's resetRegistryForTests).

import { registerJob, resetRegistryForTests } from "./registry.js";
import { pingJob } from "./ping.job.js";
import { passportReadinessJob } from "./passport-readiness.job.js";
import { capacityFreshnessJob } from "./capacity-freshness.job.js";
import { rfqExpiryJob } from "./rfq-expiry.job.js";
import { economicsAccrualJob } from "./economics-accrual.job.js";

let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registerJob("worker.ping", pingJob);
  registerJob("passport-readiness", passportReadinessJob);
  registerJob("capacity-freshness", capacityFreshnessJob);
  registerJob("rfq-expiry", rfqExpiryJob);
  registerJob("economics-accrual", economicsAccrualJob);
  registered = true;
}

/** Test-only escape hatch — clears BOTH this module's own "already registered" flag and the underlying registry, so a test can call registerAllJobs() fresh after resetting. */
export function resetAllJobsForTests(): void {
  resetRegistryForTests();
  registered = false;
}
