// packages/events — public surface. apps/api's services import ONLY from
// here (the @tol/events workspace alias), never a deep path (the spec).

export type { DomainEventEnvelope } from "./envelope.js";
export { buildDomainEvent } from "./envelope.js";

export {
  RFQ_EVENT_TYPES,
  isRfqEventType,
} from "./rfq-events.js";
export type {
  RfqEventType,
  RfqTimelineEvent,
  RfqSentPayload,
  RfqAcknowledgedPayload,
  RfqDeclinedPayload,
  RfqExpiredPayload,
  QuoteSubmittedPayload,
  QuoteWithdrawnPayload,
  QuoteSelectedPayload,
} from "./rfq-events.js";

export {
  DEAL_EVENT_TYPES,
  isDealEventType,
  DEAL_PARTICIPANT_ROLE_NAMES,
  DEAL_CONDITION_RESOLUTION_STATES,
  DEAL_DECISION_TYPE_NAMES,
} from "./deal-events.js";
export type {
  DealEventType,
  DealTimelineEvent,
  DealParticipantRoleName,
  DealConditionResolutionState,
  DealDecisionTypeName,
  DealOpenedPayload,
  DealParticipantAddedPayload,
  DealConditionCreatedPayload,
  DealConditionResolvedPayload,
  DealDecisionRecordedPayload,
  DealStageChangedPayload,
  DealActivatedPayload,
  DealLivePayload,
  DealArchivedPayload,
} from "./deal-events.js";

// ---- earlier: Lockbox ----
export { LOCKBOX_EVENT_TYPES, isLockboxEventType } from "./lockbox-events.js";
export type {
  LockboxEventType,
  LockboxTimelineEvent,
  LockboxSealedPayload,
  LockboxCommittedPayload,
  LockboxWithdrawnPayload,
  LockboxOpenedPayload,
} from "./lockbox-events.js";

// ---- earlier: Attribution ----
export { CLAIM_EVENT_TYPES, isClaimEventType } from "./claim-events.js";
export type {
  ClaimEventType,
  ClaimTimelineEvent,
  ClaimSubmittedPayload,
  ClaimScoredPayload,
  ClaimDecisionPayload,
  ClaimDisputedPayload,
  ClaimDisputeDecidedPayload,
} from "./claim-events.js";

// ---- earlier: Passport (P6) ----
export { PASSPORT_EVENT_TYPES, isPassportEventType } from "./passport-events.js";
export type {
  PassportEventType,
  PassportTimelineEvent,
  PassportCreatedPayload,
  PassportFactUpdatedPayload,
  PassportEvidenceAddedPayload,
  PassportReadinessComputedPayload,
  PassportVerifiedPayload,
  PassportStatusChangedPayload,
} from "./passport-events.js";

// ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
export { MATCHING_EVENT_TYPES, isMatchingEventType } from "./matching-events.js";
export type { MatchingEventType, MatchingTimelineEvent, MatchComputedPayload } from "./matching-events.js";

// ---- earlier: Economics (P15) ----
export { ECONOMICS_EVENT_TYPES, isEconomicsEventType } from "./economics-events.js";
export type {
  EconomicsEventType,
  EconomicsTimelineEvent,
  EconomicsScheduleEventPayload,
  CommissionAccruedPayload,
  CommissionPaidPayload,
  CommissionAdjustedPayload,
} from "./economics-events.js";

// ---- earlier: Capacity (P8) gap-fix — see capacity-events.ts's own header ----
export { CAPACITY_EVENT_TYPES, isCapacityEventType } from "./capacity-events.js";
export type { CapacityEventType, CapacityTimelineEvent, CapacityFreshnessRecomputedPayload } from "./capacity-events.js";
