// packages/queue/src/job-data.ts
//
// earlier: moved here from each apps/worker/src/jobs/*.job.ts file (Block
// 4) — same reasoning as names.ts. apps/api needs these exact shapes to
// construct correctly-typed enqueue payloads; duplicating them locally
// in apps/api would let the two sides' definitions silently drift.

/** Specific passport (event-triggered — apps/api enqueues this on passport.created/fact_updated/evidence_added). Omit for a full sweep — apps/worker's own scheduled trigger, never enqueued by apps/api. */
export interface PassportReadinessJobData {
  passportId?: string;
}

/** Specific profile (event-triggered — apps/api enqueues this on a capacity update). Omit for a full sweep. */
export interface CapacityFreshnessJobData {
  profileId?: string;
}

/** Specific RFQ, with an optional scheduling delay apps/api sets to exactly match dueAt (see enqueue.ts's enqueueRfqExpiry — a delayed BullMQ job fires precisely when due, not on the next sweep pass). Omit rfqId for the scheduled sweep (apps/worker's own fallback trigger, never enqueued this shape by apps/api). */
export interface RfqExpiryJobData {
  rfqId?: string;
}

/** Always specific — money is per-RevenueEvent, never swept in bulk. */
export interface EconomicsAccrualJobData {
  revenueEventId: string;
}

export interface PingJobData {
  nonce: string;
  /** Test-only knob: when set, the handler awaits a promise that resolves after this many ms BEFORE returning. Never set by production apps/api call sites. */
  delayMs?: number;
}
