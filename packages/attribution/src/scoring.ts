// packages/attribution/src/scoring.ts
//
// the spec: the four-factor claim scoring engine — HISTORY (40%) +
// PROXIMITY (30%) + EVIDENCE (20%) + TIME (10%), weights verbatim from
// the scope's own table. Every score is derived LIVE from a claim's raw
// inputs; nothing here is a lookup of a pre-baked/stored number — same
// "compute, don't cache" discipline as the reuse-reference prototype's
// lib/attribution.ts (the prototype's `attribution.ts`, read for
// shape guidance only, never edited — see this package's README). TIME is
// deliberately the LIGHTEST weight of the four (10%, a quarter of
// HISTORY's 40%) — the scope's own words: "Timestamp of qualifying claim,
// not public-name entry" (p.18). Being early helps a little; it can never
// be the dominant factor.
//
// PURE FUNCTION, ZERO CLOCK DEPENDENCY: this file never calls `new
// Date()`/`Date.now()` — every timing input (submissionLagDays) arrives
// as an already-computed number, so "same inputs -> same output" holds by
// CONSTRUCTION, not merely by empirical test — though scoring.test.ts
// proves it empirically too, matching this codebase's "prove it, don't
// just claim it" discipline (e.g. @tol/crypto's 10,000-encryption IV
// uniqueness proof; ADR-0009). This is also why `computedAt` is
// NOT a field scoreClaim returns — see types.ts's ClaimScoreBreakdown doc
// comment.
//
// DETERMINISTIC-ONLY PER ADR-0004: no ML, no statistical model, no
// randomness anywhere in this file — every number below is either a fixed
// configured constant (config.ts) or simple, auditable arithmetic over
// the caller's own inputs.

import { ATTRIBUTION_CONFIG } from "./config.js";
import { isDirectnessTier } from "./types.js";
import type { ClaimEvidenceContribution, ClaimEvidenceInput, ClaimScoreBreakdown, ClaimScoringInput } from "./types.js";

export class ClaimScoringInputError extends TypeError {
  constructor(message: string) {
    super(`invalid claim scoring input: ${message}`);
    this.name = "ClaimScoringInputError";
  }
}

/**
 * Module-load-time structural invariant, same discipline as
 * @tol/authz's authority matrix ("deny-by-default enforced structurally
 * — a missing matrix entry throws at module load"). review
 * (review) correctly noted
 * scoring.test.ts's "weights sum to 1" assertion only protects a
 * TEST-RUN, not a production build where tests were skipped — this
 * throws the instant the module is imported, in every environment,
 * regardless of whether the test suite ever ran.
 */
function assertWeightsSumToOne(): void {
  const { history, proximity, evidence, time } = ATTRIBUTION_CONFIG.weights;
  const sum = history + proximity + evidence + time;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`@tol/attribution: ATTRIBUTION_CONFIG.weights must sum to 1, got ${sum} (history=${history}, proximity=${proximity}, evidence=${evidence}, time=${time})`);
  }
}
assertWeightsSumToOne();

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Linear 0-100 normalization over [min, max], clamped at both ends — a
 * value outside the configured band saturates at 0/100 rather than
 * extrapolating past it. Guards `max === min` (would otherwise divide by
 * zero, silently producing NaN/Infinity instead of failing loud) — not
 * reachable with this file's own fixed band constants today, but a
 * defensive guard against a future config edit that accidentally
 * collapses a band, matching this codebase's "fail loud on bad input"
 * discipline rather than letting a misconfiguration silently corrupt
 * every score.
 */
// Exported (but NOT re-exported from index.ts — see that file's header
// comment on this package's public surface) purely so scoring.test.ts can
// unit-test the degenerate-band guard directly: ATTRIBUTION_CONFIG's own
// bands are fixed, non-degenerate constants, so scoreClaim/scoreEvidence's
// public API can never actually reach this branch today — the guard is
// exercised directly at this narrower internal boundary instead.
export function normalize(value: number, min: number, max: number): number {
  if (max === min) {
    throw new ClaimScoringInputError(`normalization band is degenerate (min === max === ${min}) — cannot normalize`);
  }
  return clamp01((value - min) / (max - min)) * 100;
}

/** Same as normalize, inverted — used for TIME, where a SMALLER raw value (fewer lag days) should score HIGHER. Shares normalize's degenerate-band guard. */
export function normalizeInvert(value: number, min: number, max: number): number {
  if (max === min) {
    throw new ClaimScoringInputError(`normalization band is degenerate (min === max === ${min}) — cannot normalize`);
  }
  return clamp01(1 - (value - min) / (max - min)) * 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function assertFiniteNonNegative(value: number, fieldName: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ClaimScoringInputError(`${fieldName} must be a finite number, got ${typeof value === "number" ? value : typeof value}`);
  }
  if (value < 0) {
    throw new ClaimScoringInputError(`${fieldName} must be >= 0, got ${value}`);
  }
}

export interface EvidenceScoreResult {
  /** Capped at ATTRIBUTION_CONFIG.evidenceScoreCeiling (100). */
  total: number;
  /** Pre-cap sum — equals `total` whenever the ceiling doesn't bind; kept so a caller/UI can show "would have been X, capped at 100" when it does. */
  rawTotal: number;
  items: readonly ClaimEvidenceContribution[];
}

/**
 * Scores a single claim's EVIDENCE factor. Each item contributes
 * `basePoints[evidenceType] * multiplier[verificationState]`
 * (ATTRIBUTION_CONFIG), summed across all items and capped at 100 — a
 * claim with many strong items can't run away past the factor's own
 * 0-100 scale, keeping this factor commensurable with the other three
 * before weighting. Returns the per-item breakdown alongside the total so
 * callers (and the UI) can show exactly which evidence earned how many
 * points — the EXPLAINABLE half of "explainable rule-based math." An
 * empty `items` array is valid input (scores 0), matching the anti-gaming
 * test's "no relationship evidence" case.
 */
export function scoreEvidence(items: readonly ClaimEvidenceInput[]): EvidenceScoreResult {
  const { evidenceBasePoints, evidenceVerificationMultiplier, evidenceScoreCeiling } = ATTRIBUTION_CONFIG;

  const contributions: ClaimEvidenceContribution[] = items.map((item, index) => {
    const basePoints: number | undefined = (evidenceBasePoints as Record<string, number>)[item.evidenceType];
    const multiplier: number | undefined = (evidenceVerificationMultiplier as Record<string, number>)[item.verificationState];
    if (basePoints === undefined) {
      throw new ClaimScoringInputError(`evidenceItems[${index}].evidenceType "${item.evidenceType}" is not a recognized ClaimEvidenceType`);
    }
    if (multiplier === undefined) {
      throw new ClaimScoringInputError(`evidenceItems[${index}].verificationState "${item.verificationState}" is not a recognized EvidenceVerificationState`);
    }
    return {
      index,
      evidenceType: item.evidenceType,
      verificationState: item.verificationState,
      basePoints,
      multiplier,
      contribution: round1(basePoints * multiplier),
    };
  });

  const rawTotal = round1(contributions.reduce((sum, c) => sum + c.contribution, 0));
  return { total: Math.min(evidenceScoreCeiling, rawTotal), rawTotal, items: contributions };
}

/**
 * Scores one claim end to end. Deterministic and pure: two calls with an
 * identical `input` produce a deep-equal `ClaimScoreBreakdown` every time
 * (scoring.test.ts's "determinism" suite proves this directly, running
 * hundreds of calls against the same input, not just asserting it by
 * inspection of the code).
 *
 * ANTI-SQUATTING MECHANISM (the spec: "D0 — public knowledge only;
 * creates no attribution"; p.18 anti-gaming test: "Twenty public provider
 * names submitted with no relationship evidence yield zero verified
 * equity/attribution credit"): a D0-directness claim's `total` is
 * HARD-FORCED to 0, structurally, regardless of how the other three
 * factors compute. This is a deliberate business RULE layered on top of
 * the weighted sum, not an emergent property of D0's own proximity
 * weight — D0's own proximity score IS already 0 per
 * ATTRIBUTION_CONFIG.proximityScoreByTier, but with only a 30% weight
 * that alone would merely zero out 30 of a possible 100 points; HISTORY
 * (40%) + EVIDENCE (20%) + TIME (10%) could otherwise still sum to up to
 * 70, nowhere near scope's explicit "yield zero" requirement. `cappedFrom`
 * is populated only when this rule actually binds (the pre-rule weighted
 * total was greater than 0), so a genuinely-all-zero claim doesn't
 * misleadingly show a "capped from 0" note.
 *
 * Throws ClaimScoringInputError on malformed input (negative
 * history/lag, an unrecognized directness tier, or an unrecognized
 * evidence type/verification state on any item) rather than silently
 * coercing or NaN-ing — same "fail loud on bad input" discipline as
 * @tol/domain's money.ts assert* guards.
 */
export function scoreClaim(input: ClaimScoringInput): ClaimScoreBreakdown {
  assertFiniteNonNegative(input.priorCommercialHistoryMonths, "priorCommercialHistoryMonths");
  assertFiniteNonNegative(input.submissionLagDays, "submissionLagDays");
  if (!isDirectnessTier(input.directnessTier)) {
    throw new ClaimScoringInputError(`directnessTier "${String(input.directnessTier)}" is not a recognized DirectnessTier`);
  }

  const { weights, historyMonthsBand, submissionLagDaysBand, proximityScoreByTier, zeroAttributionTiers, algorithmVersion } = ATTRIBUTION_CONFIG;

  const history = normalize(input.priorCommercialHistoryMonths, historyMonthsBand.min, historyMonthsBand.max);
  const proximity: number = proximityScoreByTier[input.directnessTier];
  const evidenceResult = scoreEvidence(input.evidenceItems);
  const time = normalizeInvert(input.submissionLagDays, submissionLagDaysBand.min, submissionLagDaysBand.max);

  const weighted = history * weights.history + proximity * weights.proximity + evidenceResult.total * weights.evidence + time * weights.time;

  const isZeroAttributionTier = (zeroAttributionTiers as readonly string[]).includes(input.directnessTier);
  const roundedWeighted = round1(weighted);
  const total = isZeroAttributionTier ? 0 : roundedWeighted;

  const breakdown: ClaimScoreBreakdown = {
    history: round1(history),
    proximity: round1(proximity),
    evidence: round1(evidenceResult.total),
    time: round1(time),
    weighted: roundedWeighted,
    total,
    evidenceBreakdown: evidenceResult.items,
    algorithmVersion,
    inputVersions: input.inputVersions ? [...input.inputVersions] : [],
  };
  if (isZeroAttributionTier && roundedWeighted > 0) {
    breakdown.cappedFrom = roundedWeighted;
  }
  // See types.ts's ClaimScoreBreakdown.evidenceRawTotal doc comment — only
  // populated when the evidence factor's own 100-point ceiling actually bound.
  if (evidenceResult.rawTotal > evidenceResult.total) {
    breakdown.evidenceRawTotal = evidenceResult.rawTotal;
  }
  return breakdown;
}
