// packages/domain/src/claim-states.ts
//
// the spec (directness vocabulary, Organization/Person/Relationship/
// Claim schema) + p.18 (Attribution scoring & dispute resolution, Journey
// A's claim lifecycle) + p.12 (base audit columns, "records inputVersion
// (s)... so historical decisions can be reproduced"). This file is the
// single source of truth for which Claim/ClaimDispute state transitions
// are legal — matching earlier phases's established convention (assertValid*
// throwing a typed DomainTransitionError subclass; apps/api's central
// error handler turns any instance into a clean 400, never a 500).
//
// SHARED VOCABULARY, CANONICAL COPY: DirectnessTier/ClaimEvidenceType/
// EvidenceVerificationState are declared HERE as this package's copy.
// @tol/attribution (this stage of this day's build, shipped first) declares
// its OWN independent copy for the same zero-runtime-dependency reason
// @tol/crypto re-declares LOCKBOX_SHARE_ROLES rather than importing
// @tol/domain (see this file's own LOCKBOX_SHARE_ROLES section below).
// The two copies are kept in sync by a hardcoded literal-equality
// assertion in EACH package's own test suite, NOT by a cross-package
// import — identical discipline to the existing LOCKBOX_SHARE_ROLES
// precedent (claim-states.test.ts asserts against a literal array here;
// @tol/attribution's own test suite does the same against its copy).
//
// THIN-SLICE DEVIATION FROM SCOPE'S LITERAL SCHEMA (full reasoning in
// ADR-0010): the spec models a separate `Relationship` entity
// (fromOrgId, toOrgId, relationshipType, firstSeenAt, lastConfirmedAt)
// that a `RelationshipClaim` then references via `relationshipId`. This
// build's `Claim` (packages/db/prisma/schema.prisma) COLLAPSES
// Relationship + RelationshipClaim into one table — a Claim embeds what
// would be the Relationship's own fields (subjectOrgId, relationshipType)
// directly, rather than requiring a separate Relationship row to exist
// first. Competing claims "about the same relationship" are grouped by
// (subjectOrgId, opportunityId) instead of a shared relationshipId
// foreign key. Same "thin but honest" discipline as ADR-0008 part
// 2 (Opportunity/CapacityProfile kept intentionally thin) — documented,
// not silently dropped; a later day promoting Relationship to its own
// table is additive (Claim keeps its own subjectOrgId/relationshipType
// columns either way), not a rewrite.
//
// CLAIM LIFECYCLE NAMING vs scope's Journey A: Journey A (persona
// journeys section) narrates "...claim remains SEALED or SUBMITTED ->
// operator verifies... -> claim becomes VERIFIED, PARTIAL, DISPUTED or
// REJECTED." This build renames Journey A's pre-decision "SEALED or
// SUBMITTED" pair to FILED -> SCORED: "SEALED" in that sentence describes
// the case where a claim's supporting evidence is itself sealed via
// Lockbox (P9, a different gate, already built earlier) — orthogonal to
// this file's own state machine, not a Claim status value. Every Claim,
// Lockbox-backed evidence or not, is FILED then immediately,
// deterministically SCORED by @tol/attribution before any human decision
// — matching this day's own "file claim -> score -> dispute -> decision"
// build instruction, and giving "has this claim been scored yet" its own
// visible, auditable status instead of folding it silently into FILED.

import { DomainTransitionError } from "./transition-error.js";

// =================================================================
// Shared vocabulary (canonical copy — see header comment)
// =================================================================

/** the spec verbatim (Directness/proximity vocabulary). */
export const DIRECTNESS_TIERS = ["D5", "D4", "D3", "D2", "D1", "D0"] as const;
export type DirectnessTier = (typeof DIRECTNESS_TIERS)[number];
export function isDirectnessTier(value: string): value is DirectnessTier {
  return (DIRECTNESS_TIERS as readonly string[]).includes(value);
}

/** the spec's "Evidence examples" column, decomposed — see @tol/attribution/src/types.ts's identical comment for the documented-inference reasoning (OTHER as an escape hatch). */
export const CLAIM_EVIDENCE_TYPES = ["CONTRACT", "COUNTERPARTY_ACKNOWLEDGMENT", "EMAIL_THREAD", "CRM_RECORD", "OTHER"] as const;
export type ClaimEvidenceType = (typeof CLAIM_EVIDENCE_TYPES)[number];
export function isClaimEvidenceType(value: string): value is ClaimEvidenceType {
  return (CLAIM_EVIDENCE_TYPES as readonly string[]).includes(value);
}

/** the spec "Evidence provenance" vocabulary, reused verbatim minus OUTCOME_LEARNED/INFERRED (platform-derived values, not something a claimant/reviewer submits as evidence for a claim). */
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

// =================================================================
// Claim.status
// =================================================================

export const CLAIM_STATUSES = ["FILED", "SCORED", "VERIFIED", "PARTIAL", "DISPUTED", "REJECTED", "EXPIRED", "WITHDRAWN"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export function isClaimStatus(value: string): value is ClaimStatus {
  return (CLAIM_STATUSES as readonly string[]).includes(value);
}

/**
 * FILED -> SCORED: system-driven (apps/api's claims service calls
 * @tol/attribution's scoreClaim() synchronously inside the same
 * transaction that creates the row — same "one API action, two audited
 * status hops" precedent as Lockbox's DRAFT/SEALED distinction, earlier).
 *
 * SCORED -> {VERIFIED, PARTIAL, REJECTED}: a reviewer's ClaimDecision,
 * scope Journey A's own three non-dispute outcomes (EXPIRED handled
 * separately below).
 *
 * SCORED -> DISPUTED, and — the spec anti-gaming test ("A later direct
 * executive relationship can defeat an earlier generic-mailbox claim") —
 * VERIFIED -> DISPUTED / PARTIAL -> DISPUTED too: a claim already decided
 * can still be challenged by a later, stronger competing claim. Nothing
 * in this build treats a decision as permanently final the instant it's
 * made.
 *
 * DISPUTED -> {VERIFIED, PARTIAL, REJECTED}: resolved by a NEW
 * ClaimDecision tied to the ClaimDispute that opened it (ClaimDecision.
 * disputeId) — the same terminal set SCORED can reach directly, reused
 * rather than duplicated.
 *
 * SCORED -> EXPIRED: the spec ("Provisional claims expire if the
 * contributor cannot validate the relationship within a configurable
 * window") — see isClaimProvisionalExpired below for why no worker
 * transitions a row here automatically yet (documented gap, the build log).
 *
 * {FILED, SCORED} -> WITHDRAWN: claimant self-withdraws before a decision
 * exists. Not offered from VERIFIED/PARTIAL/DISPUTED/REJECTED/EXPIRED —
 * once decided (or disputed, or expired), only a further decision closes
 * it out, not a unilateral claimant withdrawal.
 *
 * REJECTED/EXPIRED/WITHDRAWN are terminal.
 */
const CLAIM_TRANSITIONS: Record<ClaimStatus, ReadonlySet<ClaimStatus>> = {
  FILED: new Set(["SCORED", "WITHDRAWN"]),
  SCORED: new Set(["VERIFIED", "PARTIAL", "REJECTED", "DISPUTED", "EXPIRED", "WITHDRAWN"]),
  VERIFIED: new Set(["DISPUTED"]),
  PARTIAL: new Set(["DISPUTED"]),
  DISPUTED: new Set(["VERIFIED", "PARTIAL", "REJECTED"]),
  REJECTED: new Set([]),
  EXPIRED: new Set([]),
  WITHDRAWN: new Set([]),
};

export class InvalidClaimTransitionError extends DomainTransitionError {
  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidClaimTransitionError";
  }
}

/** No legitimate same-state re-transition exists for a Claim (same discipline as Lockbox — see lockbox-states.ts's own comment) — `from === to` is rejected structurally rather than silently accepted as a no-op. */
export function assertValidClaimTransition(from: ClaimStatus, to: ClaimStatus): void {
  // Runtime hardening: see opportunity-states.ts's identical comment — a
  // cast or unvalidated input could hand this an out-of-enum string, and
  // without this guard `CLAIM_TRANSITIONS[from]` would be undefined,
  // throwing a raw TypeError instead of the typed error the central handler
  // expects.
  if (!isClaimStatus(from) || !isClaimStatus(to)) {
    throw new InvalidClaimTransitionError("Claim", from, to);
  }
  if (from === to || !CLAIM_TRANSITIONS[from].has(to)) {
    throw new InvalidClaimTransitionError("Claim", from, to);
  }
}

// =================================================================
// ClaimDispute.status / resolution
// =================================================================

/** the spec: "claimId, challenger, basis, evidence, state, resolution" — `state` here (this build names the Prisma column `status`, see ADR-0010 on this naming choice). Deliberately just two values (not e.g. OPEN/UNDER_REVIEW/DECIDED) — this build has no separate "reviewer claimed this dispute" step; a dispute is either awaiting a decision or decided. */
export const CLAIM_DISPUTE_STATUSES = ["OPEN", "DECIDED"] as const;
export type ClaimDisputeStatus = (typeof CLAIM_DISPUTE_STATUSES)[number];
export function isClaimDisputeStatus(value: string): value is ClaimDisputeStatus {
  return (CLAIM_DISPUTE_STATUSES as readonly string[]).includes(value);
}

const CLAIM_DISPUTE_TRANSITIONS: Record<ClaimDisputeStatus, ReadonlySet<ClaimDisputeStatus>> = {
  OPEN: new Set(["DECIDED"]),
  DECIDED: new Set([]),
};

/** Reuses InvalidClaimTransitionError (parametrized by `entity`) rather than a second error class — same "one error family per domain concept, distinguished by the entity string" pattern this package already uses elsewhere is unnecessary to duplicate; apps/api's central handler catches DomainTransitionError generically regardless. */
export function assertValidClaimDisputeTransition(from: ClaimDisputeStatus, to: ClaimDisputeStatus): void {
  // Runtime hardening: see assertValidClaimTransition's identical comment
  // above — a cast or unvalidated input could hand this an out-of-enum
  // string, and without this guard `CLAIM_DISPUTE_TRANSITIONS[from]` would
  // be undefined, throwing a raw TypeError instead of the typed error the
  // central handler expects.
  if (!isClaimDisputeStatus(from) || !isClaimDisputeStatus(to)) {
    throw new InvalidClaimTransitionError("ClaimDispute", from, to);
  }
  if (from === to || !CLAIM_DISPUTE_TRANSITIONS[from].has(to)) {
    throw new InvalidClaimTransitionError("ClaimDispute", from, to);
  }
}

/**
 * the spec's own three-way framing, made concrete: existing contractual
 * rights / the stronger claim can be UPHELD (the original claim's
 * decision stands), the network can record shared/PARTIAL_ATTRIBUTION
 * ("do not force a false single winner"), or the challenger's position
 * can prevail (REJECTED_ORIGINAL). Set on the ClaimDispute row by the
 * SAME service call that records the resolving ClaimDecision — the two
 * are a matched pair (a service invariant enforced at the API layer,
 * this stage; this file only validates the STATE transition, not that the
 * paired resolution/decision values are semantically consistent with
 * each other — same division of labor as the rest of this package).
 */
export const CLAIM_DISPUTE_RESOLUTIONS = ["UPHELD_ORIGINAL", "PARTIAL_ATTRIBUTION", "REJECTED_ORIGINAL"] as const;
export type ClaimDisputeResolution = (typeof CLAIM_DISPUTE_RESOLUTIONS)[number];
export function isClaimDisputeResolution(value: string): value is ClaimDisputeResolution {
  return (CLAIM_DISPUTE_RESOLUTIONS as readonly string[]).includes(value);
}

// =================================================================
// ClaimDecision.decision / appealStatus
// =================================================================

/**
 * The reviewer's actual recorded outcome — deliberately NARROWER than
 * ClaimStatus's own VERIFIED/PARTIAL/DISPUTED/REJECTED set: DISPUTED is
 * a status a DISPUTE puts a claim INTO, never itself something a
 * reviewer decides ONTO a claim (a ClaimDecision always resolves OUT of
 * DISPUTED — or out of SCORED directly — into one of these three, never
 * INTO DISPUTED).
 */
export const CLAIM_DECISION_OUTCOMES = ["VERIFIED", "PARTIAL", "REJECTED"] as const;
export type ClaimDecisionOutcome = (typeof CLAIM_DECISION_OUTCOMES)[number];
export function isClaimDecisionOutcome(value: string): value is ClaimDecisionOutcome {
  return (CLAIM_DECISION_OUTCOMES as readonly string[]).includes(value);
}

/**
 * the spec Rules (verbatim): "Every resolution records rule version,
 * score breakdown, reviewer, reason, effective date, expiry AND APPEAL
 * STATUS." The appeal-FILING workflow itself (a challenger requesting
 * reconsideration of a ClaimDecision) is NOT built this pass — a
 * deliberate, documented thin-slice cut (ADR-0010), same
 * discipline as D8/D9's own scope cuts (e.g. Lockbox's release
 * `conditionRef` being structurally-but-not-cross-validated). The field
 * exists, defaults NONE, and is ready for a later day's appeal endpoint
 * to transition — not silently omitted.
 */
export const CLAIM_APPEAL_STATUSES = ["NONE", "PENDING", "GRANTED", "DENIED"] as const;
export type ClaimAppealStatus = (typeof CLAIM_APPEAL_STATUSES)[number];
export function isClaimAppealStatus(value: string): value is ClaimAppealStatus {
  return (CLAIM_APPEAL_STATUSES as readonly string[]).includes(value);
}

// =================================================================
// Provisional expiry (pure helper — no worker exists yet)
// =================================================================

/**
 * the spec: "Provisional claims expire if the contributor cannot
 * validate the relationship within a configurable window." A SCORED
 * claim (scored, not yet decided one way or the other) is "provisional"
 * in this sense — VERIFIED/PARTIAL/REJECTED/DISPUTED/WITHDRAWN claims are
 * no longer provisional (a decision, dispute, or withdrawal already
 * happened) and can never be considered "expired" by this function
 * regardless of their `provisionalExpiresAt` value.
 *
 * `apps/worker` does not exist in this codebase — same documented gap as
 * the `rfq-expiry` job (the build log: "RFQ.status has an EXPIRED
 * value in the enum but nothing transitions a row into it yet") — no
 * cron automatically moves a Claim into EXPIRED this pass. This pure,
 * side-effect-free function lets a READ path (or a later day's worker)
 * COMPUTE whether a claim's provisional window has lapsed on demand,
 * without needing a separately-maintained boolean that could drift out
 * of sync with the clock.
 */
export function isClaimProvisionalExpired(status: ClaimStatus, provisionalExpiresAt: Date | null, now: Date): boolean {
  if (status !== "SCORED") return false;
  if (!provisionalExpiresAt) return false;
  return now.getTime() > provisionalExpiresAt.getTime();
}
