// packages/domain/src/economics-states.ts
//
// the spec (Economics, Attribution Ledger & Commission Accounting) +
// p.33 P15 exit condition ("Traceable schedule/accrual ledger"). Two
// kinds of vocabulary live here, same "several related small enums in
// one state file" pattern as lockbox-states.ts:
//
//   1. CommissionScheduleStatus — a REAL state machine (DRAFT -> ACTIVE ->
//      SUPERSEDED, plus RETIRED), matching this file's sibling
//      transition-guard files (deal-states.ts/rfq-states.ts/claim-states.ts/
//      etc). the spec (verbatim): "Changing a schedule creates a new
//      effective-dated version; already-earned periods are not silently
//      recalculated." SUPERSEDED is exactly that: a schedule VERSION stays
//      permanently readable (never deleted/overwritten, never re-entered)
//      once superseded — it just stops being the version new RevenueEvents
//      compute against. A brand-new schedule (new `scheduleFamilyId`)
//      starts back at DRAFT; SUPERSEDED/RETIRED are both terminal for that
//      SPECIFIC version row.
//   2. CommissionBasis / CommissionRecipientType / CommissionComponentType /
//      LedgerEntryType / LedgerDirection / AccrualDerivedStatus — closed
//      vocabularies, NOT state machines (nothing here ever "transitions" —
//      each CommissionAccrual row's entryType/direction is fixed forever
//      at insert, same append-only, no-update() precedent as
//      MatchResult/ReadinessResult, D11/D12). Hosted here anyway as the
//      single source of truth every economics call site (packages/db,
//      apps/api, apps/web) shares — mirrors how deal-states.ts hosts
//      DEAL_DECISION_TYPES (also not a state machine) alongside the real
//      DealRoomStatus/DealConditionState machines it also defines.
//
// CommissionAccrual ITSELF (schema.prisma) IS the traceable ledger the P15
// gate names — see that model's own header comment for why one physical
// append-only table, not two, carries both "the accrual" and "the ledger
// entry" concepts (ADR-0013).

import { DomainTransitionError } from "./transition-error.js";

// =================================================================
// CommissionSchedule — real state machine
// =================================================================

export const COMMISSION_SCHEDULE_STATUSES = ["DRAFT", "ACTIVE", "SUPERSEDED", "RETIRED"] as const;
export type CommissionScheduleStatus = (typeof COMMISSION_SCHEDULE_STATUSES)[number];
export function isCommissionScheduleStatus(value: string): value is CommissionScheduleStatus {
  return (COMMISSION_SCHEDULE_STATUSES as readonly string[]).includes(value);
}

/**
 * DRAFT -> ACTIVE: an operator/finance actor activates a prepared
 * schedule (apps/api's economics service, this stage). DRAFT -> RETIRED: a
 * prepared schedule is abandoned before ever going live. ACTIVE ->
 * SUPERSEDED: the spec's own "changing a schedule creates a new
 * effective-dated version" — the OLD version transitions to SUPERSEDED in
 * the SAME transaction a NEW version is created ACTIVE (never edited in
 * place — apps/api's economics service). ACTIVE -> RETIRED: a schedule is
 * withdrawn with no replacement (e.g. the deal itself is being wound
 * down, no further economics will ever accrue against it). SUPERSEDED and
 * RETIRED are both terminal — a historical version is NEVER reactivated;
 * a genuinely new schedule is a NEW row (new scheduleFamilyId, back to
 * DRAFT), matching this codebase's "changed my mind = a new row, not a
 * mutation of the old one" precedent (DealDecision, Claim, MatchResult).
 */
const COMMISSION_SCHEDULE_TRANSITIONS: Record<CommissionScheduleStatus, ReadonlySet<CommissionScheduleStatus>> = {
  DRAFT: new Set(["ACTIVE", "RETIRED"]),
  ACTIVE: new Set(["SUPERSEDED", "RETIRED"]),
  SUPERSEDED: new Set([]),
  RETIRED: new Set([]),
};

export class InvalidCommissionScheduleTransitionError extends DomainTransitionError {
  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidCommissionScheduleTransitionError";
  }
}

export function assertValidCommissionScheduleTransition(from: CommissionScheduleStatus, to: CommissionScheduleStatus): void {
  // Runtime hardening: see opportunity-states.ts's identical comment — a
  // cast or unvalidated input could hand this an out-of-enum string, and
  // without this guard `COMMISSION_SCHEDULE_TRANSITIONS[from]` would be
  // undefined, throwing a raw TypeError instead of the typed error the
  // central handler (apps/api/src/app.ts) expects.
  if (!isCommissionScheduleStatus(from) || !isCommissionScheduleStatus(to)) {
    throw new InvalidCommissionScheduleTransitionError("CommissionSchedule", from, to);
  }
  if (from === to || !COMMISSION_SCHEDULE_TRANSITIONS[from].has(to)) {
    throw new InvalidCommissionScheduleTransitionError("CommissionSchedule", from, to);
  }
}

// =================================================================
// Closed vocabularies (not state machines — see file header)
// =================================================================

/**
 * the spec (verbatim): "A schedule names whether economics apply to
 * gross processing volume, net platform revenue, received commission,
 * fixed fee, setup fee or another basis." Never left implicit — see
 * economics-engine.ts's own "never calculate on an ambiguous denominator"
 * discipline.
 */
export const COMMISSION_BASIS_VALUES = ["GROSS_PROCESSING_VOLUME", "NET_PLATFORM_REVENUE", "RECEIVED_COMMISSION", "FIXED_FEE", "SETUP_FEE", "OTHER"] as const;
export type CommissionBasis = (typeof COMMISSION_BASIS_VALUES)[number];
export function isCommissionBasis(value: string): value is CommissionBasis {
  return (COMMISSION_BASIS_VALUES as readonly string[]).includes(value);
}

/** the spec's EconomicComponent.recipient, typed as a closed category (the actual party is `recipientOrgId`, a real Organization — see schema.prisma). PLATFORM covers the platform's own margin component; CONTRIBUTOR covers a party whose AttributionLink/Claim earned credit; OTHER is the documented escape hatch for a named party with no attribution claim (e.g. a fixed referral partner) — same "escape hatch, not a silent default" discipline as OrganizationType's own OTHER value. */
export const COMMISSION_RECIPIENT_TYPES = ["CONTRIBUTOR", "PLATFORM", "OTHER"] as const;
export type CommissionRecipientType = (typeof COMMISSION_RECIPIENT_TYPES)[number];
export function isCommissionRecipientType(value: string): value is CommissionRecipientType {
  return (COMMISSION_RECIPIENT_TYPES as readonly string[]).includes(value);
}

/** the spec's EconomicComponent "bps/percent/fixed" — collapsed to two component types (PERCENTAGE_BPS covers both "bps" and "percent", an integer-bps value being the canonical representation of a percentage per money.ts's own assertIntegerBps/p.12 convention) rather than three, avoiding a redundant percent-vs-bps distinction this codebase's money conventions already resolve. */
export const COMMISSION_COMPONENT_TYPES = ["PERCENTAGE_BPS", "FIXED_AMOUNT"] as const;
export type CommissionComponentType = (typeof COMMISSION_COMPONENT_TYPES)[number];
export function isCommissionComponentType(value: string): value is CommissionComponentType {
  return (COMMISSION_COMPONENT_TYPES as readonly string[]).includes(value);
}

/**
 * Discriminates one CommissionAccrual (ledger) row. ACCRUAL is the
 * original computed commitment (one per component per RevenueEvent —
 * economics-engine.ts's computeCommissionSplits). ADJUSTMENT corrects a
 * prior ACCRUAL (the spec's Adjustment object — "reason, prior amount,
 * delta, approver, audit" — folded into this same table rather than a
 * sixth model; ADR-0013). PAYMENT records money actually paid out
 * against an accrual (scope's CommissionPayment — a real, separate model,
 * but every payment ALSO writes one PAYMENT-type row per accrual it
 * covers, into THIS table, so the ledger stays the single source of
 * truth for "what happened to this accrual"). REVERSAL fully voids an
 * accrual (e.g. a disputed/reversed deal).
 */
export const LEDGER_ENTRY_TYPES = ["ACCRUAL", "ADJUSTMENT", "PAYMENT", "REVERSAL"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export function isLedgerEntryType(value: string): value is LedgerEntryType {
  return (LEDGER_ENTRY_TYPES as readonly string[]).includes(value);
}

/** CREDIT increases what's owed to the recipient (ACCRUAL always; ADJUSTMENT sometimes); DEBIT decreases it (PAYMENT/REVERSAL always; ADJUSTMENT sometimes). Kept as an explicit direction rather than a signed BigInt so every stored amountMinor stays non-negative — money.ts's assertBigIntMinorUnits (this package) rejects negative values everywhere else in this codebase; economics keeps that same invariant rather than carving out a signed-money exception. */
export const LEDGER_DIRECTIONS = ["CREDIT", "DEBIT"] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];
export function isLedgerDirection(value: string): value is LedgerDirection {
  return (LEDGER_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The DERIVED (never stored) status of one logical accrual — computed
 * from every CommissionAccrual row sharing one `accrualRootId`, the same
 * "query, don't denormalize a current-state pointer" precedent
 * Claim/ClaimDecision/MatchResult/ReadinessResult already established in
 * this codebase. See economics-engine.ts's computeAccrualBalance for the
 * actual computation. DISPUTED is a deliberately NAMED, NOT-BUILT
 * extension point this pass (ADR-0013) — an economics-specific
 * dispute reuses @tol/attribution's existing ClaimDispute mechanism in a
 * later day, the same "thin but honest, flagged not silent" discipline
 * as every other named scope cut in this repo (D8/D9/D10/D11/D12).
 */
export const ACCRUAL_DERIVED_STATUSES = ["ACCRUED", "ADJUSTED", "PARTIALLY_PAID", "PAID", "REVERSED"] as const;
export type AccrualDerivedStatus = (typeof ACCRUAL_DERIVED_STATUSES)[number];
export function isAccrualDerivedStatus(value: string): value is AccrualDerivedStatus {
  return (ACCRUAL_DERIVED_STATUSES as readonly string[]).includes(value);
}
