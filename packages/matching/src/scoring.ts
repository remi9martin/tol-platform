// packages/matching/src/scoring.ts
//
// the spec, verbatim:
//   "Rank only eligible routes; optimize for expected durable utility,
//   not one headline rate."
//
//   Factor                          || Initial weight || Notes
//   MCC / product fit               || 22%             || Exact/conditional fit; provider-confirmed preferred
//   Geography / licensing fit       || 17%             || Entity + merchant + cardholder geography
//   Volume / ticket fit             || 13%             || Capacity headroom and ramp comfort
//   Risk-history fit                || 13%             || CB/fraud/refund/history alignment
//   Settlement / currency fit       || 10%             || Cadence, rail, reserve working-capital impact
//   Commercial utility              || 10%             || Net economics after known fees/reserve cost
//   Technical / launch fit          || 7%              || Gateway, API, certification, expected time
//   Provider reliability/freshness  || 5%              || Response SLA and capacity age
//   Outcome-calibrated likelihood   || 3% initially    || Grows only with validated data
//
//   "Weights are illustrative starting defaults and must be configurable
//   by marketplace policy. Every MatchResult stores factor contributions,
//   inputs, weight set and algorithm version."
//
// This engine only ever runs against candidates that ALREADY passed
// eligibility.ts's hard filters (the spec's own INVARIANT: "An
// ineligible provider cannot receive a higher final recommendation rank
// than an eligible provider. Eligibility runs first.") — ranking.ts's
// rankMatches() enforces this by construction (it never re-derives
// eligibility itself; the caller supplies only the already-eligible
// set).
//
// DETERMINISTIC-ONLY PER ADR-0004: no ML, no statistical model, no
// randomness. Pure, zero clock dependency (same discipline as
// eligibility.ts and every sibling engine package) — `computedAt` is
// deliberately NOT a field on MatchRankingBreakdown; the caller (apps/
// api's matching service) stamps a real timestamp on the persisted
// MatchResult row itself, same precedent as @tol/attribution's
// scoreClaim.

import { MATCHING_CONFIG } from "./config.js";
import { RankingInputError } from "./errors.js";
import type { MatchCapacityInput, MatchContext, MatchOpportunityInput, MatchRankingBreakdown, RankingFactorContribution } from "./types.js";

/**
 * Module-load-time structural invariant — same discipline as
 * @tol/attribution's assertWeightsSumToOne() and @tol/authz's
 * deny-by-default matrix check: throws the instant this module is
 * imported, in every environment, regardless of whether the test suite
 * ever ran.
 */
function assertRankingWeightsSumToOne(): void {
  const w = MATCHING_CONFIG.rankingWeights;
  const sum =
    w.mccProductFit +
    w.geographyLicensingFit +
    w.volumeTicketFit +
    w.riskHistoryFit +
    w.settlementCurrencyFit +
    w.commercialUtility +
    w.technicalLaunchFit +
    w.providerReliabilityFreshness +
    w.outcomeCalibratedLikelihood;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`@tol/matching: MATCHING_CONFIG.rankingWeights must sum to 1, got ${sum}`);
  }
}
assertRankingWeightsSumToOne();

/**
 * Module-load-time range check on every fixed neutral-default/placeholder
 * score this file falls back to (outcomeCalibratedLikelihoodPlaceholder,
 * technicalLaunchFitNeutralDefault, riskHistoryFitNeutralDefault,
 * neutralFactorDefault) — added after this block's own review
 * (review) suggested validating
 * the outcome placeholder specifically; generalized to every constant of
 * the same shape so a future config edit can't accidentally configure a
 * fixed score outside the 0-100 scale every OTHER factor is normalized
 * to, which would silently skew `total` without any test necessarily
 * catching it (a config-only change, not a code-path change).
 */
function assertNeutralDefaultsInRange(): void {
  const c = MATCHING_CONFIG;
  const entries: Array<[string, number]> = [
    ["outcomeCalibratedLikelihoodPlaceholder", c.outcomeCalibratedLikelihoodPlaceholder],
    ["technicalLaunchFitNeutralDefault", c.technicalLaunchFitNeutralDefault],
    ["riskHistoryFitNeutralDefault", c.riskHistoryFitNeutralDefault],
    ["neutralFactorDefault", c.neutralFactorDefault],
  ];
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`@tol/matching: MATCHING_CONFIG.${name} must be a finite number in [0, 100], got ${value}`);
    }
  }
}
assertNeutralDefaultsInRange();

function clamp0to100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Linear 0-100 normalization over [min, max], clamped at both ends. Guards `max === min` (would otherwise divide by zero) — same defensive posture as @tol/attribution's scoring.ts#normalize, exercised directly by scoring.test.ts since none of this file's own fixed band constants are degenerate. */
function normalize(value: number, min: number, max: number): number {
  if (max === min) {
    throw new RankingInputError(`normalization band is degenerate (min === max === ${min}) — cannot normalize`);
  }
  return clamp0to100(((value - min) / (max - min)) * 100);
}

/** Same as normalize, inverted — used wherever a SMALLER raw value should score HIGHER (fee bps, settlement days). */
function normalizeInvert(value: number, min: number, max: number): number {
  if (max === min) {
    throw new RankingInputError(`normalization band is degenerate (min === max === ${min}) — cannot normalize`);
  }
  return clamp0to100((1 - (value - min) / (max - min)) * 100);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function overlapCount(a: readonly string[], b: readonly string[]): number {
  return a.filter((x) => b.includes(x)).length;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return numerator === 0n ? 1 : Number.POSITIVE_INFINITY;
  return Number(numerator) / Number(denominator);
}

interface FactorScore {
  score: number;
  note: string;
}

/**
 * the spec: "Exact/conditional fit; provider-confirmed preferred."
 * Eligibility already guarantees full MCC coverage for anything reaching
 * this function (an uncovered/excluded MCC is a hard eligibility
 * blocker), so the coverage ratio alone would read as a constant 100 for
 * every candidate — not useful for ranking. A specificity penalty
 * (documented inference, not scope-numeric) differentiates a provider
 * whose accepted list is narrowly targeted at this opportunity's MCCs
 * from one that merely accepts a huge generic list — rewarding the
 * "provider-confirmed [exact fit]" case the scope names over a blanket
 * acceptance.
 */
function scoreMccProductFit(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput): FactorScore {
  if (opportunity.mccs.length === 0) return { score: 0, note: "No MCCs specified on opportunity — cannot score fit." };
  const matched = overlapCount(opportunity.mccs, capacity.mccsAccepted);
  const coverage = matched / opportunity.mccs.length;
  const extras = Math.max(0, capacity.mccsAccepted.length - matched);
  const penalty = Math.min(MATCHING_CONFIG.mccSpecificityPenaltyCap, extras * MATCHING_CONFIG.mccSpecificityPenaltyPerExtra);
  const score = clamp0to100(coverage * 100 - penalty);
  return { score: round1(score), note: `MCC coverage ${round1(coverage * 100)}% (${matched}/${opportunity.mccs.length}); specificity penalty ${penalty} (accepted list carries ${extras} MCC(s) beyond this opportunity's own).` };
}

/** the spec: "Entity + merchant + cardholder geography." Scored as jurisdiction-overlap coverage ratio — same reasoning as MCC coverage above, minus the specificity penalty (the scope's own notes column doesn't name an equivalent "exact vs. blanket" preference for geography). */
function scoreGeographyLicensingFit(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput): FactorScore {
  if (opportunity.jurisdictions.length === 0) return { score: 0, note: "No jurisdictions specified on opportunity — cannot score fit." };
  const matched = overlapCount(opportunity.jurisdictions, capacity.jurisdictions);
  const coverage = matched / opportunity.jurisdictions.length;
  return { score: round1(coverage * 100), note: `Jurisdiction coverage ${round1(coverage * 100)}% (${matched}/${opportunity.jurisdictions.length}).` };
}

/** the spec: "Capacity headroom and ramp comfort." Headroom RATIO (capacity / near-term demand) normalized over MATCHING_CONFIG.volumeHeadroomRatioBand — eligibility's own VOLUME_TICKET rule already requires >= 1.0x, so this factor measures comfort ABOVE that floor, not from zero. Mismatched currencies or zero demand can't be ratio-compared meaningfully; both fall back to a documented neutral default rather than a fabricated number. */
function scoreVolumeTicketFit(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput): FactorScore {
  if (opportunity.currency !== capacity.currency) {
    return { score: MATCHING_CONFIG.neutralFactorDefault, note: "Currency mismatch — headroom ratio not comparable; neutral default applied." };
  }
  if (opportunity.movable30dMinor === 0n) {
    return { score: MATCHING_CONFIG.neutralFactorDefault, note: "Opportunity reports zero near-term movable volume — headroom ratio undefined; neutral default applied." };
  }
  const ratio = bigintRatio(capacity.monthlyCapacityMinor, opportunity.movable30dMinor);
  const band = MATCHING_CONFIG.volumeHeadroomRatioBand;
  const score = Number.isFinite(ratio) ? normalize(ratio, band.min, band.max) : 100;
  return { score: round1(score), note: `Headroom ratio ${Number.isFinite(ratio) ? ratio.toFixed(2) : "∞"}x, normalized over [${band.min}x, ${band.max}x].` };
}

/** the spec: "CB/fraud/refund/history alignment." Averages how far UNDER each configured ceiling the merchant's actual rates sit (0% utilization = perfect score, 100%+ utilization = 0 — though anything above 100% utilization would already be an eligibility blocker per eligibility.ts's RISK rule, so ranking only ever sees sub-ceiling utilization in practice). No risk history yet -> neutral default, same reasoning as eligibility.ts's RISK_NO_HISTORY (a new entrant, not a data gap). */
function scoreRiskHistoryFit(capacity: MatchCapacityInput, context: MatchContext): FactorScore {
  const rp = context.merchantRiskProfile;
  const utilizations: number[] = [];
  if (rp?.chargebackBps !== undefined && capacity.maxChargebackBps > 0) utilizations.push(rp.chargebackBps / capacity.maxChargebackBps);
  if (rp?.fraudBps !== undefined && capacity.maxFraudBps > 0) utilizations.push(rp.fraudBps / capacity.maxFraudBps);
  if (rp?.refundBps !== undefined && capacity.maxRefundBps > 0) utilizations.push(rp.refundBps / capacity.maxRefundBps);

  if (utilizations.length === 0) {
    return { score: MATCHING_CONFIG.riskHistoryFitNeutralDefault, note: "No merchant risk history supplied yet — neutral default applied." };
  }
  const avgUtilization = utilizations.reduce((s, u) => s + u, 0) / utilizations.length;
  const score = clamp0to100((1 - avgUtilization) * 100);
  return { score: round1(score), note: `Average risk-ceiling utilization ${round1(avgUtilization * 100)}% across ${utilizations.length} configured dimension(s).` };
}

/** the spec: "Cadence, rail, reserve working-capital impact." Scored purely on settlement cadence days (fewer = better working-capital impact) — reserve mechanics aren't modeled as a standalone figure on CapacityProfile (folded, if at all, into the loosely-typed commercialTerms JSON, which this build validates for mdrBps/fixedFeeMinor/model only, per @tol/contracts' CommercialTermsSchema — no reserve field). Currency mismatch (an eligibility blocker) scores 0 here too, so a caller who ranks a manually-overridden ineligible candidate still sees an honest 0, not a fabricated positive number. */
function scoreSettlementCurrencyFit(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput): FactorScore {
  if (opportunity.currency !== capacity.currency) {
    return { score: 0, note: `Currency mismatch (opportunity: ${opportunity.currency}; capacity: ${capacity.currency}).` };
  }
  const band = MATCHING_CONFIG.settlementCadenceDaysBand;
  const score = normalizeInvert(capacity.settlementCadenceDays, band.min, band.max);
  return { score: round1(score), note: `Settlement cadence ${capacity.settlementCadenceDays} day(s), normalized (inverted) over [${band.min}, ${band.max}] days.` };
}

/** the spec: "Net economics after known fees/reserve cost." Scored on CapacityProfile.commercialTerms.mdrBps alone (lower = better) — the one numeric, cross-candidate-comparable figure @tol/contracts' CommercialTermsSchema actually validates; `fixedFeeMinor`/`model` are named in the note for transparency but not blended into the score (no per-transaction-count estimate exists at this layer to make a fixed fee comparable to a bps rate — folding it in without one would manufacture false precision). No commercial terms on file -> neutral default. */
function scoreCommercialUtility(capacity: MatchCapacityInput): FactorScore {
  if (!capacity.commercialTerms) {
    return { score: MATCHING_CONFIG.neutralFactorDefault, note: "No commercial terms on file yet — neutral default applied." };
  }
  const { mdrBps, fixedFeeMinor, model } = capacity.commercialTerms;
  const band = MATCHING_CONFIG.commercialUtilityFeeBpsBand;
  const score = normalizeInvert(mdrBps, band.min, band.max);
  return { score: round1(score), note: `MDR ${mdrBps}bps (${model}, fixed fee ${fixedFeeMinor} minor units/txn), normalized (inverted) over [${band.min}, ${band.max}]bps.` };
}

/** the spec: "Gateway, API, certification, expected time." CapacityProfile's schema carries no TechnicalCapability field yet (same structurally-absent reasoning as eligibility.ts's TECHNICAL rule) — fixed neutral default until that data exists. */
function scoreTechnicalLaunchFit(): FactorScore {
  return { score: MATCHING_CONFIG.technicalLaunchFitNeutralDefault, note: "Technical/launch fit not modeled yet (CapacityProfile has no TechnicalCapability field) — fixed neutral default applied (ADR-0012)." };
}

/** the spec: "Response SLA and capacity age." Response SLA isn't modeled on CapacityProfile; capacity age IS — this factor is scored purely from the same server-computed `freshnessClass` eligibility.ts's FRESHNESS rule already trusts. Direct scope citation for the mapping: p.16 "AGING — still usable but ranking penalty applies" is exactly what the FRESH=100/AGING=60 gap encodes. STALE/UNKNOWN can only reach this function via an operator override (both hard-block eligibility) — still scored honestly low, never silently boosted just because an override let the candidate through. */
function scoreProviderReliabilityFreshness(capacity: MatchCapacityInput): FactorScore {
  const scoreByFreshness: Record<string, number> = { FRESH: 100, AGING: 60, STALE: 20, UNKNOWN: 0 };
  const score = scoreByFreshness[capacity.freshnessClass];
  if (score === undefined) {
    throw new RankingInputError(`capacity.freshnessClass "${String(capacity.freshnessClass)}" is not recognized`);
  }
  return { score, note: `Capacity freshness class: ${capacity.freshnessClass}.` };
}

/** the spec: "Grows only with validated data." ADR-0004: fixed placeholder until real outcome data exists — see config.ts's own doc comment on why a neutral 50 (not 0) is used. */
function scoreOutcomeCalibratedLikelihood(): FactorScore {
  return { score: MATCHING_CONFIG.outcomeCalibratedLikelihoodPlaceholder, note: "Fixed placeholder — no black-box model controls invitations yet (ADR-0004); grows only once real outcome data is captured (the spec)." };
}

/**
 * Scores ONE Opportunity/CapacityProfile pair across all nine scope
 * p.20 factors. Pure and deterministic: identical inputs produce a
 * deep-equal `MatchRankingBreakdown` every time (scoring.test.ts proves
 * this with hundreds of repeated calls, same discipline as
 * @tol/attribution's scoreClaim proof). Does NOT check eligibility
 * itself — callers must only ever invoke this (directly, or via
 * ranking.ts's rankMatches) on capacities that already passed
 * evaluateEligibility, per the spec's own ordering invariant.
 */
export function scoreMatch(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput, context: MatchContext): MatchRankingBreakdown {
  const w = MATCHING_CONFIG.rankingWeights;

  const mcc = scoreMccProductFit(opportunity, capacity);
  const geo = scoreGeographyLicensingFit(opportunity, capacity);
  const vol = scoreVolumeTicketFit(opportunity, capacity);
  const risk = scoreRiskHistoryFit(capacity, context);
  const settle = scoreSettlementCurrencyFit(opportunity, capacity);
  const comm = scoreCommercialUtility(capacity);
  const tech = scoreTechnicalLaunchFit();
  const fresh = scoreProviderReliabilityFreshness(capacity);
  const outcome = scoreOutcomeCalibratedLikelihood();

  const factors: RankingFactorContribution[] = [
    { factor: "mccProductFit", score: mcc.score, weight: w.mccProductFit, contribution: round1(mcc.score * w.mccProductFit), note: mcc.note },
    { factor: "geographyLicensingFit", score: geo.score, weight: w.geographyLicensingFit, contribution: round1(geo.score * w.geographyLicensingFit), note: geo.note },
    { factor: "volumeTicketFit", score: vol.score, weight: w.volumeTicketFit, contribution: round1(vol.score * w.volumeTicketFit), note: vol.note },
    { factor: "riskHistoryFit", score: risk.score, weight: w.riskHistoryFit, contribution: round1(risk.score * w.riskHistoryFit), note: risk.note },
    { factor: "settlementCurrencyFit", score: settle.score, weight: w.settlementCurrencyFit, contribution: round1(settle.score * w.settlementCurrencyFit), note: settle.note },
    { factor: "commercialUtility", score: comm.score, weight: w.commercialUtility, contribution: round1(comm.score * w.commercialUtility), note: comm.note },
    { factor: "technicalLaunchFit", score: tech.score, weight: w.technicalLaunchFit, contribution: round1(tech.score * w.technicalLaunchFit), note: tech.note },
    { factor: "providerReliabilityFreshness", score: fresh.score, weight: w.providerReliabilityFreshness, contribution: round1(fresh.score * w.providerReliabilityFreshness), note: fresh.note },
    { factor: "outcomeCalibratedLikelihood", score: outcome.score, weight: w.outcomeCalibratedLikelihood, contribution: round1(outcome.score * w.outcomeCalibratedLikelihood), note: outcome.note },
  ];

  const total = round1(factors.reduce((sum, f) => sum + f.contribution, 0));

  return {
    factors,
    total,
    algorithmVersion: MATCHING_CONFIG.algorithmVersion,
    inputVersions: context.inputVersions ? [...context.inputVersions] : [],
  };
}
