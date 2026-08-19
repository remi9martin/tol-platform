// packages/attribution/src/config.ts
//
// the spec's Attribution factor table, verbatim:
//   Commercial history        || 40% || Completed deals, signed agreements, prior compensation, acknowledged activity
//   Decision-maker proximity  || 30% || Authorized commercial/risk/partner contact; directness tier
//   Evidence quality          || 20% || Email/thread, counterparty acknowledgment, contract, CRM provenance
//   Submission timing         || 10% || Timestamp of qualifying claim, not public-name entry
//
// NOTE ON THE REUSE-REFERENCE PROTOTYPE: ../../the prototype repo/lib/
// attribution.ts (read for scoring SHAPE guidance only, per this day's
// build instructions — never edited, see this package's README) uses
// DIFFERENT weights (35/30/20/15). Cross-checked directly against
// the spec: the scope's own table is
// unambiguous (40/30/20/10) and is authoritative over the prototype's
// invented numbers — see ADR-0010. Everything else about the
// prototype's approach (four named factors, an origin/tier ceiling
// mechanism, live per-claim computation, an explainable breakdown object)
// carried over in spirit; only the weight VALUES were corrected to match
// the primary source, and the ceiling mechanism was re-anchored to the
// scope's own D0-D5 directness vocabulary instead of the prototype's
// free-text "originType" (which has no basis in the build spec).

/**
 * Recursively Object.freezes a value and every plain-object/array it
 * contains. `as const` (used below) only stops mutation at the TYPE
 * level for typed callers — it is erased at runtime and does nothing to
 * stop an `any`-typed caller, a JS caller, or a bracket-notation write
 * from mutating this module-level singleton through a reference to ANY
 * nested piece of it (e.g. a caller holding `ATTRIBUTION_CONFIG.weights`
 * directly). Because this config is a shared object imported once per
 * process, an unguarded mutation would silently corrupt scoring for
 * every other concurrent request, not just the caller that mutated it —
 * exactly the kind of silent-wrong-answer this codebase's engines are
 * built never to produce (see scoring.ts's own anti-fabrication
 * discipline). `Object.freeze` throws a real TypeError on a mutation
 * attempt because this package is ESM (`"type": "module"`, always
 * strict mode) — fail loud, not silently ignored.
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

export const ATTRIBUTION_CONFIG = deepFreeze({
  /** Bumped only on a genuine change to this file's scoring math — every persisted Claim.algorithmVersion is a direct stamp of this constant (the spec: "record... algorithmVersion... so historical decisions can be reproduced"). */
  algorithmVersion: "attribution-v1",

  /** the spec table, verbatim. Must sum to 1 — scoring.test.ts asserts this directly so a future edit can't silently drift the weights off 100%. */
  weights: {
    history: 0.4,
    proximity: 0.3,
    evidence: 0.2,
    time: 0.1,
  },

  /** HISTORY factor's normalization band, in months of demonstrated prior commercial history. Not scope-specified numerically — a documented inference (36 months = 3 years, a reasonable "fully mature" relationship horizon for a B2B payments marketplace); configurable/revisitable, same as every other band constant in this file. Values are clamped to [0, 100] at the ends, never extrapolated past them (scoring.ts's normalize). */
  historyMonthsBand: { min: 0, max: 36 },

  /** TIME factor's normalization band, in days of lag between a claim becoming eligible to file and its actual submission. Not scope-specified numerically — documented inference (60 days = roughly one quarter's grace window). Inverted at scoring time (fewer days = higher score) via scoring.ts's normalizeInvert. */
  submissionLagDaysBand: { min: 0, max: 60 },

  /**
   * PROXIMITY factor: the spec's D5-D0 directness vocabulary mapped
   * onto a fixed 0-100 point scale. Not scope-specified numerically (the
   * scope names the six tiers and their meanings, not point values) —
   * documented inference, spaced to reflect the qualitative gaps p.13's
   * own descriptions imply (D5/D4 = real decision-maker involvement, a
   * wide gap down to D3's "authority uncertain," D2/D1 both weak but D1
   * weaker still, D0 = zero — enforced a SECOND time by
   * zeroAttributionTiers below, since 0-with-a-30%-weight alone is not
   * enough to satisfy scope's "creates no attribution" requirement on
   * its own — see scoring.ts's scoreClaim doc comment).
   */
  proximityScoreByTier: {
    D5: 100,
    D4: 80,
    D3: 60,
    D2: 35,
    D1: 15,
    D0: 0,
  },

  /**
   * EVIDENCE factor, part 1: base points per evidence type before its
   * verification-state multiplier applies. Not scope-specified
   * numerically — documented inference from p.18's own example list
   * ("Email/thread, counterparty acknowledgment, contract, CRM
   * provenance" — examples, not a ranking). CONTRACT ranked highest as
   * the most durable, hardest-to-fabricate artifact; COUNTERPARTY_
   * ACKNOWLEDGMENT close behind (a real statement from the other side of
   * the relationship); EMAIL_THREAD/CRM_RECORD lower (self-side
   * artifacts, easier to present without independent corroboration);
   * OTHER lowest (unclassified escape hatch).
   */
  evidenceBasePoints: {
    CONTRACT: 40,
    COUNTERPARTY_ACKNOWLEDGMENT: 35,
    EMAIL_THREAD: 20,
    CRM_RECORD: 15,
    OTHER: 5,
  },

  /**
   * EVIDENCE factor, part 2: multiplier by how independently verified
   * that evidence item is — the spec's provenance ladder, reused (see
   * types.ts). A SELF_REPORTED contract is still worth something (0.4x)
   * but far less than the same contract once OPERATOR_VERIFIED (1.0x) or
   * COUNTERPARTY_CONFIRMED (1.0x — a live acknowledgment from the other
   * side of the relationship carries equal weight to platform
   * verification).
   */
  evidenceVerificationMultiplier: {
    SELF_REPORTED: 0.4,
    DOCUMENT_EXTRACTED: 0.7,
    API_VERIFIED: 0.9,
    COUNTERPARTY_CONFIRMED: 1.0,
    OPERATOR_VERIFIED: 1.0,
  },

  /** EVIDENCE factor's own 0-100 ceiling — a claim with many strong items can't run past 100 on this ONE factor before the factor's own 20% weight applies. */
  evidenceScoreCeiling: 100,

  /**
   * ANTI-SQUATTING HARD RULE (the spec: "D0 — public knowledge only;
   * creates no attribution"; p.18 anti-gaming test: "Twenty public
   * provider names submitted with no relationship evidence yield zero
   * verified equity/attribution credit"). Any claim at one of these
   * directness tiers scores `total: 0`, full stop, regardless of its
   * other three factors — see scoring.ts's scoreClaim doc comment for
   * why this must be an explicit rule layered on top of the weighted sum
   * rather than left as an emergent consequence of D0's own proximity
   * weight (which alone would only zero out 30 of a possible 100
   * points).
   */
  zeroAttributionTiers: ["D0"],

  /** UI-facing score bands (tier.ts) — independent of a claim's actual workflow `status` (see tier.ts's own comment). Not scope-specified numerically — documented inference, matching the reuse-reference prototype's own thresholds (70/40), which this build keeps since nothing in the primary source argues for different cut points. */
  tierThresholds: { strong: 70, moderate: 40 },
} as const);
