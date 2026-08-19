// packages/matching/src/eligibility.ts
//
// the spec, verbatim:
//   "AI may explain or prioritize; it must not override prohibited route
//   logic."
//
//   Rule family        || Examples                                       || Result
//   Role               || Provider is not actually acquiring/servicing
//                          required function                             || INELIGIBLE
//   Jurisdiction        || Merchant/entity/cardholder location outside
//                          permission                                    || INELIGIBLE
//   MCC/product         || Prohibited product or unsupported MCC         || INELIGIBLE
//   Volume/ticket       || Absolute min/max or capacity breach           || INELIGIBLE
//   Evidence/license    || Mandatory license/evidence absent or expired  || BLOCKED/INELIGIBLE
//   Risk                || Hard chargeback/fraud limit exceeded          || INELIGIBLE
//   Settlement          || Required currency/rail unsupported            || INELIGIBLE
//   Technical           || Mandatory gateway/3DS/tokenization
//                          constraint unsupported                        || INELIGIBLE
//   Freshness           || Capacity profile stale beyond tolerance       || REFRESH_REQUIRED
//   Compliance hold     || Sanctions/watchlist/identity conflict
//                          unresolved                                    || BLOCKED
//
//   Implementation:
//     evaluateEligibility(opportunity, providerCapacity, ruleSet) -> {
//       eligible: boolean, blockers: RuleResult[], warnings: RuleResult[],
//       ruleVersion: string, inputVersions: string[], evaluatedAt: timestamp
//     }
//   Rules are configuration-driven but type-safe. A rule change creates a
//   new immutable RuleSetVersion. Identical inputs + identical rule
//   version must produce identical results. Unknown values are never
//   silently treated as pass. Rules define UNKNOWN behavior explicitly.
//   Operator override is possible only for overridable warnings/blocks;
//   prohibited rules can be marked NON_OVERRIDABLE. Every blocker exposes
//   a safe explanation to the correct audience without leaking private
//   provider appetite.
//   INVARIANT: An ineligible provider cannot receive a higher final
//   recommendation rank than an eligible provider. Eligibility runs
//   first.
//
// This file follows the SCOPE's contract verbatim (`blockers`/`warnings`
// arrays, `evaluatedAt`) rather than the earlier build brief's own
// paraphrased sketch (`failedRules: [...]`) where the two differ — the
// brief itself says the scope is "Authoritative — especially the scope's
// exact eligibility rules" and this repo's own convention (DECISIONS.md
// D10's weight-table correction) is to prefer the primary source over a
// secondary paraphrase every time the two disagree. See ADR-0012.
//
// The INVARIANT above is enforced structurally, not just by convention:
// ranking.ts's rankMatches() only ever accepts capacities the CALLER has
// already filtered to eligible === true (its own type signature takes
// `readonly MatchCapacityInput[]`, the same shape evaluateEligibility
// consumes, with no `eligible` flag threaded through) — an ineligible
// capacity literally never reaches the ranking math, rather than being
// ranked and then filtered/sorted after the fact.
//
// DETERMINISTIC-ONLY PER ADR-0004 (extended to Eligibility by this
// day's own build brief): no ML, no statistical model, no randomness
// anywhere in this file. `context.now` is REQUIRED and never read from
// the system clock internally (see types.ts's MatchContext.now doc
// comment) — this is what makes "identical inputs -> identical output"
// (the spec) provably true of `evaluatedAt` too, not just the rule
// verdicts, the same discipline as @tol/evidence's freshness classifiers.

import { MATCHING_CONFIG, overridableFor } from "./config.js";
import { EligibilityInputError } from "./errors.js";
import { isFreshnessClassLike } from "./types.js";
import type { EligibilityResult, MatchCapacityInput, MatchContext, MatchOpportunityInput, RuleResult } from "./types.js";

function overlap(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((x) => b.includes(x));
}

function assertFiniteNonNegative(value: number, fieldName: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EligibilityInputError(`${fieldName} must be a finite number, got ${typeof value === "number" ? value : typeof value}`);
  }
  if (value < 0) {
    throw new EligibilityInputError(`${fieldName} must be >= 0, got ${value}`);
  }
}

function assertNonNegativeBigInt(value: bigint, fieldName: string): void {
  if (typeof value !== "bigint") {
    throw new EligibilityInputError(`${fieldName} must be a bigint, got ${typeof value}`);
  }
  if (value < 0n) {
    throw new EligibilityInputError(`${fieldName} must be >= 0, got ${value}`);
  }
}

/** Safe bigint ratio for headroom comparisons. Converts to Number for the division itself — a precision caveat documented here rather than silently assumed: fine for a 0-100-scale ratio/comparison, not for an exact settlement amount (which never flows through this function). Returns `Infinity` when the denominator is zero and the numerator is positive (unbounded headroom relative to zero demand), and `1` when both are zero (no demand, trivially "enough" capacity) — both defensive, not reachable via a real MATCH_READY opportunity in practice (an earlier readiness rules require real volume figures), but a pure function must still define a total, non-throwing behavior for every input in its declared domain. */
function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return numerator === 0n ? 1 : Number.POSITIVE_INFINITY;
  return Number(numerator) / Number(denominator);
}

function validateOpportunity(opportunity: MatchOpportunityInput): void {
  if (!opportunity.currency || opportunity.currency.length !== 3) {
    throw new EligibilityInputError(`opportunity.currency must be a 3-letter ISO code, got "${opportunity.currency}"`);
  }
  assertNonNegativeBigInt(opportunity.movable30dMinor, "opportunity.movable30dMinor");
}

/**
 * Structural validation, run once up front so every rule function below
 * can trust its inputs are well-formed and never needs its own ad-hoc
 * re-check — same "validate at the boundary, trust it everywhere after"
 * discipline as @tol/domain/money.ts. Three checks added after this
 * block's own review (review "review-
 * engine"): `settlementRail` non-empty (a blank rail could otherwise
 * silently PASS the SETTLEMENT rule and render a confusing "settlement
 * rail \"\" acceptable" message), `maxTicketMinor` not below
 * `minTicketMinor` (an inverted/misconfigured range would make
 * VOLUME_TICKET's ticket-size sub-check reject every possible ticket
 * value while reporting a range that reads as backwards), and
 * `freshnessClass` validated HERE too (not only inside checkFreshness's
 * own defensive switch default) so a structurally-invalid value fails
 * fast at the top of evaluateEligibility, before any rule runs — belt
 * and suspenders, matching @tol/domain/money.ts's own stated precedent
 * for validating the same invariant at more than one boundary.
 */
function validateCapacity(capacity: MatchCapacityInput): void {
  if (!capacity.currency || capacity.currency.length !== 3) {
    throw new EligibilityInputError(`capacity.currency must be a 3-letter ISO code, got "${capacity.currency}"`);
  }
  if (!capacity.settlementRail || capacity.settlementRail.trim().length === 0) {
    throw new EligibilityInputError(`capacity.settlementRail must be a non-empty string, got "${capacity.settlementRail}"`);
  }
  if (!isFreshnessClassLike(capacity.freshnessClass)) {
    throw new EligibilityInputError(`capacity.freshnessClass is not a recognized FreshnessClassLike, got "${String(capacity.freshnessClass)}"`);
  }
  assertNonNegativeBigInt(capacity.monthlyCapacityMinor, "capacity.monthlyCapacityMinor");
  assertFiniteNonNegative(capacity.minTicketMinor, "capacity.minTicketMinor");
  assertFiniteNonNegative(capacity.maxTicketMinor, "capacity.maxTicketMinor");
  if (capacity.maxTicketMinor !== 0 && capacity.maxTicketMinor < capacity.minTicketMinor) {
    throw new EligibilityInputError(`capacity.maxTicketMinor (${capacity.maxTicketMinor}) must not be less than capacity.minTicketMinor (${capacity.minTicketMinor}) unless it is 0 (meaning "no configured ceiling")`);
  }
  assertFiniteNonNegative(capacity.maxChargebackBps, "capacity.maxChargebackBps");
  assertFiniteNonNegative(capacity.maxFraudBps, "capacity.maxFraudBps");
  assertFiniteNonNegative(capacity.maxRefundBps, "capacity.maxRefundBps");
  assertFiniteNonNegative(capacity.settlementCadenceDays, "capacity.settlementCadenceDays");
}

function pass(rule: RuleResult["rule"], code: string, message: string): RuleResult {
  return { rule, code, status: "PASS", blocking: false, overridable: overridableFor(code), message };
}

/**
 * ROLE — scope: "Provider is not actually acquiring/servicing required
 * function." CapacityProfile's schema (thin, ADR-0008 part 2)
 * carries no role/service-type column distinct from Opportunity's own
 * `opportunityType` — candidate pools are pre-scoped to provider
 * CapacityProfile rows by construction, the same no-op treatment the
 * reuse-reference prototype gives this exact rule ("candidate pool is
 * pre-scoped to acquirers by CapacityProfile, asserted here for
 * transparency in the eligibility trace" — ../../the prototype repo/lib/
 * matching.ts). A dedicated PASS row is still emitted (never omitted) so
 * this rule family is visibly present in every evaluation's `results`,
 * satisfying the spec's "every blocker exposes a safe explanation"
 * transparency spirit even where the rule currently cannot fail against
 * the schema as built. Named explicitly as a deliberate scope cut in
 * ADR-0012 — a future CapacityProfile.servicesOffered-style
 * column would make this rule non-trivial without changing this
 * function's signature.
 */
function checkRole(): RuleResult {
  return pass(
    "ROLE",
    "ROLE_ASSUMED_COMPATIBLE",
    "Role compatibility assumed by construction — CapacityProfile rows represent acquiring/servicing capacity only; the schema has no distinct role/service-type column to check against Opportunity.opportunityType yet (thin CapacityProfile, ADR-0008 part 2).",
  );
}

/**
 * JURISDICTION — scope: "Merchant/entity/cardholder location outside
 * permission." Both Opportunity.jurisdictions and
 * CapacityProfile.jurisdictions are plain ISO-country-code arrays
 * (schema.prisma). An empty array on EITHER side is treated as UNKNOWN
 * (blocking) rather than vacuously passing or vacuously failing —
 * "Unknown values are never silently treated as pass" (the spec) — a
 * real MATCH_READY opportunity should already have this populated by
 * the time eligibility runs (the spec's own Opportunity state model
 * gates on readiness before MATCH_READY), so this branch is a defensive
 * data-quality guard, not an expected steady-state outcome.
 */
function checkJurisdiction(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput): RuleResult {
  if (opportunity.jurisdictions.length === 0 || capacity.jurisdictions.length === 0) {
    return {
      rule: "JURISDICTION",
      code: "JURISDICTION_UNSPECIFIED",
      status: "UNKNOWN",
      blocking: true,
      overridable: overridableFor("JURISDICTION_UNSPECIFIED"),
      message: "Cannot verify jurisdiction overlap — opportunity or capacity has no jurisdictions configured yet.",
    };
  }
  const matched = overlap(opportunity.jurisdictions, capacity.jurisdictions);
  if (matched.length === 0) {
    return {
      rule: "JURISDICTION",
      code: "JURISDICTION_NO_OVERLAP",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("JURISDICTION_NO_OVERLAP"),
      message: `No jurisdiction overlap (opportunity: ${opportunity.jurisdictions.join("/")}; capacity: ${capacity.jurisdictions.join("/")}).`,
    };
  }
  return pass("JURISDICTION", "JURISDICTION_OVERLAP_OK", `Jurisdiction overlap: ${matched.join("/")}.`);
}

/**
 * MCC_PRODUCT — scope: "Prohibited product or unsupported MCC." Checked
 * in a fixed order (unspecified inputs first, then explicit exclusion,
 * then non-coverage) so a candidate failing multiple ways always reports
 * the SAME single reason for the same inputs — part of what makes this
 * deterministic in the "always the same answer" sense, not just the
 * "never uses randomness" sense. `mccsExcluded` being empty is a normal,
 * unambiguous "nothing excluded" state (unlike `mccsAccepted` empty,
 * which cannot be distinguished from "not configured yet").
 */
function checkMccProduct(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput): RuleResult {
  if (opportunity.mccs.length === 0) {
    return {
      rule: "MCC_PRODUCT",
      code: "MCC_UNSPECIFIED",
      status: "UNKNOWN",
      blocking: true,
      overridable: overridableFor("MCC_UNSPECIFIED"),
      message: "Cannot verify MCC fit — opportunity has no MCCs configured yet.",
    };
  }
  if (capacity.mccsAccepted.length === 0) {
    return {
      rule: "MCC_PRODUCT",
      code: "MCC_ACCEPTED_LIST_EMPTY",
      status: "UNKNOWN",
      blocking: true,
      overridable: overridableFor("MCC_ACCEPTED_LIST_EMPTY"),
      message: "Cannot verify MCC fit — provider has not configured any accepted MCCs yet.",
    };
  }
  const excluded = opportunity.mccs.filter((m) => capacity.mccsExcluded.includes(m));
  if (excluded.length > 0) {
    return {
      rule: "MCC_PRODUCT",
      code: "MCC_EXCLUDED",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("MCC_EXCLUDED"),
      message: `MCC(s) explicitly excluded by this provider: ${excluded.join(", ")}.`,
    };
  }
  const uncovered = opportunity.mccs.filter((m) => !capacity.mccsAccepted.includes(m));
  if (uncovered.length > 0) {
    return {
      rule: "MCC_PRODUCT",
      code: "MCC_NOT_ACCEPTED",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("MCC_NOT_ACCEPTED"),
      message: `MCC(s) not accepted by this provider: ${uncovered.join(", ")}.`,
    };
  }
  return pass("MCC_PRODUCT", "MCC_COVERED", `All requested MCC(s) accepted: ${opportunity.mccs.join(", ")}.`);
}

/**
 * VOLUME_TICKET — scope: "Absolute min/max or capacity breach." Always
 * contributes exactly TWO findings (never merged into one, so a caller
 * can distinguish a capacity-headroom problem from a ticket-size
 * problem): (1) capacity headroom, always evaluable from the schema as
 * built; (2) ticket-size fit, only a REAL check when
 * `context.averageTicketMinor` is supplied — Opportunity's own schema
 * carries no ticket-size field at all (structurally absent, D8 part 2,
 * not merely sometimes-missing), so its absence yields an explicit
 * non-blocking UNKNOWN finding rather than either a silent pass or a
 * permanent hard block that the schema could never satisfy.
 *
 * Headroom compares CapacityProfile.monthlyCapacityMinor against
 * Opportunity.movable30dMinor (see types.ts's MatchOpportunityInput.
 * movable30dMinor doc comment for why that specific field is "monthly
 * demand" here) ONLY when currencies match — a cross-currency comparison
 * of raw minor-unit figures would be meaningless without an FX rate this
 * package has no business computing. When currencies differ, this rule
 * reports UNKNOWN (non-blocking) and defers the hard call to the
 * SETTLEMENT rule, which owns currency mismatches — avoiding two rule
 * families both hard-blocking the exact same root cause under different
 * names.
 */
function checkVolumeTicket(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput, context: MatchContext): RuleResult[] {
  const results: RuleResult[] = [];

  if (!capacity.acceptingNewVolume) {
    results.push({
      rule: "VOLUME_TICKET",
      code: "VOLUME_NOT_ACCEPTING",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("VOLUME_NOT_ACCEPTING"),
      message: "Provider is not currently accepting new volume.",
    });
  } else if (opportunity.currency !== capacity.currency) {
    results.push({
      rule: "VOLUME_TICKET",
      code: "VOLUME_CURRENCY_MISMATCH",
      status: "UNKNOWN",
      blocking: false,
      overridable: overridableFor("VOLUME_CURRENCY_MISMATCH"),
      message: `Cannot compare volume across mismatched currencies (opportunity: ${opportunity.currency}; capacity: ${capacity.currency}) — see the SETTLEMENT rule.`,
    });
  } else {
    const ratio = bigintRatio(capacity.monthlyCapacityMinor, opportunity.movable30dMinor);
    if (ratio < MATCHING_CONFIG.volumeHeadroomRatioBand.min) {
      results.push({
        rule: "VOLUME_TICKET",
        code: "VOLUME_INSUFFICIENT_HEADROOM",
        status: "INELIGIBLE",
        blocking: true,
        overridable: overridableFor("VOLUME_INSUFFICIENT_HEADROOM"),
        message: `Insufficient capacity headroom (capacity ${capacity.monthlyCapacityMinor} ${capacity.currency}/mo vs. ~${opportunity.movable30dMinor} ${opportunity.currency}/mo near-term demand).`,
      });
    } else {
      results.push(pass("VOLUME_TICKET", "VOLUME_HEADROOM_OK", `Capacity headroom ratio ${Number.isFinite(ratio) ? ratio.toFixed(2) : "∞"}x meets the ${MATCHING_CONFIG.volumeHeadroomRatioBand.min}x minimum.`));
    }
  }

  if (context.averageTicketMinor === undefined) {
    results.push({
      rule: "VOLUME_TICKET",
      code: "TICKET_SIZE_NOT_SUPPLIED",
      status: "UNKNOWN",
      blocking: false,
      overridable: overridableFor("TICKET_SIZE_NOT_SUPPLIED"),
      message: "Ticket-size fit not checked — no average ticket figure supplied (Opportunity's schema does not carry one; supply via context.averageTicketMinor for a real check).",
    });
  } else {
    assertFiniteNonNegative(context.averageTicketMinor, "context.averageTicketMinor");
    const belowMin = context.averageTicketMinor < capacity.minTicketMinor;
    const aboveMax = capacity.maxTicketMinor > 0 && context.averageTicketMinor > capacity.maxTicketMinor;
    if (belowMin || aboveMax) {
      results.push({
        rule: "VOLUME_TICKET",
        code: "TICKET_SIZE_OUT_OF_RANGE",
        status: "INELIGIBLE",
        blocking: true,
        overridable: overridableFor("TICKET_SIZE_OUT_OF_RANGE"),
        message: `Average ticket ${context.averageTicketMinor} minor units outside provider's accepted range [${capacity.minTicketMinor}, ${capacity.maxTicketMinor || "∞"}].`,
      });
    } else {
      results.push(pass("VOLUME_TICKET", "TICKET_SIZE_OK", `Average ticket ${context.averageTicketMinor} minor units within provider's accepted range.`));
    }
  }

  return results;
}

/**
 * EVIDENCE_LICENSE — scope: "Mandatory license/evidence absent or
 * expired." `context.providerPassportStatus` is the PROVIDER's real
 * Passport status (earlier, packages/evidence's ReadinessResult engine +
 * packages/domain's PassportStatus state machine — "Passport readiness
 * is an input" per this day's own build brief). READY/VERIFIED pass;
 * DRAFT/INCOMPLETE/SUSPENDED are "absent"; STALE is "expired" — both
 * map onto the scope's own "absent or expired" phrase exactly. Absent
 * input (the caller never looked it up) is FAIL-CLOSED (BLOCKED), unlike
 * this file's other context-dependent rules — the real system already
 * exists (unlike TECHNICAL/ROLE's structurally-unmodeled data, or
 * COMPLIANCE_HOLD's nonexistent backend), so a missing lookup here reads
 * as a caller oversight, not a legitimate absence. Matches
 * @tol/authz's own deny-by-default discipline.
 */
function checkEvidenceLicense(context: MatchContext): RuleResult {
  const status = context.providerPassportStatus;
  if (status === undefined) {
    return {
      rule: "EVIDENCE_LICENSE",
      code: "EVIDENCE_LICENSE_UNKNOWN",
      status: "UNKNOWN",
      blocking: true,
      overridable: overridableFor("EVIDENCE_LICENSE_UNKNOWN"),
      message: "Cannot verify mandatory evidence/license readiness — provider Passport status was not supplied (fail-closed).",
    };
  }
  if (status === "READY" || status === "VERIFIED") {
    return pass("EVIDENCE_LICENSE", "EVIDENCE_LICENSE_READY", `Provider Passport status is ${status}.`);
  }
  const reason = status === "STALE" ? "expired (STALE)" : `absent (${status})`;
  return {
    rule: "EVIDENCE_LICENSE",
    code: "EVIDENCE_LICENSE_NOT_READY",
    status: "BLOCKED",
    blocking: true,
    overridable: overridableFor("EVIDENCE_LICENSE_NOT_READY"),
    message: `Mandatory evidence/license is ${reason} — provider Passport status is ${status}, not READY/VERIFIED.`,
  };
}

/**
 * RISK — scope: "Hard chargeback/fraud limit exceeded." CapacityProfile
 * carries real ceilings (maxChargebackBps/maxFraudBps/maxRefundBps);
 * Opportunity's own thin schema carries no merchant-side risk history
 * (RiskSnapshot is not modeled on Opportunity — see types.ts's
 * MerchantRiskProfileInput doc comment), so the comparison figures come
 * from `context.merchantRiskProfile`, typically resolved by the caller
 * from the merchant's own Passport RISK-section Facts. Genuinely absent
 * is a neutral, NON-blocking UNKNOWN (a brand-new merchant with no
 * processed volume yet is normal), unlike EVIDENCE_LICENSE's fail-closed
 * stance — deliberately different defaults for two different reasons,
 * both documented rather than uniform-by-accident.
 */
function checkRisk(capacity: MatchCapacityInput, context: MatchContext): RuleResult {
  const rp = context.merchantRiskProfile;
  if (!rp || (rp.chargebackBps === undefined && rp.fraudBps === undefined && rp.refundBps === undefined)) {
    return {
      rule: "RISK",
      code: "RISK_NO_HISTORY",
      status: "UNKNOWN",
      blocking: false,
      overridable: overridableFor("RISK_NO_HISTORY"),
      message: "No merchant risk history supplied yet — treated as a normal new-entrant state, not a blocker.",
    };
  }

  const breaches: string[] = [];
  if (rp.chargebackBps !== undefined) {
    assertFiniteNonNegative(rp.chargebackBps, "context.merchantRiskProfile.chargebackBps");
    if (rp.chargebackBps > capacity.maxChargebackBps) breaches.push(`chargeback ${rp.chargebackBps}bps > ceiling ${capacity.maxChargebackBps}bps`);
  }
  if (rp.fraudBps !== undefined) {
    assertFiniteNonNegative(rp.fraudBps, "context.merchantRiskProfile.fraudBps");
    if (rp.fraudBps > capacity.maxFraudBps) breaches.push(`fraud ${rp.fraudBps}bps > ceiling ${capacity.maxFraudBps}bps`);
  }
  if (rp.refundBps !== undefined) {
    assertFiniteNonNegative(rp.refundBps, "context.merchantRiskProfile.refundBps");
    if (rp.refundBps > capacity.maxRefundBps) breaches.push(`refund ${rp.refundBps}bps > ceiling ${capacity.maxRefundBps}bps`);
  }

  if (breaches.length > 0) {
    return {
      rule: "RISK",
      code: "RISK_CEILING_EXCEEDED",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("RISK_CEILING_EXCEEDED"),
      message: `Hard risk ceiling exceeded: ${breaches.join("; ")}.`,
    };
  }
  return pass("RISK", "RISK_WITHIN_CEILING", "Merchant risk history within all configured ceilings.");
}

/**
 * SETTLEMENT — scope: "Required currency/rail unsupported." Currency is
 * always checked (a mandatory field on both sides). Rail is only checked
 * when `context.requiredSettlementRail` is supplied — CapacityProfile
 * has exactly one settlementRail value (not an array of supported
 * rails), so "unsupported" only has meaning relative to an explicit
 * requirement, which nothing in Opportunity's own schema states today.
 */
function checkSettlement(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput, context: MatchContext): RuleResult {
  if (opportunity.currency !== capacity.currency) {
    return {
      rule: "SETTLEMENT",
      code: "SETTLEMENT_CURRENCY_UNSUPPORTED",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("SETTLEMENT_CURRENCY_UNSUPPORTED"),
      message: `Settlement currency ${opportunity.currency} not supported by this provider (settles in ${capacity.currency}).`,
    };
  }
  if (context.requiredSettlementRail && context.requiredSettlementRail !== capacity.settlementRail) {
    return {
      rule: "SETTLEMENT",
      code: "SETTLEMENT_RAIL_UNSUPPORTED",
      status: "INELIGIBLE",
      blocking: true,
      overridable: overridableFor("SETTLEMENT_RAIL_UNSUPPORTED"),
      message: `Required settlement rail "${context.requiredSettlementRail}" not supported by this provider (offers "${capacity.settlementRail}").`,
    };
  }
  return pass("SETTLEMENT", "SETTLEMENT_OK", `Currency ${capacity.currency} and settlement rail "${capacity.settlementRail}" both acceptable.`);
}

/**
 * TECHNICAL — scope: "Mandatory gateway/3DS/tokenization constraint
 * unsupported." CapacityProfile's schema carries no TechnicalCapability
 * field at all (structurally absent — see schema.prisma's own comment
 * on CapacityProfile folding p.16's capability groups into a mix of
 * scalar columns and `commercialTerms` JSON, neither of which includes
 * gateway/3DS/tokenization support). Always reports a non-blocking
 * UNKNOWN, same "structurally-absent, not operationally-missing"
 * treatment as ROLE, above — see ADR-0012.
 */
function checkTechnical(): RuleResult {
  return {
    rule: "TECHNICAL",
    code: "TECHNICAL_NOT_EVALUATED",
    status: "UNKNOWN",
    blocking: false,
    overridable: overridableFor("TECHNICAL_NOT_EVALUATED"),
    message: "Technical/gateway/3DS/tokenization fit not evaluated — CapacityProfile's schema does not yet carry a TechnicalCapability field (ADR-0012).",
  };
}

/**
 * FRESHNESS — scope: "Capacity profile stale beyond tolerance ->
 * REFRESH_REQUIRED." `capacity.freshnessClass` is server-computed by
 * @tol/evidence's classifyCapacityFreshness (earlier, P8) — this rule
 * trusts it rather than recomputing. STALE hard-blocks but is
 * operator-overridable (an operator can vouch for currency the
 * classifier can't see). UNKNOWN hard-blocks and is NON-overridable —
 * the spec verbatim: "UNKNOWN — discovery lead only; not counted as
 * active marketplace capacity," which reads as an absolute rule, not a
 * soft one. AGING is a non-blocking WARNING carrying the SAME
 * REFRESH_REQUIRED status code family (the spec: "AGING — still usable
 * but ranking penalty applies" — the penalty is ranking.ts's
 * providerReliabilityFreshness factor, not a hard eligibility block).
 */
function checkFreshness(capacity: MatchCapacityInput): RuleResult {
  switch (capacity.freshnessClass) {
    case "FRESH":
      return pass("FRESHNESS", "FRESHNESS_FRESH", "Capacity profile is FRESH.");
    case "AGING":
      return {
        rule: "FRESHNESS",
        code: "FRESHNESS_AGING",
        status: "REFRESH_REQUIRED",
        blocking: false,
        overridable: overridableFor("FRESHNESS_AGING"),
        message: "Capacity profile is AGING — still eligible, but a ranking penalty applies and a refresh is recommended.",
      };
    case "STALE":
      return {
        rule: "FRESHNESS",
        code: "FRESHNESS_STALE",
        status: "REFRESH_REQUIRED",
        blocking: true,
        overridable: overridableFor("FRESHNESS_STALE"),
        message: "Capacity profile is STALE beyond tolerance — refresh required before this route can be auto-invited.",
      };
    case "UNKNOWN":
      return {
        rule: "FRESHNESS",
        code: "FRESHNESS_UNKNOWN",
        status: "REFRESH_REQUIRED",
        blocking: true,
        overridable: overridableFor("FRESHNESS_UNKNOWN"),
        message: "Capacity freshness is UNKNOWN (discovery lead only, the spec) — not counted as active marketplace capacity.",
      };
    default: {
      // Runtime hardening for out-of-enum input reaching this package
      // from a cast or a future schema drift — same discipline as
      // @tol/domain's *-states.ts guard functions (2026-08-18 hardening
      // pass, the build log's "domain-guard hardening" changelog entry).
      const unexpected: never = capacity.freshnessClass;
      throw new EligibilityInputError(`capacity.freshnessClass is not a recognized FreshnessClassLike, got ${String(unexpected)}`);
    }
  }
}

/**
 * COMPLIANCE_HOLD — scope: "Sanctions/watchlist/identity conflict
 * unresolved -> BLOCKED." No compliance/sanctions-screening system
 * exists in this repo yet (P17/packages/connectors are unbuilt) — absent
 * `context.complianceHold` is treated as "no known hold" (PASS), the
 * ONE deliberate exception to this file's general fail-closed-on-
 * missing-mandatory-input stance (contrast EVIDENCE_LICENSE, above,
 * where the real system already exists). Failing closed here with zero
 * real data source behind it would make this gate permanently
 * unsatisfiable rather than honestly reflecting "nothing to report yet"
 * — flagged explicitly in ADR-0012, not a silent gap.
 */
function checkComplianceHold(context: MatchContext): RuleResult {
  if (!context.complianceHold || !context.complianceHold.active) {
    return pass("COMPLIANCE_HOLD", "COMPLIANCE_HOLD_NONE_KNOWN", "No known compliance/sanctions hold (no screening system wired up yet — ADR-0012).");
  }
  return {
    rule: "COMPLIANCE_HOLD",
    code: "COMPLIANCE_HOLD_ACTIVE",
    status: "BLOCKED",
    blocking: true,
    overridable: overridableFor("COMPLIANCE_HOLD_ACTIVE"),
    message: context.complianceHold.reason ? `Compliance hold active: ${context.complianceHold.reason}.` : "Compliance hold active (unresolved sanctions/watchlist/identity conflict).",
  };
}

/**
 * Evaluates one Opportunity/CapacityProfile pair against every scope
 * p.19 rule family. Pure and deterministic: identical `opportunity` +
 * `capacity` + `context` (including `context.now`) produce a deep-equal
 * `EligibilityResult` every time — eligibility.test.ts proves this
 * directly with hundreds of repeated calls, not just by inspection of
 * the code (same discipline as @tol/attribution's 500-call scoreClaim
 * proof).
 *
 * `eligible` is true iff `blockers` is empty. `results` always contains
 * every rule family named in ELIGIBILITY_RULE_FAMILIES at least once
 * (VOLUME_TICKET contributes two).
 */
export function evaluateEligibility(opportunity: MatchOpportunityInput, capacity: MatchCapacityInput, context: MatchContext): EligibilityResult {
  validateOpportunity(opportunity);
  validateCapacity(capacity);

  const results: RuleResult[] = [
    checkRole(),
    checkJurisdiction(opportunity, capacity),
    checkMccProduct(opportunity, capacity),
    ...checkVolumeTicket(opportunity, capacity, context),
    checkEvidenceLicense(context),
    checkRisk(capacity, context),
    checkSettlement(opportunity, capacity, context),
    checkTechnical(),
    checkFreshness(capacity),
    checkComplianceHold(context),
  ];

  const blockers = results.filter((r) => r.status !== "PASS" && r.blocking);
  const warnings = results.filter((r) => r.status !== "PASS" && !r.blocking);

  return {
    eligible: blockers.length === 0,
    results,
    blockers,
    warnings,
    ruleVersion: context.ruleVersion ?? MATCHING_CONFIG.ruleVersion,
    inputVersions: context.inputVersions ? [...context.inputVersions] : [],
    evaluatedAt: context.now.toISOString(),
  };
}
