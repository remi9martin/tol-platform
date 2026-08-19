// packages/events/src/matching-events.ts
//
// the spec names exactly one Matching event verbatim among its "Domain
// events" list: "match.computed". Unlike Claims/RFQ/Deal Room (which have
// several genuinely distinct lifecycle moments — filed, scored, disputed,
// decided), one matching.evaluate call is a SINGLE atomic action that
// produces N MatchResult rows (one per candidate capacity) all at once —
// there is no natural sub-lifecycle to name additional events for, so
// this file stays at the scope's own one named event, not extended the
// way claim-events.ts/rfq-events.ts were (their own header comments
// explain why THEY needed more).

import type { DomainEventEnvelope } from "./envelope.js";

export const MATCHING_EVENT_TYPES = ["match.computed"] as const;
export type MatchingEventType = (typeof MATCHING_EVENT_TYPES)[number];
export function isMatchingEventType(value: string): value is MatchingEventType {
  return (MATCHING_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Safe, summary fields only — same discipline as ClaimScoredPayload
 * (packages/events/src/claim-events.ts): the full per-candidate
 * explainable breakdown lives on each MatchResult row itself
 * (match.read/match.list), not duplicated into the timeline event.
 */
export interface MatchComputedPayload {
  opportunityId: string;
  candidateCount: number;
  eligibleCount: number;
  ruleVersion: string;
  algorithmVersion: string;
}

export type MatchingTimelineEvent = DomainEventEnvelope<"match.computed", MatchComputedPayload>;
