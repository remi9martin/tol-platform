// packages/attribution/src/types.ts
//
// the spec (directness vocabulary, verbatim D5-D0) + p.14 (evidence
// provenance vocabulary, reused for ClaimEvidence.verificationState) +
// p.18 (the four scoring factors + their "Evidence examples" column,
// which this file's ClaimEvidenceType enum is grounded in).
//
// DirectnessTier/ClaimEvidenceType/EvidenceVerificationState are declared
// HERE as this package's own copy because @tol/attribution has ZERO
// runtime dependencies (same discipline as @tol/domain/@tol/authz/
// @tol/crypto — see this package's README) and cannot import @tol/domain
// at runtime. @tol/domain's claim-states.ts (this stage of this day's build)
// declares the SAME vocabulary as the canonical, DB/authz-facing copy and
// cross-checks against this file's copy in ITS OWN test suite — exactly
// the LockboxShareRole precedent (packages/domain/src/lockbox-states.ts's
// own header comment: "Kept byte-identical to @tol/crypto's own copy...
// guarded by this file's own test asserting the two arrays are equal"),
// just built in the opposite chronological order (attribution ships in
// this stage, domain's claim vocabulary in this stage, so the cross-check test
// necessarily lives in the file, not this one).

export const DIRECTNESS_TIERS = ["D5", "D4", "D3", "D2", "D1", "D0"] as const;
export type DirectnessTier = (typeof DIRECTNESS_TIERS)[number];
export function isDirectnessTier(value: string): value is DirectnessTier {
  return (DIRECTNESS_TIERS as readonly string[]).includes(value);
}

/** the spec verbatim descriptions — kept here (not just in packages/domain) so this package's own tests and any consumer reading this file alone can see exactly what each tier means without cross-referencing another package. */
export const DIRECTNESS_TIER_LABELS: Record<DirectnessTier, string> = {
  D5: "Counterparty executive/authorized owner directly acknowledges the relationship.",
  D4: "Direct operating/commercial decision-maker with demonstrated business interaction.",
  D3: "Direct employee contact but authority is uncertain or one step removed.",
  D2: "Known intermediary with named next hop.",
  D1: "Generic mailbox, list, social connection, or unverified claim.",
  D0: "Public knowledge only; creates no attribution.",
};

/**
 * the spec's "Evidence examples" column, decomposed into a closed type
 * set: "Email/thread, counterparty acknowledgment, contract, CRM
 * provenance". OTHER is an escape hatch for evidence that doesn't cleanly
 * fit the other four — not scope-verbatim, a documented inference, same
 * discipline this codebase uses for every other undefined-enum-value call
 * (e.g. @tol/domain/opportunity-states.ts's OpportunityType comment).
 */
export const CLAIM_EVIDENCE_TYPES = ["CONTRACT", "COUNTERPARTY_ACKNOWLEDGMENT", "EMAIL_THREAD", "CRM_RECORD", "OTHER"] as const;
export type ClaimEvidenceType = (typeof CLAIM_EVIDENCE_TYPES)[number];
export function isClaimEvidenceType(value: string): value is ClaimEvidenceType {
  return (CLAIM_EVIDENCE_TYPES as readonly string[]).includes(value);
}

/**
 * the spec "Evidence provenance" vocabulary, reused verbatim minus
 * OUTCOME_LEARNED/INFERRED — those describe values the PLATFORM derives
 * from outcomes/inference after the fact, not something a claimant or
 * reviewer submits as evidence FOR a claim at filing/review time.
 */
export const EVIDENCE_VERIFICATION_STATES = [
  "SELF_REPORTED",
  "DOCUMENT_EXTRACTED",
  "API_VERIFIED",
  "COUNTERPARTY_CONFIRMED",
  "OPERATOR_VERIFIED",
] as const;
export type EvidenceVerificationState = (typeof EVIDENCE_VERIFICATION_STATES)[number];
export function isEvidenceVerificationState(value: string): value is EvidenceVerificationState {
  return (EVIDENCE_VERIFICATION_STATES as readonly string[]).includes(value);
}

export interface ClaimEvidenceInput {
  evidenceType: ClaimEvidenceType;
  verificationState: EvidenceVerificationState;
}

/** Per-item explainability record — WHY this evidence item contributed exactly this many points. Returned alongside the factor total so a caller (apps/api's claims module, apps/web's claim detail screen) never has to re-derive "why" from the total alone. */
export interface ClaimEvidenceContribution {
  index: number;
  evidenceType: ClaimEvidenceType;
  verificationState: EvidenceVerificationState;
  basePoints: number;
  multiplier: number;
  contribution: number;
}

export interface ClaimScoringInput {
  /** HISTORY (40%) — the spec: "Completed deals, signed agreements, prior compensation, acknowledged activity." Months of demonstrated prior commercial history between claimant and the subject relationship. */
  priorCommercialHistoryMonths: number;
  /** PROXIMITY (30%) — the spec's directness vocabulary, verbatim (D0-D5). */
  directnessTier: DirectnessTier;
  /** EVIDENCE (20%) — each item scored by type + verification state, summed and capped at 100 (see scoring.ts's scoreEvidence). */
  evidenceItems: readonly ClaimEvidenceInput[];
  /** TIME (10%) — days between the claim becoming eligible to file and its actual submission. Lower is better; this is deliberately the LIGHTEST weight of the four (the spec: "Timestamp of qualifying claim, not public-name entry"). */
  submissionLagDays: number;
  /** the spec: "All derived outputs record inputVersion(s)... so historical decisions can be reproduced." Echoed back verbatim on the returned breakdown; defaults to an empty array when omitted. This package has no opinion on what a version STRING means (a hash, a semver, a source-document revision id) — that is the caller's concern. */
  inputVersions?: readonly string[];
}

/**
 * the spec: derived outputs must record algorithmVersion/inputVersions
 * so historical decisions can be reproduced. `computedAt` deliberately
 * does NOT appear here — this package never reads a clock (see
 * scoring.ts's header comment) — the caller (apps/api's claims service)
 * stamps a real `scoredAt` timestamp on the persisted Claim row itself
 * when it calls scoreClaim(), the same way apps/api's lockbox service
 * computes `sealedAt = new Date()` OUTSIDE @tol/crypto's pure sealPayload().
 */
export interface ClaimScoreBreakdown {
  history: number;
  proximity: number;
  evidence: number;
  time: number;
  /** Weighted sum of the four factors, BEFORE the D0 anti-squatting ceiling (see scoring.ts's scoreClaim). Equal to `total` whenever that ceiling doesn't bind. */
  weighted: number;
  /** The claim's actual score — what ranking.ts's rankClaims sorts by. */
  total: number;
  /** Present ONLY when the D0 anti-squatting ceiling actually reduced `weighted` down to `total` — see scoring.ts's scoreClaim doc comment. */
  cappedFrom?: number;
  /** The EVIDENCE factor's pre-ceiling sum (scoring.ts's scoreEvidence own `rawTotal`) — present whenever it differs from `evidence` (i.e. the 100-point evidence ceiling actually bound), so a caller/UI can show "evidence would have scored N, capped at 100" the same way `cappedFrom` does for the top-level D0 rule. Absent when the ceiling didn't bind (rawTotal === evidence already). review (review) correctly noted the per-factor evidence ceiling had no equivalent transparency to the top-level `cappedFrom` — this field closes that gap. */
  evidenceRawTotal?: number;
  evidenceBreakdown: readonly ClaimEvidenceContribution[];
  algorithmVersion: string;
  inputVersions: readonly string[];
}
