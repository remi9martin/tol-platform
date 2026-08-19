// packages/queue/src/enqueue.ts
//
// The ONLY BullMQ surface apps/api ever touches — every call site in
// apps/api's services calls one of the named functions below, never
// `queue.add()` directly, never imports `bullmq`/`ioredis` itself (not
// even as a devDependency — see apps/api/package.json). Every function
// here is "safe by construction": it catches its own failures and
// returns a result instead of throwing, because enqueueing is
// deliberately ADDITIVE — apps/worker's jobs extend, never replace, the
// synchronous on-read/on-write correctness apps/api's own transactions
// already provide (ADR-0011/ADR-0014) — a Redis hiccup during an
// enqueue call must never fail the HTTP request that triggered it.

import type { Job, JobsOptions } from "bullmq";
import { Queue } from "bullmq";
import { getProducerConnection } from "./connection.js";
import { WORKER_QUEUE_NAME, type WorkerJobName } from "./names.js";
import type { PassportReadinessJobData, CapacityFreshnessJobData, RfqExpiryJobData, EconomicsAccrualJobData } from "./job-data.js";

export interface EnqueueResult {
  enqueued: boolean;
  jobId?: string;
  error?: string;
}

let sharedQueue: Queue | undefined;
// Test-only — see setProducerQueueNameForTests's own doc comment for why
// this exists: every real production call site always targets the real
// WORKER_QUEUE_NAME, never this override.
let testQueueNameOverride: string | undefined;

function getQueue(): Queue {
  if (!sharedQueue) {
    sharedQueue = new Queue(testQueueNameOverride ?? WORKER_QUEUE_NAME, { connection: getProducerConnection() });
  }
  return sharedQueue;
}

// TData is deliberately unconstrained (not `extends Record<string,
// unknown>`) — a plain interface like PassportReadinessJobData has no
// index signature and doesn't structurally satisfy Record<string,
// unknown> under this repo's strict tsconfig even though every one of
// its properties is a valid value; BullMQ's own `.add()` accepts any
// plain object as job data, so there's no real constraint to enforce
// here beyond "an object," which TypeScript already gives for free.
/**
 * Real bug this file's own test caught: a connection-refused failure
 * surfaces as a Node `AggregateError` whose OWN `.message` is an empty
 * string — the actual detail lives on its `.errors` array (one entry per
 * address family Node tried, e.g. IPv6 then IPv4). A bare `err.message`
 * silently produced `""` — still a "failed" result (correct), just an
 * unhelpful one for whoever reads apps/api's own logs later trying to
 * understand WHY an enqueue failed. Falls back through `.errors` before
 * giving up to `String(err)`.
 */
function describeEnqueueError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

async function safeEnqueue<TData extends object>(name: WorkerJobName, data: TData, opts?: JobsOptions): Promise<EnqueueResult> {
  try {
    const job: Job<TData> = await getQueue().add(name, data, opts);
    return { enqueued: true, jobId: job.id };
  } catch (err) {
    return { enqueued: false, error: describeEnqueueError(err) };
  }
}

/** apps/api calls this on passport.created / passport.fact_updated / passport.evidence_added — the ADDITIVE, event-triggered leg of P6's readiness recompute (the scheduled sweep leg is apps/worker's own, never enqueued from here). */
export function enqueuePassportReadiness(passportId: string): Promise<EnqueueResult> {
  const data: PassportReadinessJobData = { passportId };
  return safeEnqueue("passport-readiness", data);
}

/** apps/api calls this on a real capacity update (CapacityProfile create/re-confirm) — the event-triggered leg of P8's freshness reclassification. */
export function enqueueCapacityFreshness(profileId: string): Promise<EnqueueResult> {
  const data: CapacityFreshnessJobData = { profileId };
  return safeEnqueue("capacity-freshness", data);
}

/**
 * apps/api calls this on RFQ creation, with a `delayMs` computed from
 * the RFQ's own `dueAt` — BullMQ's `opts.delay` schedules the job to
 * become available for processing at an EXACT future time, not on the
 * next periodic sweep pass. This is strictly additive precision on top
 * of apps/worker's own scheduled sweep (rfq-expiry.job.ts's own
 * `listOverdue` fallback still catches this RFQ even if the delayed job
 * were somehow lost — e.g. a Redis data-loss event between enqueue and
 * the delay elapsing — matching the FAILURE RULE's "never rely on
 * exactly one mechanism" spirit the rest of this day's work follows).
 * A non-positive/expired delayMs is clamped to 0 (fire immediately)
 * rather than rejected — a caller computing `dueAt - now` for an RFQ
 * whose due date is already in the past should still get an immediate
 * expiry attempt, not a silently-dropped enqueue.
 */
export function enqueueRfqExpiry(rfqId: string, delayMs: number): Promise<EnqueueResult> {
  const data: RfqExpiryJobData = { rfqId };
  return safeEnqueue("rfq-expiry", data, { delay: Math.max(0, delayMs) });
}

/** apps/api calls this RIGHT ALONGSIDE (never instead of) its own synchronous accrual computation, immediately after a RevenueEvent commits — the durable, retriable reconciliation leg economics-accrual.job.ts's own header comment documents in full. */
export function enqueueEconomicsAccrual(revenueEventId: string): Promise<EnqueueResult> {
  const data: EconomicsAccrualJobData = { revenueEventId };
  return safeEnqueue("economics-accrual", data);
}

export async function closeProducerQueue(): Promise<void> {
  if (sharedQueue) {
    await sharedQueue.close();
    sharedQueue = undefined;
  }
}

/** Test-only escape hatch. */
export function resetProducerQueueForTests(): void {
  sharedQueue = undefined;
}

/**
 * Test-only escape hatch — real bug this file's OWN test suite found
 * (earlier-stage work, review's own live-verification pass): before this
 * existed, enqueue.test.ts targeted the real, hardcoded WORKER_QUEUE_NAME
 * — indistinguishable from production apps/api traffic to any REAL
 * apps/worker process that happens to be alive in the same environment
 * (exactly the normal case in production, or a developer running
 * `pnpm dev` for the worker locally). A real worker would genuinely claim
 * and lock the job before the test's own `job.remove()` cleanup ran,
 * intermittently failing with "could not be removed because it is locked
 * by another worker," or racing the test's own `getState()` assertion
 * past "waiting" into "active." Every OTHER test file that exercises a
 * real queue in this codebase (apps/worker's own p17-*.test.ts files)
 * already uses a randomized, isolated queue name for exactly this reason
 * — this file had not. Clears the cached Queue instance too (same as
 * resetProducerQueueForTests), so the very next `getQueue()` call picks
 * up the new name immediately — a caller doesn't need to call both.
 */
export function setProducerQueueNameForTests(name: string | undefined): void {
  testQueueNameOverride = name;
  sharedQueue = undefined;
}
