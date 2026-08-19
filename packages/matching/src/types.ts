// packages/matching/src/types.ts
//
// the spec (Eligibility Engine — Deterministic Hard Filters) + p.20
// (Ranking & Optimization Engine — Explainable Private Matching).
// @tol/matching has ZERO runtime dependencies (same discipline as
// @tol/domain/@tol/authz/@tol/crypto/@tol/attribution/@tol/evidence —
// see this package's README) — every type below is this package's OWN
// copy of the fields it actually reads off Opportunity/CapacityProfile,
// never an import of @tol/db's Prisma types or @tol/contracts' zod-
// inferred types. apps/api's matching module (this stage) is responsible
// for mapping a real Opportunity/CapacityProfile row (and a real
// Passport ReadinessResult, per @tol/evidence) onto these plain shapes
// before calling into this package — same "pure, zero-DB" boundary as
// @tol/attribution's ClaimScoringInput / @tol/evidence's
// CapacityFreshnessInput.
//
// Money fields keep the SAME Int-vs-BigInt split schema.prisma itself
// uses (ADR-0008 part 3): volume-scale figures (GPV, monthly
// capacity) are `bigint`; bounded, per-transaction/bps figures are
// `number`.

// =================================================================
// Eligibility (the spec)
// =================================================================

/**
 * The ten rule families named verbatim in the spec's own table
 * (Rule family || Examples || Result). Not every family has a real,
 * schema-backed check yet in this build — see eligibility.ts's own
 * per-rule doc comments for exactly which ones are fully evaluable
 * today versus documented, deliberate "thin but honest" stand-ins
 * (same discipline as ADR-0008/ADR-0009/ADR-0010/ADR-0011's own named scope
 * cuts). Every family still appears at least once in a real
 * evaluation's `results` array — never silently omitted.
 */
export const ELIGIBILITY_RULE_FAMILIES = [
  "ROLE",
  "JURISDICTION",
  "MCC_PRODUCT",
  "VOLUME_TICKET",
  "EVIDENCE_LICENSE",
  "RISK",
  "SETTLEMENT",
  "TECHNICAL",
  "FRESHNESS",
  "COMPLIANCE_HOLD",
] as const;
export type EligibilityRuleFamily = (typeof ELIGIBILITY_RULE_FAMILIES)[number];
export function isEligibilityRuleFamily(value: string): value is EligibilityRuleFamily {
  return (ELIGIBILITY_RULE_FAMILIES as readonly string[]).includes(value);
}

/**
 * the spec's own "Result" column vocabulary, unioned with PASS (the
 * scope's table only lists FAILURE outcomes — PASS is this package's own
 * necessary addition so a rule that didn't fail has something to report
 * too, since the spec also requires "Every blocker exposes a safe
 * explanation" which implies a full per-rule trace, not just a bare
 * boolean) plus UNKNOWN (the spec verbatim: "Unknown values are never
 * silently treated as pass. Rules define UNKNOWN behavior explicitly.").
 */
export const RULE_RESULT_STATUSES = ["PASS", "INELIGIBLE", "BLOCKED", "REFRESH_REQUIRED", "UNKNOWN"] as const;
export type RuleResultStatus = (typeof RULE_RESULT_STATUSES)[number];
export function isRuleResultStatus(value: string): value is RuleResultStatus {
  return (RULE_RESULT_STATUSES as readonly string[]).includes(value);
}

/**
 * One rule family's finding. `blocking: true` means this finding, if its
 * `status` isn't PASS, prevents `eligible` from being true (it lands in
 * `EligibilityResult.blockers`); `blocking: false` with a non-PASS status
 * lands in `EligibilityResult.warnings` instead — a heads-up that never
 * by itself flips `eligible` to false (e.g. an AGING — not yet STALE —
 * capacity profile). `overridable` mirrors the spec verbatim: "Operator
 * override is possible only for overridable warnings/blocks; prohibited
 * rules can be marked NON_OVERRIDABLE" — WHICH specific codes are
 * overridable is this build's own documented config
 * (config.ts#overridableByCode), since the scope names the mechanism but
 * not the per-rule mapping. `message` is written to be safe for the
 * audience that will see it (the spec: "without leaking private
 * provider appetite") — it names WHAT failed and the comparison inputs
 * already visible to the caller, never a private commercial figure that
 * wasn't already in the request.
 */
export interface RuleResult {
  rule: EligibilityRuleFamily;
  /** Specific, machine-readable reason code, e.g. "JURISDICTION_NO_OVERLAP" — see eligibility.ts for the full set. */
  code: string;
  status: RuleResultStatus;
  blocking: boolean;
  overridable: boolean;
  message: string;
}

/** This package's own closed copy of @tol/evidence's FreshnessClass vocabulary (the spec) — duplicated, not imported, per this package's zero-runtime-deps discipline (same precedent as @tol/domain's lockbox-states.ts duplicating @tol/crypto's LockboxShareRole, cross-checked by a dedicated test rather than a shared import). */
export const FRESHNESS_CLASSES = ["FRESH", "AGING", "STALE", "UNKNOWN"] as const;
export type FreshnessClassLike = (typeof FRESHNESS_CLASSES)[number];
export function isFreshnessClassLike(value: string): value is FreshnessClassLike {
  return (FRESHNESS_CLASSES as readonly string[]).includes(value);
}

/** This package's own closed copy of @tol/domain's PassportStatus vocabulary (the spec) — same duplication precedent as FreshnessClassLike above. Used only as the EVIDENCE_LICENSE rule's input; this package has no opinion on Passport's own transition rules. */
export const PASSPORT_STATUSES = ["DRAFT", "INCOMPLETE", "READY", "VERIFIED", "STALE", "SUSPENDED"] as const;
export type PassportStatusLike = (typeof PASSPORT_STATUSES)[number];
export function isPassportStatusLike(value: string): value is PassportStatusLike {
  return (PASSPORT_STATUSES as readonly string[]).includes(value);
}

/** The fields evaluateEligibility/scoreMatch actually read off an Opportunity (the spec), not the full row. */
export interface MatchOpportunityInput {
  id: string;
  /** ISO 4217, 3-letter. */
  currency: string;
  jurisdictions: readonly string[];
  mccs: readonly string[];
  /**
   * Volume-scale (bigint), denominated in MINOR UNITS of this same
   * object's `currency` field (never a bare cross-currency number —
   * same "money || integer minor units + ISO currency" pairing rule as
   * every other money field in this codebase, the spec). This package
   * treats the near-term 30-day movable-volume figure
   * (Opportunity.movable30dMinor — p.15's Movability.newIncrementalExpected
   * 30-day figure) as "monthly demand" for capacity-headroom
   * comparisons — it is literally the volume this opportunity expects to
   * be ABLE to move within a month, which is a closer match to "monthly
   * capacity headroom" than the portfolio's full annual/total GPV
   * figures would be. Documented inference (the scope doesn't spell out
   * which of Opportunity's seven money fields feeds this specific
   * comparison) — see eligibility.ts's VOLUME_TICKET rule doc comment.
   * Never compared numerically against a CapacityProfile whose
   * `currency` differs (see MatchCapacityInput.currency) — every call
   * site checks currency equality first (eligibility.ts's
   * checkVolumeTicket, scoring.ts's scoreVolumeTicketFit) and falls back
   * to an explicit UNKNOWN/neutral result rather than dividing
   * mismatched-currency minor-unit figures, which would silently produce
   * a meaningless ratio.
   */
  movable30dMinor: bigint;
}

/** the spec's CommercialTermTemplate, exact shape validated at @tol/contracts/src/capacity.ts's CommercialTermsSchema — duplicated here (not imported, zero-runtime-deps) since it's the one piece of CapacityProfile this package's COMMERCIAL_UTILITY ranking factor needs to read. */
export interface MatchCommercialTerms {
  mdrBps: number;
  fixedFeeMinor: number;
  model: "blended" | "interchange_plus" | "flat";
}

/** The fields evaluateEligibility/scoreMatch actually read off a CapacityProfile (the spec), not the full row. */
export interface MatchCapacityInput {
  id: string;
  currency: string;
  jurisdictions: readonly string[];
  mccsAccepted: readonly string[];
  mccsExcluded: readonly string[];
  acceptingNewVolume: boolean;
  monthlyCapacityMinor: bigint;
  minTicketMinor: number;
  maxTicketMinor: number;
  maxChargebackBps: number;
  maxFraudBps: number;
  maxRefundBps: number;
  settlementRail: string;
  settlementCadenceDays: number;
  /** Server-computed by @tol/evidence's classifyCapacityFreshness (earlier, P8) — never client-asserted. This package trusts whatever value the caller passes; it does not recompute freshness itself (that engine already exists and is out of this package's scope). */
  freshnessClass: FreshnessClassLike;
  commercialTerms: MatchCommercialTerms | null;
}

/**
 * Merchant/opportunity-side risk history, typically resolved by the
 * caller from the merchant's own Passport RISK-section Facts
 * (@tol/evidence / PassportSectionType.RISK) — this package doesn't
 * import @tol/evidence or know anything about Fact/Passport internals
 * (zero-runtime-deps), it just accepts already-extracted numbers.
 * Genuinely absent (a brand-new merchant with no processed volume yet)
 * is a normal, EXPECTED state, not a data-integrity gap — see
 * eligibility.ts's RISK rule and ranking.ts's riskHistoryFit factor for
 * why this is handled as a neutral, non-blocking default rather than a
 * fail-closed UNKNOWN (unlike EVIDENCE_LICENSE, below, where the
 * underlying system DOES already exist and a missing lookup is treated
 * as a caller oversight, not a legitimate absence).
 */
export interface MerchantRiskProfileInput {
  chargebackBps?: number;
  fraudBps?: number;
  refundBps?: number;
}

/**
 * Third parameter shared by both evaluateEligibility and scoreMatch/
 * rankMatches (scope's own contract sketch, p.19, names a third
 * `ruleSet` parameter to evaluateEligibility; this package generalizes
 * it slightly to also carry the few extra inputs ranking needs, so a
 * caller builds ONE context object per matching pass rather than two
 * slightly-different ones — see README.md for the full reasoning).
 *
 * `now` is REQUIRED and never defaulted to `new Date()` internally —
 * same "inject the clock, never read it" discipline as
 * @tol/evidence's classifyCapacityFreshness/classifyFactFreshness —
 * so "identical inputs -> identical output, called any number of
 * times" (the spec) holds for `evaluatedAt` too, not just the rule
 * verdicts.
 */
export interface MatchContext {
  now: Date;
  /** EVIDENCE_LICENSE rule input (the spec's "Evidence/license" row) — the PROVIDER's own Passport status (earlier, packages/evidence's real readiness engine). Absent is treated as fail-closed (BLOCKED) — the real system exists, so a caller that omits this is treated as not yet having looked it up, matching this codebase's deny-by-default discipline (@tol/authz). */
  providerPassportStatus?: PassportStatusLike;
  /** RISK rule input + riskHistoryFit ranking factor input. Absent -> neutral, non-blocking (see MerchantRiskProfileInput's own doc comment for why this is NOT fail-closed, unlike providerPassportStatus above). */
  merchantRiskProfile?: MerchantRiskProfileInput;
  /** Supplementary VOLUME_TICKET sub-check. Opportunity's own schema carries no ticket-size field at all (thin schema, ADR-0008 part 2) — structurally absent, not merely sometimes-missing — so omitting this yields an explicit non-blocking UNKNOWN finding, never a silent pass AND never a hard block (see eligibility.ts's VOLUME_TICKET rule doc comment for the "structurally-absent-from-schema" vs "operationally-should-be-present" distinction this package draws throughout). */
  averageTicketMinor?: number;
  /** Supplementary SETTLEMENT sub-check — only evaluated when supplied. */
  requiredSettlementRail?: string;
  /** COMPLIANCE_HOLD rule input. No compliance/sanctions-screening system exists in this repo yet (P17/connectors unbuilt) — absent is treated as "no known hold" (PASS), the one deliberate exception to this package's general fail-closed-on-missing-mandatory-input stance, because failing closed here with no real data source behind it would make the gate permanently unsatisfiable rather than honestly reflecting "nothing to report yet". Documented, not silent — see eligibility.ts's COMPLIANCE_HOLD rule doc comment. */
  complianceHold?: { active: boolean; reason?: string };
  /** the spec: "A rule change creates a new immutable RuleSetVersion." Defaults to MATCHING_CONFIG.ruleVersion when omitted. */
  ruleVersion?: string;
  /** the spec provenance chain — echoed back verbatim on both EligibilityResult and MatchRankingBreakdown (same discipline as @tol/attribution's ClaimScoringInput.inputVersions). */
  inputVersions?: readonly string[];
}

/** the spec's own evaluateEligibility() return shape, verbatim field names (`eligible`, `blockers`, `warnings`, `ruleVersion`, `inputVersions`, `evaluatedAt`) — see eligibility.ts's file header for why this package follows the SCOPE's contract exactly rather than the earlier task brief's own paraphrased sketch (`failedRules`) where the two disagree. */
export interface EligibilityResult {
  eligible: boolean;
  /** Every rule finding, PASS or not — full transparency, not just the failures (a caller/UI can render the complete rule trace, matching @tol/attribution's own "explainable in full, not just the total" precedent). */
  results: readonly RuleResult[];
  /** Non-PASS findings with `blocking: true` — exactly the findings that make `eligible` false. Empty iff `eligible` is true. */
  blockers: readonly RuleResult[];
  /** Non-PASS findings with `blocking: false` — never affect `eligible` on their own. */
  warnings: readonly RuleResult[];
  ruleVersion: string;
  inputVersions: readonly string[];
  /** ISO-8601, echoes `context.now` verbatim — see MatchContext.now's doc comment on why this is injected, not internally read. */
  evaluatedAt: string;
}

// =================================================================
// Ranking (the spec)
// =================================================================

/** the spec's ranking factor table, verbatim order and names (camelCased). Must have exactly nine entries whose MATCHING_CONFIG weights sum to 1 — config.ts's assertRankingWeightsSumToOne() enforces this at module load. */
export const RANKING_FACTORS = [
  "mccProductFit",
  "geographyLicensingFit",
  "volumeTicketFit",
  "riskHistoryFit",
  "settlementCurrencyFit",
  "commercialUtility",
  "technicalLaunchFit",
  "providerReliabilityFreshness",
  "outcomeCalibratedLikelihood",
] as const;
export type RankingFactor = (typeof RANKING_FACTORS)[number];

/** Per-factor explainability record — WHY this factor contributed exactly this many points, mirroring @tol/attribution's ClaimEvidenceContribution precedent (per-item transparency alongside the total, not just the total). */
export interface RankingFactorContribution {
  factor: RankingFactor;
  /** This factor's own 0-100 normalized score, before weighting. */
  score: number;
  /** the spec's own weight table value for this factor, e.g. 0.22 for mccProductFit. Echoed per-contribution (not just once at the top level) so a UI can render "22% x 87.0 = 19.1" without cross-referencing MATCHING_CONFIG separately. */
  weight: number;
  /** score * weight, rounded — this factor's actual contribution to `total`. */
  contribution: number;
  /** Safe, human-readable explanation of how `score` was derived — the EXPLAINABLE half of "explainable, versioned factors" (P12's own exit condition, the gate table). */
  note: string;
}

/** the spec verbatim: "Every MatchResult stores factor contributions, inputs, weight set and algorithm version." `computedAt` deliberately does NOT appear here, same reasoning as @tol/attribution's ClaimScoreBreakdown — this package never reads a clock; the caller (apps/api's matching service, this stage) stamps a real `evaluatedAt`/`rankedAt` on the persisted MatchResult row itself. */
export interface MatchRankingBreakdown {
  factors: readonly RankingFactorContribution[];
  /** Weighted sum of all nine factor contributions, 0-100. What rankMatches sorts by. */
  total: number;
  algorithmVersion: string;
  inputVersions: readonly string[];
}

/** One capacity's position in a ranked result set. */
export interface RankedMatch {
  capacityId: string;
  rank: number;
  breakdown: MatchRankingBreakdown;
  /**
   * Other capacityIds sharing this EXACT `total` — empty when uniquely
   * ranked. Surfaced explicitly rather than letting an arbitrary sort
   * order silently pick a "winner", same reasoning as
   * @tol/attribution's ClaimRankEntry.tiedWith (the spec's own
   * "do not force a false single winner" principle, generalized here
   * to ranking rather than attribution).
   */
  tiedWith: readonly string[];
}
