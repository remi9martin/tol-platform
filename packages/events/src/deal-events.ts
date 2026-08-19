// packages/events/src/deal-events.ts
//
// the spec names "condition.created; deal.activated; deal.live"
// verbatim among its representative domain events. p.22's Deal Room
// surfaces ("Conditions: owner, evidence, due date, blocking state,
// resolution history"; "Decisions: quote selection, approvals, declines,
// exceptions and rationale") motivate the rest — this is the FULL event
// catalog P14's "conditions + decisions + timeline" exit condition needs,
// not just p.26's own representative subset (that page's own heading
// calls its list "Representative endpoints" — extending it for a named
// gate's exit condition is consistent with that framing, not a
// deviation from it). `deal.activated`/`deal.live` are modeled (types
// exist) but not emitted by an earlier apps/api code — @tol/domain's
// DealRoomStatus ACTIVATION/LIVE values have the same "modeled, not
// reached this day" status, for the same reason (see that file's header).

import type { DealRoomStatus } from "@tol/domain";
import type { DomainEventEnvelope } from "./envelope.js";

export const DEAL_EVENT_TYPES = [
  "deal.opened",
  "deal.participant_added",
  "deal.condition_created",
  "deal.condition_resolved",
  "deal.decision_recorded",
  "deal.stage_changed",
  "deal.activated",
  "deal.live",
  "deal.archived",
] as const;
export type DealEventType = (typeof DEAL_EVENT_TYPES)[number];
export function isDealEventType(value: string): value is DealEventType {
  return (DEAL_EVENT_TYPES as readonly string[]).includes(value);
}

// Named, EXPORTED union types (not inlined into each payload interface) —
// tightened after review (review,
// 2026-08-18) correctly flagged that an inline union forces any consumer
// wanting the same closed set to redefine it. These are this package's
// OWN copy of the vocabulary, not an import of @tol/db's Prisma-generated
// enum — same "no dependency on a sibling package's generated types"
// discipline @tol/authz's roles.ts documents for PersonaRole/
// DisclosureClass (packages/authz/src/roles.ts's file header).
export const DEAL_PARTICIPANT_ROLE_NAMES = ["MERCHANT", "PROVIDER", "OPERATOR"] as const;
export type DealParticipantRoleName = (typeof DEAL_PARTICIPANT_ROLE_NAMES)[number];

export const DEAL_CONDITION_RESOLUTION_STATES = ["SATISFIED", "WAIVED", "REJECTED"] as const;
export type DealConditionResolutionState = (typeof DEAL_CONDITION_RESOLUTION_STATES)[number];

export const DEAL_DECISION_TYPE_NAMES = ["QUOTE_SELECTED", "APPROVAL", "DECLINE", "EXCEPTION"] as const;
export type DealDecisionTypeName = (typeof DEAL_DECISION_TYPE_NAMES)[number];

export interface DealOpenedPayload {
  opportunityId: string;
  rfqId: string;
  selectedQuoteId: string;
  merchantOrgId: string;
  providerOrgId: string;
}
export interface DealParticipantAddedPayload {
  organizationId: string;
  participantRole: DealParticipantRoleName;
}
export interface DealConditionCreatedPayload {
  conditionId: string;
  ownerOrgId: string;
  blocking: boolean;
}
export interface DealConditionResolvedPayload {
  conditionId: string;
  state: DealConditionResolutionState;
}
export interface DealDecisionRecordedPayload {
  decisionId: string;
  decisionType: DealDecisionTypeName;
  relatedQuoteId?: string | null;
}
/**
 * `from`/`to` are typed as the REAL @tol/domain DealRoomStatus (not a
 * bare `string`) — tightened after review correctly flagged an
 * unbounded string as able to record a stage name the actual state
 * machine (@tol/domain/src/deal-states.ts) doesn't recognize. This event
 * is still only ever a RECORD of a transition @tol/domain's
 * assertValidDealRoomTransition already validated before the event was
 * constructed (apps/api's deals service, this stage) — the type tightening
 * catches a typo at compile time, it doesn't re-run the transition check.
 */
export interface DealStageChangedPayload {
  from: DealRoomStatus;
  to: DealRoomStatus;
}
export interface DealActivatedPayload {
  activatedAt: string;
}
export interface DealLivePayload {
  liveAt: string;
}
export interface DealArchivedPayload {
  archivedAt: string;
}

export type DealTimelineEvent =
  | DomainEventEnvelope<"deal.opened", DealOpenedPayload>
  | DomainEventEnvelope<"deal.participant_added", DealParticipantAddedPayload>
  | DomainEventEnvelope<"deal.condition_created", DealConditionCreatedPayload>
  | DomainEventEnvelope<"deal.condition_resolved", DealConditionResolvedPayload>
  | DomainEventEnvelope<"deal.decision_recorded", DealDecisionRecordedPayload>
  | DomainEventEnvelope<"deal.stage_changed", DealStageChangedPayload>
  | DomainEventEnvelope<"deal.activated", DealActivatedPayload>
  | DomainEventEnvelope<"deal.live", DealLivePayload>
  | DomainEventEnvelope<"deal.archived", DealArchivedPayload>;
