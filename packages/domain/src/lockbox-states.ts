// packages/domain/src/lockbox-states.ts
//
// the spec (verbatim): "Lockbox || DRAFT → SEALED → COMMITTED → FROZEN →
// OPENED → MATCH_ELIGIBLE; WITHDRAWN/DISPUTED side states". This file is
// the single source of truth for which Lockbox state transitions are
// legal — matching earlier/the established convention (assertValid*
// throwing a typed DomainTransitionError subclass; apps/api's central
// error handler turns any instance into a clean 400, never a 500).
//
// The reuse-reference prototype (the prototype's `lockbox.ts`,
// read but never edited) implements this same 8-state table with its
// mockSealHash() standing in for real crypto — this file ports the STATE
// MACHINE SHAPE verbatim (its LOCKBOX_TRANSITIONS table matches the scope
// text exactly, independently cross-checked against the spec line
// 122) while packages/crypto (earlier-stage work) replaces
// the fake hash with real AES-256-GCM + Shamir threshold, per DECISIONS.md
// D1/D9.
//
// an earlier API surface (this stage) wires only 4 actions this pass — seal
// (creates a row directly at SEALED; DRAFT is a client-side-only concept,
// never a persisted row, since sealing requires the plaintext payload the
// server encrypts server-side per D9), withdraw, release, and
// read-receipt (no state change). COMMITTED/FROZEN/MATCH_ELIGIBLE/
// DISPUTED and their own independently-authorized triggering actions (a
// general-purpose commit/reveal batch workflow, the spec) are modeled
// here for canonical completeness — matching ADR-0008 part 2's
// "thin but honest" precedent for Opportunity/CapacityProfile — but have
// no API endpoint yet; flagged in the build log for whichever day picks
// up P9's remaining richness. `release`, in this pass, performs the
// SEALED → COMMITTED → FROZEN → OPENED cascade atomically as ONE
// system-triggered transition (LOCKBOX_RELEASE_CASCADE below) rather than
// requiring three separately-authorized user actions first — the same
// "no separate deal.open action" precedent ADR-0008 part 5
// established for DealRoom creation.

import { DomainTransitionError } from "./transition-error.js";

export const LOCKBOX_STATUSES = [
  "DRAFT",
  "SEALED",
  "COMMITTED",
  "FROZEN",
  "OPENED",
  "MATCH_ELIGIBLE",
  "WITHDRAWN",
  "DISPUTED",
] as const;
export type LockboxStatus = (typeof LOCKBOX_STATUSES)[number];
export function isLockboxStatus(value: string): value is LockboxStatus {
  return (LOCKBOX_STATUSES as readonly string[]).includes(value);
}

/**
 * Verbatim from the scope's state list plus the two documented side-state
 * rules: p.17's commit/reveal batch note ("entries move to FROZEN and
 * withdrawal is disabled" — FROZEN deliberately has NO WITHDRAWN edge,
 * unlike every other non-terminal state) and DISPUTED's own two-way
 * recovery ("works back to FROZEN or closes out via WITHDRAWN").
 */
const LOCKBOX_TRANSITIONS: Record<LockboxStatus, ReadonlySet<LockboxStatus>> = {
  DRAFT: new Set(["SEALED"]),
  SEALED: new Set(["COMMITTED", "WITHDRAWN"]),
  COMMITTED: new Set(["FROZEN", "WITHDRAWN", "DISPUTED"]),
  FROZEN: new Set(["OPENED", "DISPUTED"]), // no WITHDRAWN — "withdrawal is disabled" once frozen (the spec)
  OPENED: new Set(["MATCH_ELIGIBLE", "DISPUTED"]),
  MATCH_ELIGIBLE: new Set(["WITHDRAWN", "DISPUTED"]),
  DISPUTED: new Set(["FROZEN", "WITHDRAWN"]),
  WITHDRAWN: new Set([]), // terminal — acceptance criterion 6: "the payload can NEVER be released afterward"
};

export class InvalidLockboxTransitionError extends DomainTransitionError {
  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidLockboxTransitionError";
  }
}

/** No legitimate same-state re-transition exists for a Lockbox (unlike RFQ's re-entrant QUOTED for a second provider) — sealing/withdrawing/releasing an already-sealed/withdrawn/released lockbox again is always a client error, so `from === to` is rejected structurally rather than silently accepted as a no-op. */
export function assertValidLockboxTransition(from: LockboxStatus, to: LockboxStatus): void {
  // Runtime hardening: see opportunity-states.ts's identical comment — a
  // cast or unvalidated input could hand this an out-of-enum string, and
  // without this guard `LOCKBOX_TRANSITIONS[from]` would be undefined,
  // throwing a raw TypeError instead of the typed error the central handler
  // expects.
  if (!isLockboxStatus(from) || !isLockboxStatus(to)) {
    throw new InvalidLockboxTransitionError("Lockbox", from, to);
  }
  if (from === to || !LOCKBOX_TRANSITIONS[from].has(to)) {
    throw new InvalidLockboxTransitionError("Lockbox", from, to);
  }
}

/**
 * The ordered hop sequence `release` runs atomically (SEALED → COMMITTED
 * → FROZEN → OPENED) as one system-triggered transition rather than three
 * separately-authorized user actions — see this file's header comment and
 * ADR-0009 for why. Every hop is still validated against
 * `LOCKBOX_TRANSITIONS` above (the SAME table a future standalone
 * commit/freeze action would use), so this is a documented shortcut
 * through real legal edges, not a bypass of the state machine.
 */
export const LOCKBOX_RELEASE_CASCADE: readonly LockboxStatus[] = ["SEALED", "COMMITTED", "FROZEN", "OPENED"];

/**
 * Validates that `currentStatus` can legally reach OPENED via
 * LOCKBOX_RELEASE_CASCADE. the API only ever persists a Lockbox at
 * SEALED (no standalone commit/freeze action is wired yet — see header
 * comment), so in practice this only ever accepts `currentStatus ===
 * "SEALED"` today; it is written generally (walking the cascade from
 * wherever `currentStatus` sits within it) so a later day wiring a
 * standalone `commit`/`freeze` action doesn't have to touch this
 * function — a Lockbox already COMMITTED or FROZEN by then would still
 * validate correctly against the same table.
 */
export function assertValidLockboxReleaseCascade(currentStatus: LockboxStatus): void {
  const startIdx = LOCKBOX_RELEASE_CASCADE.indexOf(currentStatus);
  if (startIdx === LOCKBOX_RELEASE_CASCADE.length - 1) {
    // currentStatus is already OPENED — a distinct, clearer message than
    // the generic "invalid transition" below, since this is a no-op
    // re-release attempt, not a starting point that can never reach
    // OPENED at all (a review finding on this file correctly noted the
    // generic message would otherwise misleadingly read "OPENED ->
    // OPENED", implying a transition rather than "already there").
    throw new InvalidLockboxTransitionError("Lockbox", currentStatus, "OPENED (already released — nothing to do)");
  }
  if (startIdx === -1) {
    throw new InvalidLockboxTransitionError("Lockbox", currentStatus, "OPENED (via release cascade)");
  }
  for (let i = startIdx; i < LOCKBOX_RELEASE_CASCADE.length - 1; i++) {
    assertValidLockboxTransition(LOCKBOX_RELEASE_CASCADE[i]!, LOCKBOX_RELEASE_CASCADE[i + 1]!);
  }
}

/** States a Lockbox can be withdrawn FROM — every non-terminal state except FROZEN (withdrawal explicitly disabled once frozen, the spec) and DISPUTED-that-only-recovers-via-FROZEN-first is still reachable (DISPUTED -> WITHDRAWN is a direct legal edge above). Exposed as a named export so apps/api's service layer can build a clear 409 message ("cannot withdraw from FROZEN") without re-deriving this from the raw transition table. */
export function canWithdrawFrom(status: LockboxStatus): boolean {
  return LOCKBOX_TRANSITIONS[status].has("WITHDRAWN");
}

/**
 * Category used by the spec's "MVP cryptographic model" record list and
 * the prototype's own seed data — what KIND of relationship or
 * opportunity is being sealed. Inferred/reused from the reuse-reference
 * prototype's `LockboxRelationshipType` (the prototype's `model.ts`)
 * since the build spec itself never enumerates this value set — same
 * documented-inference discipline as rfq-states.ts's own header comment.
 */
export const LOCKBOX_RELATIONSHIP_TYPES = [
  "ACQUIRER_RELATIONSHIP",
  "PROCESSOR_RELATIONSHIP",
  "PSP_RELATIONSHIP",
  "MERCHANT_RELATIONSHIP",
  "BANKING_RELATIONSHIP",
  "INFRASTRUCTURE_RELATIONSHIP",
  "QUALIFIED_OPPORTUNITY",
] as const;
export type LockboxRelationshipType = (typeof LOCKBOX_RELATIONSHIP_TYPES)[number];
export function isLockboxRelationshipType(value: string): value is LockboxRelationshipType {
  return (LOCKBOX_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

/** Macro-region for the market-visible aggregate only (deliberately coarser than the platform's strict Jurisdiction codes) — same inference source as LOCKBOX_RELATIONSHIP_TYPES above. */
export const LOCKBOX_REGIONS = ["EU", "UK", "US", "LATAM", "APAC", "MENA", "GLOBAL"] as const;
export type LockboxRegion = (typeof LOCKBOX_REGIONS)[number];
export function isLockboxRegion(value: string): value is LockboxRegion {
  return (LOCKBOX_REGIONS as readonly string[]).includes(value);
}

/**
 * The 3 threshold-share custodian roles (ADR-0001/ADR-0009,
 * packages/crypto's LOCKBOX_SHARE_ROLES) — re-declared here as a domain
 * concept (not imported from @tol/crypto, which packages/domain does not
 * and should not depend on) because packages/db's schema and
 * packages/authz's action set both need to name these roles too, and
 * @tol/domain is the layer every other package is allowed to depend on
 * for shared vocabulary like this. Kept byte-identical to @tol/crypto's
 * own copy; a mismatch between the two would be a real bug, guarded by
 * this file's own test asserting the two arrays are equal.
 */
export const LOCKBOX_SHARE_ROLES = ["SEALER", "OPERATOR", "ESCROW"] as const;
export type LockboxShareRole = (typeof LOCKBOX_SHARE_ROLES)[number];
export function isLockboxShareRole(value: string): value is LockboxShareRole {
  return (LOCKBOX_SHARE_ROLES as readonly string[]).includes(value);
}
