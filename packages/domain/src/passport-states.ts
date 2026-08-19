// packages/domain/src/passport-states.ts
//
// the spec (Object || States table, verbatim): "Passport || DRAFT ->
// INCOMPLETE -> READY -> VERIFIED -> STALE -> SUSPENDED". the spec STATE
// RULE (verbatim): "Transitions happen through domain services, never
// arbitrary UI field edits. Every transition writes a DomainEvent and
// AuditEvent." apps/api's passport service calls
// assertValidPassportTransition() before persisting any status change —
// same discipline as every other *-states.ts file in this package.
//
// The scope draws Passport's row as one linear chain with NO "side
// states" callout (contrast the SAME table's Lockbox/RelationshipClaim
// rows, which explicitly say "X/Y side states" — Passport's row has no
// such note). Read literally, forward, that gives five hops:
// DRAFT->INCOMPLETE->READY->VERIFIED->STALE->SUSPENDED. A real system
// needs more than that one-way chain (same reasoning
// opportunity-states.ts's header comment already gives for its own
// diagram) — this file adds the backward/lateral edges below, each with
// its own justification, same discipline as that file:
//
//   - DRAFT -> READY is included directly (not just via INCOMPLETE) for
//     the degenerate case of a Passport with ZERO required Facts
//     configured (packages/evidence's REQUIRED_FACTS list could
//     theoretically be empty for a future org type) — readiness
//     recompute is what actually decides the destination state, this
//     file only says which destinations are LEGAL for a given origin.
//   - READY -> INCOMPLETE: a regression path — a required Fact gets
//     retracted (status RETIRED) or a Fact's supporting Evidence expires
//     and readiness recompute finds a new blocker. Symmetric to
//     opportunity-states.ts's MATCH_READY <-> READINESS_BLOCKED pair.
//   - VERIFIED -> INCOMPLETE / VERIFIED -> READY: a VERIFIED passport can
//     still regress if a Fact it was verified against is later retracted
//     or superseded — verification is a point-in-time human judgment
//     (like a ClaimDecision), not an immutable guarantee the underlying
//     Facts can never change.
//   - {READY, VERIFIED} -> STALE: system-driven, on-read (see
//     isPassportStale below) — freshness recompute finds the Passport's
//     Facts/Evidence have aged past their window WITHOUT anything having
//     been formally retracted (contrast the -> INCOMPLETE edges above,
//     which fire when a blocker actually reappears). A DRAFT/INCOMPLETE
//     passport is never "stale" — it was never complete enough to go
//     stale FROM; it is just still incomplete.
//   - STALE -> {INCOMPLETE, READY, VERIFIED}: once refreshed (new/
//     updated Facts or Evidence), a stale passport re-enters the normal
//     chain at whichever state its readiness recompute now supports —
//     including going straight back to VERIFIED without a fresh human
//     re-verification, since the underlying verified Facts themselves
//     didn't change, only their currency did (a documented design
//     choice, revisitable — see ADR-0011).
//   - SUSPENDED reachable from every NON-terminal state (operator
//     compliance hold, p.4: COMPLIANCE_REVIEWER "place holds" — a hold
//     does not wait for a specific lifecycle position) and recoverable
//     back to INCOMPLETE only (a suspension always requires a fresh
//     completeness re-check on release, never a silent snap-back to
//     wherever it was — the one deliberately NARROW recovery edge in
//     this file, mirroring Lockbox's similarly asymmetric WITHDRAWN
//     handling).
//
// SUSPENDED and (once entered) never anything else is NOT modeled as
// terminal — an operator can lift a hold — but re-entering only at
// INCOMPLETE, never directly back to READY/VERIFIED/STALE, is
// deliberate: a passport that was suspended must re-earn readiness
// through the normal recompute path, not resume mid-chain.

import { DomainTransitionError } from "./transition-error.js";

export const PASSPORT_STATUSES = ["DRAFT", "INCOMPLETE", "READY", "VERIFIED", "STALE", "SUSPENDED"] as const;
export type PassportStatus = (typeof PASSPORT_STATUSES)[number];
export function isPassportStatus(value: string): value is PassportStatus {
  return (PASSPORT_STATUSES as readonly string[]).includes(value);
}

const PASSPORT_TRANSITIONS: Record<PassportStatus, ReadonlySet<PassportStatus>> = {
  DRAFT: new Set(["INCOMPLETE", "READY", "SUSPENDED"]),
  INCOMPLETE: new Set(["READY", "SUSPENDED"]),
  READY: new Set(["INCOMPLETE", "VERIFIED", "STALE", "SUSPENDED"]),
  VERIFIED: new Set(["INCOMPLETE", "READY", "STALE", "SUSPENDED"]),
  STALE: new Set(["INCOMPLETE", "READY", "VERIFIED", "SUSPENDED"]),
  SUSPENDED: new Set(["INCOMPLETE"]),
};

export class InvalidPassportTransitionError extends DomainTransitionError {
  constructor(from: PassportStatus, to: PassportStatus) {
    super(`invalid Passport transition: ${from} -> ${to}`);
    this.name = "InvalidPassportTransitionError";
  }
}

/** Throws InvalidPassportTransitionError on an illegal edge; a same-state "transition" (from === to) is always rejected too — same discipline as every other assertValid*Transition in this package. */
export function assertValidPassportTransition(from: PassportStatus, to: PassportStatus): void {
  // Runtime hardening: see opportunity-states.ts's identical comment — a
  // cast or unvalidated input could hand this an out-of-enum string, and
  // without this guard `PASSPORT_TRANSITIONS[from]` would be undefined,
  // throwing a raw TypeError instead of the typed error the central handler
  // expects. Skipped by commit 8cb5b3b's guard-hardening pass (which
  // covered 5 named files' 9 guards; this file pre-existed that pass) —
  // added here for parity with every sibling *-states.ts guard, none of
  // which are missing it (concurrency-audit clean-window pass, a later).
  if (!isPassportStatus(from) || !isPassportStatus(to)) {
    throw new InvalidPassportTransitionError(from, to);
  }
  if (from === to || !PASSPORT_TRANSITIONS[from].has(to)) {
    throw new InvalidPassportTransitionError(from, to);
  }
}

// =================================================================
// Shared freshness vocabulary (canonical copy — packages/evidence
// declares its OWN independent copy for the same zero-runtime-
// dependency reason @tol/attribution re-declares DirectnessTier/etc
// rather than importing @tol/domain — see that package's types.ts
// header comment. The two copies are cross-checked by a hardcoded
// literal-equality assertion in EACH package's own test suite, the
// established LOCKBOX_SHARE_ROLES/DirectnessTier precedent.)
// =================================================================

/** the spec verbatim ("Freshness classes"). Shared by Passport Facts/Evidence (P6) and CapacityProfile (P8) — the exact reuse packages/evidence's own package.json description names. */
export const FRESHNESS_CLASSES = ["FRESH", "AGING", "STALE", "UNKNOWN"] as const;
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];
export function isFreshnessClass(value: string): value is FreshnessClass {
  return (FRESHNESS_CLASSES as readonly string[]).includes(value);
}

/** p.14 "Evidence provenance", verbatim, full 7-value list — see schema.prisma's FactProvenance enum comment for why this is wider than @tol/domain's own (Claim-scoped) EvidenceVerificationState. */
export const FACT_PROVENANCE_STATES = [
  "SELF_REPORTED",
  "DOCUMENT_EXTRACTED",
  "API_VERIFIED",
  "COUNTERPARTY_CONFIRMED",
  "OPERATOR_VERIFIED",
  "OUTCOME_LEARNED",
  "INFERRED",
] as const;
export type FactProvenance = (typeof FACT_PROVENANCE_STATES)[number];
export function isFactProvenance(value: string): value is FactProvenance {
  return (FACT_PROVENANCE_STATES as readonly string[]).includes(value);
}

/** Documented inference — see schema.prisma's PassportSectionType enum comment for the scope grounding. */
export const PASSPORT_SECTION_TYPES = ["IDENTITY", "RELATIONSHIP_HISTORY", "PROCESSING_METRICS", "RISK", "COMMERCIAL", "TECHNICAL"] as const;
export type PassportSectionType = (typeof PASSPORT_SECTION_TYPES)[number];
export function isPassportSectionType(value: string): value is PassportSectionType {
  return (PASSPORT_SECTION_TYPES as readonly string[]).includes(value);
}

export const EVIDENCE_SOURCE_KINDS = ["FILE", "API", "ATTESTATION"] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];
export function isEvidenceSourceKind(value: string): value is EvidenceSourceKind {
  return (EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Pure, side-effect-free, zero-clock-dependency helper — same "a READ
 * path can compute this on demand without a worker" precedent as
 * claim-states.ts's isClaimProvisionalExpired. A Passport currently at
 * READY or VERIFIED is a candidate to regress to STALE once its
 * readiness result itself ages past `maxAgeDays` WITHOUT a fresh
 * recompute — apps/api's passport service calls this on every READ and
 * (if stale) writes the transition through assertValidPassportTransition
 * before returning, matching the "compute live, persist opportunistically"
 * pattern this day's Capacity freshness classifier also uses. As of
 * earlier, apps/worker's own passport-readiness job ADDITIONALLY sweeps for
 * exactly this condition on a schedule (proactive reclassification of
 * records nobody is currently reading — ADR-0011 part 3's own
 * stated boundary for what a worker adds on top of the on-read path,
 * which stays exactly as it was and remains the source of correctness
 * for any live viewer).
 *
 * `maxAgeDays` must be a positive, finite number — always caller-
 * supplied from a fixed config constant in practice (never end-user
 * input), but validated here anyway (real fix, review: an unvalidated
 * non-positive value would make the `>` comparison below fail open in a
 * confusing way — e.g. a negative `maxAgeDays` makes ALMOST ANY positive
 * age register as "stale" immediately — rather than failing loudly at
 * the misconfiguration itself).
 */
export function isPassportReadinessStale(status: PassportStatus, lastComputedAt: Date | null, now: Date, maxAgeDays: number): boolean {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new TypeError(`isPassportReadinessStale: maxAgeDays must be a positive, finite number — got ${maxAgeDays}`);
  }
  if (status !== "READY" && status !== "VERIFIED") return false;
  if (!lastComputedAt) return false;
  const ageMs = now.getTime() - lastComputedAt.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * earlier: moved here from apps/api/src/modules/passport/service.ts's own
 * local copy (verbatim logic, zero behavior change) — apps/worker's own
 * passport-readiness job needs the EXACT same status-decision rule an
 * apps/api-triggered recompute uses, and duplicating this small but
 * genuinely business-meaningful decision table across two call sites
 * risked drift (a this stage job silently deciding READY differently than
 * apps/api's own read/write path would be a real correctness bug, not a
 * cosmetic one). Everything else about a readiness recompute
 * (snapshot-building, calling @tol/evidence's computeReadiness, persisting
 * ReadinessResult, writing audit/timeline events) stays where it already
 * was, un-shared — each call site's ORCHESTRATION shape legitimately
 * differs (apps/api has a RequestContext/Actor; apps/worker has neither),
 * only this pure DECISION function needed one canonical home.
 *
 * Total decision table over every reachable PassportStatus. SUSPENDED
 * never auto-transitions (a compliance hold lifts only through an
 * explicit future action). VERIFIED persists across a still-unblocked
 * recompute (a new, additional fact arriving doesn't invalidate human
 * verification) but regresses to INCOMPLETE the moment a real blocker
 * reappears.
 */
export function targetStatusAfterRecompute(current: PassportStatus, hasFacts: boolean, blocked: boolean): PassportStatus {
  if (current === "SUSPENDED") return current;
  if (blocked) {
    if (current === "DRAFT" && !hasFacts) return "DRAFT";
    return "INCOMPLETE";
  }
  if (current === "VERIFIED") return "VERIFIED";
  return "READY";
}
