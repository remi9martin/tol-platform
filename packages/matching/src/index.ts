// packages/matching — public surface. Consumers import ONLY from here via
// the @tol/matching workspace alias, never a deep path (the spec).
// Deep imports into @tol/matching/src/internal/... are forbidden.

export {
  ELIGIBILITY_RULE_FAMILIES,
  isEligibilityRuleFamily,
  RULE_RESULT_STATUSES,
  isRuleResultStatus,
  FRESHNESS_CLASSES,
  isFreshnessClassLike,
  PASSPORT_STATUSES,
  isPassportStatusLike,
  RANKING_FACTORS,
} from "./types.js";
export type {
  EligibilityRuleFamily,
  RuleResultStatus,
  RuleResult,
  FreshnessClassLike,
  PassportStatusLike,
  MatchOpportunityInput,
  MatchCommercialTerms,
  MatchCapacityInput,
  MerchantRiskProfileInput,
  MatchContext,
  EligibilityResult,
  RankingFactor,
  RankingFactorContribution,
  MatchRankingBreakdown,
  RankedMatch,
} from "./types.js";

export { MATCHING_CONFIG, overridableFor } from "./config.js";

export { EligibilityInputError, RankingInputError } from "./errors.js";

export { evaluateEligibility } from "./eligibility.js";

export { scoreMatch } from "./scoring.js";

export { rankMatches } from "./ranking.js";
