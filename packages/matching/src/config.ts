// packages/matching/src/config.ts
//
// the spec (Eligibility rule table) + p.20 (Ranking factor table),
// both reproduced verbatim in this file's own comments so a reviewer can
// diff against the spec without cross-referencing another file.
// Every tunable constant this package uses lives HERE — same discipline
// as @tol/attribution/config.ts and @tol/evidence/config.ts.

/**
 * the spec table, verbatim:
 *   MCC / product fit               || 22% || Exact/conditional fit; provider-confirmed preferred
 *   Geography / licensing fit       || 17% || Entity + merchant + cardholder geography
 *   Volume / ticket fit             || 13% || Capacity headroom and ramp comfort
 *   Risk-history fit                || 13% || CB/fraud/refund/history alignment
 *   Settlement / currency fit       || 10% || Cadence, rail, reserve working-capital impact
 *   Commercial utility              || 10% || Net economics after known fees/reserve cost
 *   Technical / launch fit          || 7%  || Gateway, API, certification, expected time
 *   Provider reliability/freshness  || 5%  || Response SLA and capacity age
 *   Outcome-calibrated likelihood   || 3% initially || Grows only with validated data
 *
 * the spec: "Weights are illustrative starting defaults and must be
 * configurable by marketplace policy." This build honors "configurable"
 * by centralizing every weight here (a marketplace-policy admin surface
 * to edit them live is future work, not this pass's scope — same
 * "thin but honest" precedent as everywhere else in this repo).
 *
 * NOTE ON THE REUSE-REFERENCE PROTOTYPE: ../../the prototype repo/lib/
 * matching.ts (read for shape guidance only, per this day's build
 * instructions — never edited) implements a DIFFERENT 5-factor model
 * (economics/reserve/approvalProbability/capacity/settlementTiming,
 * weights 30/15/25/15/15) with no `algorithmVersion` stamped anywhere.
 * Cross-checked directly against the spec during this
 * build: the scope's own 9-factor table is authoritative over the
 * prototype's narrower one — see ADR-0012 (same "primary source
 * wins over prototype" precedent as D10's attribution-weight
 * correction).
 */
/**
 * Recursively Object.freezes a value and every plain-object/array it
 * contains. `as const` (used below) only stops mutation at the TYPE
 * level for typed callers — it is erased at runtime and does nothing to
 * stop an `any`-typed caller, a JS caller, or a bracket-notation write
 * from mutating this module-level singleton through a reference to ANY
 * nested piece of it (e.g. a caller holding `MATCHING_CONFIG.
 * rankingWeights` directly). Because this config is a shared object
 * imported once per process, an unguarded mutation would silently
 * corrupt eligibility/ranking for every other concurrent request, not
 * just the caller that mutated it — exactly the kind of silent-wrong-
 * answer this codebase's engines are built never to produce (see this
 * file's own anti-fabrication discipline note above). `Object.freeze`
 * throws a real TypeError on a mutation attempt because this package is
 * ESM (`"type": "module"`, always strict mode) — fail loud, not
 * silently ignored.
 *
 * Local to this file rather than a shared package export: this package
 * is a deliberate zero-runtime-dependency engine (package.json's own
 * description), so a small helper is duplicated per config file rather
 * than imported — same "reimplemented here in miniature rather than
 * imported" call this codebase already makes elsewhere (apps/api's
 * matching/service.ts, liveProviderPassportStatus doc comment).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const MATCHING_CONFIG = deepFreeze({
  /** the spec: "A rule change creates a new immutable RuleSetVersion." Bumped only on a genuine change to eligibility.ts's rule math/thresholds. */
  ruleVersion: "matching-eligibility-v1",
  /** the spec: "Every MatchResult stores... algorithm version." Bumped only on a genuine change to scoring.ts's ranking math/weights. */
  algorithmVersion: "matching-ranking-v1",

  /** the spec table, verbatim. Must sum to 1 — scoring.test.ts asserts this directly, AND assertRankingWeightsSumToOne() (scoring.ts) throws at module load if a future edit drifts them, same discipline as @tol/attribution's own assertWeightsSumToOne(). */
  rankingWeights: {
    mccProductFit: 0.22,
    geographyLicensingFit: 0.17,
    volumeTicketFit: 0.13,
    riskHistoryFit: 0.13,
    settlementCurrencyFit: 0.1,
    commercialUtility: 0.1,
    technicalLaunchFit: 0.07,
    providerReliabilityFreshness: 0.05,
    outcomeCalibratedLikelihood: 0.03,
  },

  /**
   * ADR-0004 (already decided before this day's build began):
   * "P12 Ranking's outcome-learning weight (the spec's ~3%
   * 'outcome-calibrated likelihood' factor) is a fixed placeholder (0,
   * or held constant) until real outcome data exists. No black-box
   * model controls invitations." A neutral midpoint (50, not 0) is used
   * so the one factor with no real signal yet reads as "not yet
   * measured" rather than "worst possible" when a caller/UI renders the
   * per-factor breakdown — D4's own wording authorizes either "0, or
   * held constant"; this is a documented choice of the latter, not a
   * deviation from D4.
   */
  outcomeCalibratedLikelihoodPlaceholder: 50,

  /** volumeTicketFit's normalization band: capacity-headroom-to-demand RATIO (e.g. 1.0 = exactly enough, no comfort margin; 5.0 = five times the near-term demand). Not scope-specified numerically ("ramp comfort" is named, not quantified) — documented inference, same discipline as @tol/attribution's historyMonthsBand. 1.0 is the floor because eligibility's own VOLUME_TICKET rule already requires >= 1.0x headroom to be eligible at all — ranking only ever sees candidates that already cleared that bar, so this band measures comfort ABOVE the minimum, not from zero. */
  volumeHeadroomRatioBand: { min: 1.0, max: 5.0 },

  /** settlementCurrencyFit's cadence-comfort band, in days. Reused verbatim from the reuse-reference prototype's own MATCH_CONFIG.bands.settlementDays (the prototype's `matching.ts`) — an already-vetted, reasonable band for this vertical, kept because nothing in the primary scope source argues for a different one (same "keep prototype numbers where the primary source is silent" call as @tol/attribution's tierThresholds). */
  settlementCadenceDaysBand: { min: 1, max: 10 },

  /** commercialUtility's fee-basis-points band. Reused verbatim from the same prototype file's MATCH_CONFIG.bands.feeBps, same reasoning as settlementCadenceDaysBand above. */
  commercialUtilityFeeBpsBand: { min: 80, max: 450 },

  /** mccProductFit's specificity penalty — see scoring.ts's scoreMccProductFit doc comment. Not scope-specified numerically; documented inference reflecting "provider-confirmed [exact fit] preferred" (p.20) over a provider that merely accepts a huge generic MCC list. */
  mccSpecificityPenaltyPerExtra: 2,
  mccSpecificityPenaltyCap: 20,

  /** technicalLaunchFit's fixed neutral score — CapacityProfile's schema carries no TechnicalCapability field at all yet (see eligibility.ts's TECHNICAL rule doc comment: structurally absent, not merely sometimes-missing). Distinct constant from outcomeCalibratedLikelihoodPlaceholder even though both currently resolve to a fixed number, so the two can be tuned independently once EITHER gets real backing data (technical capability schema vs. real outcome data are unrelated future changes). */
  technicalLaunchFitNeutralDefault: 70,

  /** riskHistoryFit's fixed neutral score for a merchant with no risk history supplied yet (a brand-new entrant — an expected state, not a data gap; see MerchantRiskProfileInput's own doc comment in types.ts). Distinct from technicalLaunchFitNeutralDefault for the same "independently tunable" reasoning. */
  riskHistoryFitNeutralDefault: 50,

  /** Generic "insufficient data to score this factor at all" fallback — used by volumeTicketFit (mismatched currency or zero near-term demand, neither of which yields a meaningful ratio) and commercialUtility (no commercialTerms on file yet). Kept as its OWN config key rather than reusing riskHistoryFitNeutralDefault even though both currently equal 50 — the two are conceptually unrelated knobs that happen to share a value today, same "independently tunable" reasoning as every other *NeutralDefault constant in this file. */
  neutralFactorDefault: 50,

  /**
   * the spec: "Operator override is possible only for overridable
   * warnings/blocks; prohibited rules can be marked NON_OVERRIDABLE."
   * The scope names the MECHANISM but not which specific rule codes are
   * overridable — this map is this build's own documented policy
   * choice, keyed by RuleResult.code (eligibility.ts is the single
   * source of every code this map needs to cover; eligibility.test.ts
   * asserts every non-PASS code eligibility.ts can ever emit has an
   * entry here, so a future new code can't silently fall through to the
   * default). Legal/regulatory-flavored codes (jurisdiction, MCC
   * prohibition, mandatory evidence, compliance holds) are
   * NON_OVERRIDABLE; operational/business-preference codes (capacity
   * headroom, risk appetite, settlement mechanics, freshness, technical
   * integration) are overridable — an operator with better information
   * than a possibly-stale profile can vouch for them. This package does
   * NOT implement the override ACTION itself (no mutation, no persisted
   * "overriddenBy") — only exposes the flag a future override endpoint
   * would gate on. Named explicitly as a deliberate scope cut in
   * ADR-0012, same "thin but honest, flagged not silent"
   * discipline as D8/D9/D10/D11's own named cuts.
   */
  overridableByCode: {
    ROLE_ASSUMED_COMPATIBLE: true,
    JURISDICTION_UNSPECIFIED: false,
    JURISDICTION_NO_OVERLAP: false,
    JURISDICTION_OVERLAP_OK: true,
    MCC_UNSPECIFIED: false,
    MCC_ACCEPTED_LIST_EMPTY: false,
    MCC_EXCLUDED: false,
    MCC_NOT_ACCEPTED: false,
    MCC_COVERED: true,
    VOLUME_NOT_ACCEPTING: true,
    VOLUME_CURRENCY_MISMATCH: true,
    VOLUME_INSUFFICIENT_HEADROOM: true,
    VOLUME_HEADROOM_OK: true,
    TICKET_SIZE_NOT_SUPPLIED: true,
    TICKET_SIZE_OUT_OF_RANGE: true,
    TICKET_SIZE_OK: true,
    EVIDENCE_LICENSE_NOT_READY: false,
    EVIDENCE_LICENSE_UNKNOWN: false,
    EVIDENCE_LICENSE_READY: true,
    RISK_NO_HISTORY: true,
    RISK_CEILING_EXCEEDED: true,
    RISK_WITHIN_CEILING: true,
    SETTLEMENT_CURRENCY_UNSUPPORTED: true,
    SETTLEMENT_RAIL_UNSUPPORTED: true,
    SETTLEMENT_OK: true,
    TECHNICAL_NOT_EVALUATED: true,
    FRESHNESS_STALE: true,
    FRESHNESS_UNKNOWN: false,
    FRESHNESS_AGING: true,
    FRESHNESS_FRESH: true,
    COMPLIANCE_HOLD_ACTIVE: false,
    COMPLIANCE_HOLD_NONE_KNOWN: true,
  } as Record<string, boolean>,
} as const);

/** Looks up MATCHING_CONFIG.overridableByCode, falling back to `false` (fail-closed / non-overridable) for any code the map doesn't recognize — a future new rule code that forgets to register its overridability here is safer defaulting to NON-overridable than silently defaulting to overridable. */
export function overridableFor(code: string): boolean {
  return MATCHING_CONFIG.overridableByCode[code] ?? false;
}
