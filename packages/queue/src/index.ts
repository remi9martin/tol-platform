// packages/queue — public surface. apps/api and apps/worker import ONLY
// from here (the @tol/queue workspace alias), never a deep path (scope
// p.7).

export { WORKER_QUEUE_NAME, WORKER_JOB_NAMES, isWorkerJobName } from "./names.js";
export type { WorkerJobName } from "./names.js";

export type { PassportReadinessJobData, CapacityFreshnessJobData, RfqExpiryJobData, EconomicsAccrualJobData, PingJobData } from "./job-data.js";

export { getProducerConnection, disconnectProducerConnection, resetProducerConnectionForTests } from "./connection.js";

export {
  enqueuePassportReadiness,
  enqueueCapacityFreshness,
  enqueueRfqExpiry,
  enqueueEconomicsAccrual,
  closeProducerQueue,
  resetProducerQueueForTests,
} from "./enqueue.js";
export type { EnqueueResult } from "./enqueue.js";
