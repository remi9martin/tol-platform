// packages/domain — public surface. apps/api's services import ONLY from
// here (the @tol/domain workspace alias), never a deep path (the spec).

export {
  MoneyInvariantError,
  assertIntegerMinorUnits,
  assertBigIntMinorUnits,
  parseBigIntMinorUnits,
  assertIntegerBps,
  assertCurrencyCode,
} from "./money.js";

export { DomainTransitionError } from "./transition-error.js";

export {
  OPPORTUNITY_STATUSES,
  isOpportunityStatus,
  InvalidOpportunityTransitionError,
  assertValidOpportunityTransition,
} from "./opportunity-states.js";
export type { OpportunityStatus } from "./opportunity-states.js";

export {
  RFQ_STATUSES,
  isRfqStatus,
  assertValidRfqTransition,
  RFQ_RECIPIENT_STATES,
  isRfqRecipientState,
  assertValidRfqRecipientTransition,
  QUOTE_STATUSES,
  isQuoteStatus,
  assertValidQuoteTransition,
  InvalidRfqTransitionError,
} from "./rfq-states.js";
export type { RfqStatus, RfqRecipientState, QuoteStatus } from "./rfq-states.js";

export {
  DEAL_ROOM_STATUSES,
  isDealRoomStatus,
  assertValidDealRoomTransition,
  DEAL_CONDITION_STATES,
  isDealConditionState,
  assertValidDealConditionTransition,
  DEAL_DECISION_TYPES,
  isDealDecisionType,
  InvalidDealTransitionError,
} from "./deal-states.js";
export type { DealRoomStatus, DealConditionState, DealDecisionType } from "./deal-states.js";

// ---- earlier: Lockbox (P9) ----
export {
  LOCKBOX_STATUSES,
  isLockboxStatus,
  assertValidLockboxTransition,
  LOCKBOX_RELEASE_CASCADE,
  assertValidLockboxReleaseCascade,
  canWithdrawFrom,
  InvalidLockboxTransitionError,
  LOCKBOX_RELATIONSHIP_TYPES,
  isLockboxRelationshipType,
  LOCKBOX_REGIONS,
  isLockboxRegion,
  LOCKBOX_SHARE_ROLES,
  isLockboxShareRole,
} from "./lockbox-states.js";
export type { LockboxStatus, LockboxRelationshipType, LockboxRegion, LockboxShareRole } from "./lockbox-states.js";

// ---- earlier: Attribution (P10) ----
export {
  DIRECTNESS_TIERS,
  isDirectnessTier,
  CLAIM_EVIDENCE_TYPES,
  isClaimEvidenceType,
  EVIDENCE_VERIFICATION_STATES,
  isEvidenceVerificationState,
  CLAIM_STATUSES,
  isClaimStatus,
  assertValidClaimTransition,
  CLAIM_DISPUTE_STATUSES,
  isClaimDisputeStatus,
  assertValidClaimDisputeTransition,
  CLAIM_DISPUTE_RESOLUTIONS,
  isClaimDisputeResolution,
  CLAIM_DECISION_OUTCOMES,
  isClaimDecisionOutcome,
  CLAIM_APPEAL_STATUSES,
  isClaimAppealStatus,
  isClaimProvisionalExpired,
  InvalidClaimTransitionError,
} from "./claim-states.js";
export type {
  DirectnessTier,
  ClaimEvidenceType,
  EvidenceVerificationState,
  ClaimStatus,
  ClaimDisputeStatus,
  ClaimDisputeResolution,
  ClaimDecisionOutcome,
  ClaimAppealStatus,
} from "./claim-states.js";

// ---- earlier: P6 Passport ----
export {
  PASSPORT_STATUSES,
  isPassportStatus,
  assertValidPassportTransition,
  InvalidPassportTransitionError,
  isPassportReadinessStale,
  targetStatusAfterRecompute,
  FRESHNESS_CLASSES,
  isFreshnessClass,
  FACT_PROVENANCE_STATES,
  isFactProvenance,
  PASSPORT_SECTION_TYPES,
  isPassportSectionType,
  EVIDENCE_SOURCE_KINDS,
  isEvidenceSourceKind,
} from "./passport-states.js";
export type { PassportStatus, FreshnessClass, FactProvenance, PassportSectionType, EvidenceSourceKind } from "./passport-states.js";

// ---- earlier: P7 Opportunity volume reconciliation ----
export { reconcileOpportunityVolume } from "./volume-reconciliation.js";
export type {
  VolumeSliceInput,
  OpportunityVolumeSummary,
  VolumeMismatchCode,
  VolumeMismatch,
  VolumeReconciliationResult,
} from "./volume-reconciliation.js";

// ---- earlier: Economics (P15) ----
export {
  COMMISSION_SCHEDULE_STATUSES,
  isCommissionScheduleStatus,
  assertValidCommissionScheduleTransition,
  InvalidCommissionScheduleTransitionError,
  COMMISSION_BASIS_VALUES,
  isCommissionBasis,
  COMMISSION_RECIPIENT_TYPES,
  isCommissionRecipientType,
  COMMISSION_COMPONENT_TYPES,
  isCommissionComponentType,
  LEDGER_ENTRY_TYPES,
  isLedgerEntryType,
  LEDGER_DIRECTIONS,
  isLedgerDirection,
  ACCRUAL_DERIVED_STATUSES,
  isAccrualDerivedStatus,
} from "./economics-states.js";
export type {
  CommissionScheduleStatus,
  CommissionBasis,
  CommissionRecipientType,
  CommissionComponentType,
  LedgerEntryType,
  LedgerDirection,
  AccrualDerivedStatus,
} from "./economics-states.js";

export {
  ECONOMICS_ENGINE_VERSION,
  EconomicsInvariantError,
  computeCommissionSplits,
  selectComponentsForBasis,
  computeAccrualBalance,
  reconcileRevenueEvent,
  evaluateScheduleCapFloor,
} from "./economics-engine.js";
export type {
  EconomicsComponentInput,
  ComputedLedgerEntry,
  ComputeCommissionSplitsInput,
  ComputeCommissionSplitsResult,
  AccrualLedgerEntryLike,
  AccrualBalance,
  RevenueEventMismatchCode,
  RevenueEventMismatch,
  RevenueEventReconciliationInput,
  RevenueEventReconciliation,
  ScheduleCapFloorInput,
  ScheduleCapFloorStatus,
} from "./economics-engine.js";
