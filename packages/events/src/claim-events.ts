// packages/events/src/claim-events.ts
//
// the spec names three Attribution events verbatim among its
// "Domain events" list: "claim.submitted; claim.verified; claim.disputed".
// Extended here with 4 more (claim.scored/claim.partial/claim.rejected/
// claim.dispute_decided) for full lifecycle coverage — same "match the
// representative names, extend for the rest" precedent
// rfq-events.ts/deal-events.ts already established for their own
// verticals (their own header comments cite the same reasoning).
//
// NAMING NOTE — a deliberate, acknowledged divergence: this build's own
// ClaimStatus enum (@tol/domain/src/claim-states.ts) uses "FILED", not
// "SUBMITTED", for the pre-scoring status — see that file's header
// comment for the reasoning (Journey A's own prose says "SEALED or
// SUBMITTED", ambiguous against Lockbox's unrelated SEALED state).
// Every OTHER vertical in this codebase (RFQ/DealRoom/Lockbox) names its
// events as the exact lowercase of its status enum values (SENT ->
// rfq.sent, LIVE -> deal.live, SEALED -> lockbox.sealed) — this file
// breaks that pattern on purpose for exactly one event: the FILED-time
// event is named "claim.submitted" (matching the spec's own verbatim
// word), not "claim.filed", because p.26's event list is a flat,
// unambiguous citation while Journey A's prose is the more ambiguous of
// the two conflicting sources this decision already had to resolve (see
// ADR-0010). Every other event name below other than this ONE
// still follows the standard lowercase-of-status pattern.

import type { DomainEventEnvelope } from "./envelope.js";

export const CLAIM_EVENT_TYPES = [
  "claim.submitted",
  "claim.scored",
  "claim.verified",
  "claim.partial",
  "claim.rejected",
  "claim.disputed",
  "claim.dispute_decided",
] as const;
export type ClaimEventType = (typeof CLAIM_EVENT_TYPES)[number];
export function isClaimEventType(value: string): value is ClaimEventType {
  return (CLAIM_EVENT_TYPES as readonly string[]).includes(value);
}

export interface ClaimSubmittedPayload {
  claimantOrgId: string;
  subjectOrgId: string;
  relationshipType: string;
  directnessTier: string;
  opportunityId: string | null;
}

/** Safe fields only — the full explainable breakdown lives on the Claim row itself (claim.read); the timeline event carries just enough to render "scored: 46.4 (strong/moderate/negligible)" without duplicating the whole breakdown object into a second, potentially-drifting copy. */
export interface ClaimScoredPayload {
  scoreTotal: number;
  algorithmVersion: string;
}

export interface ClaimDecisionPayload {
  reviewerOrgId: string;
  reason: string;
  /** Set only when this decision resolved a dispute rather than a fresh SCORED claim. */
  disputeId: string | null;
}

export interface ClaimDisputedPayload {
  challengerOrgId: string;
  basis: string;
}

export interface ClaimDisputeDecidedPayload {
  disputeId: string;
  resolution: string;
  reviewerOrgId: string;
}

/** Discriminated union — a switch over `eventType` narrows `payload` for free at every call site that builds one of these (apps/api's claims service). */
export type ClaimTimelineEvent =
  | DomainEventEnvelope<"claim.submitted", ClaimSubmittedPayload>
  | DomainEventEnvelope<"claim.scored", ClaimScoredPayload>
  | DomainEventEnvelope<"claim.verified", ClaimDecisionPayload>
  | DomainEventEnvelope<"claim.partial", ClaimDecisionPayload>
  | DomainEventEnvelope<"claim.rejected", ClaimDecisionPayload>
  | DomainEventEnvelope<"claim.disputed", ClaimDisputedPayload>
  | DomainEventEnvelope<"claim.dispute_decided", ClaimDisputeDecidedPayload>;
