// packages/events/src/capacity-events.ts
//
// earlier gap-fix, same category as the economics-events.ts note: every
// other domain area in this codebase (RFQ, Deal Room, Lockbox, Claim,
// Passport, Matching, Economics) has its own typed DomainEvent catalog
// file; CapacityProfile (P8) never got one — apps/api's capacity/service.ts
// writes an AuditEvent on create() but has never written a DomainEvent at
// all (a genuine, pre-existing gap, not something earlier introduced —
// noted honestly in this day's review/the build log rather than
// silently left unexplained). apps/worker's own capacity-freshness job
// (earlier) needs a real, typed event to write when it reclassifies a
// profile's freshness in the background — this file is that one addition,
// matching matching-events.ts's precedent for a single-event-type domain
// (no the spec verbatim name exists for this one either; "*.freshness_
// recomputed" follows the exact past-tense-dot-namespaced convention
// every other catalog in this package already uses).

import type { DomainEventEnvelope } from "./envelope.js";

export const CAPACITY_EVENT_TYPES = ["capacity_profile.freshness_recomputed"] as const;
export type CapacityEventType = (typeof CAPACITY_EVENT_TYPES)[number];
export function isCapacityEventType(value: string): value is CapacityEventType {
  return (CAPACITY_EVENT_TYPES as readonly string[]).includes(value);
}

export interface CapacityFreshnessRecomputedPayload {
  providerOrgId: string;
  previousFreshnessClass: string;
  newFreshnessClass: string;
  /** "sweep" (scheduled background pass) or "event" (apps/api enqueued this on a capacity update, this stage) — lets a timeline reader distinguish a proactive worker reclassification from one triggered by an actual provider action. */
  trigger: string;
}

export type CapacityTimelineEvent = DomainEventEnvelope<"capacity_profile.freshness_recomputed", CapacityFreshnessRecomputedPayload>;
