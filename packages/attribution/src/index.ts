// packages/attribution — public surface. Consumers import ONLY from here
// via the @tol/attribution workspace alias, never a deep path (scope
// p.7). Zero runtime dependencies (same discipline as @tol/domain/
// @tol/authz/@tol/crypto — see README.md).

export {
  DIRECTNESS_TIERS,
  isDirectnessTier,
  DIRECTNESS_TIER_LABELS,
  CLAIM_EVIDENCE_TYPES,
  isClaimEvidenceType,
  EVIDENCE_VERIFICATION_STATES,
  isEvidenceVerificationState,
} from "./types.js";
export type {
  DirectnessTier,
  ClaimEvidenceType,
  EvidenceVerificationState,
  ClaimEvidenceInput,
  ClaimEvidenceContribution,
  ClaimScoringInput,
  ClaimScoreBreakdown,
} from "./types.js";

export { ATTRIBUTION_CONFIG } from "./config.js";

export { ClaimScoringInputError, scoreClaim, scoreEvidence } from "./scoring.js";
export type { EvidenceScoreResult } from "./scoring.js";

export { rankClaims, ClaimRankingInputError } from "./ranking.js";
export type { RankableClaim, ClaimRankEntry } from "./ranking.js";

export { ATTRIBUTION_TIERS, attributionTier } from "./tier.js";
export type { AttributionTier } from "./tier.js";
