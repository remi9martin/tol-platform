// packages/domain/src/economics-engine.ts
//
// the spec (Economics, Attribution Ledger & Commission Accounting) +
// p.33 P15 exit condition ("Traceable schedule/accrual ledger") + p.12
// ("Money || integer minor units + ISO currency; never floating point" —
// the single most important correctness property of this day, per this
// day's own build instructions).
//
// Pure, zero-DB, zero-clock (every function takes `now`/inputs as plain
// arguments, never reads a live clock or queries a database) — same
// discipline as this package's own volume-reconciliation.ts and
// @tol/attribution/@tol/matching's pure engines. apps/api's economics
// service (this stage) is responsible for resolving real CommissionSchedule/
// CommissionComponent/RevenueEvent rows into the plain shapes below
// before calling in, and persisting the plain results back out — this
// file never imports @tol/db or @prisma/client.
//
// THREE FUNCTIONS, THREE PROOFS THIS DAY'S GATE NEEDS:
//   1. computeCommissionSplits — MONEY-EXACTNESS: splits a RevenueEvent's
//      netDistributableMinor across a schedule's components with ZERO
//      leakage/remainder, using ONLY BigInt integer arithmetic (never a
//      float, never Number division). See its own doc comment for the
//      largest-remainder (Hamilton apportionment) method and why it's
//      provably exact.
//   2. computeAccrualBalance — TRACEABILITY: reduces one accrual's full
//      append-only entry chain (its original ACCRUAL row plus every
//      ADJUSTMENT/PAYMENT/REVERSAL row that references it) into a single
//      current balance + derived status, without ever mutating a stored
//      row.
//   3. reconcileRevenueEvent — the spec's own verbatim RECONCILIATION
//      requirement: "Every commission period must reconcile source
//      revenue -> deductions -> distributable base -> recipient
//      components -> paid/owed balance," as one real, testable check
//      (same "one collapsed proof, not prose" shape as this package's
//      own reconcileOpportunityVolume).
//
// DETERMINISM: none of these functions read a clock, generate an id, or
// depend on argument order (computeCommissionSplits sorts its own
// internal ranking deterministically — see its own comment); calling any
// of them twice with byte-identical inputs produces byte-identical
// output. economics-engine.test.ts proves this directly (same "run twice,
// diff" pattern as @tol/attribution/@tol/matching's own determinism
// proofs), not merely asserted here.

import { assertBigIntMinorUnits } from "./money.js";
import type { AccrualDerivedStatus, CommissionBasis, CommissionComponentType, LedgerDirection, LedgerEntryType } from "./economics-states.js";

/** the spec's own "Every resolution records rule version" discipline (mirrors @tol/attribution/@tol/matching's ALGORITHM_VERSION constants) — bumped only on a genuine change to computeCommissionSplits' math (e.g. a different apportionment method). */
export const ECONOMICS_ENGINE_VERSION = "economics-ledger-v1";

export class EconomicsInvariantError extends TypeError {
  constructor(message: string) {
    super(`economics invariant violated: ${message}`);
    this.name = "EconomicsInvariantError";
  }
}

// =================================================================
// 1. computeCommissionSplits — money-exactness
// =================================================================

/** This package's own closed copy of one CommissionComponent's fields (schema.prisma, packages/db) — zero-DB, duplicated not imported, same discipline as @tol/matching's MatchCapacityInput. */
export interface EconomicsComponentInput {
  componentId: string;
  recipientOrgId: string;
  componentType: CommissionComponentType;
  /** Required (and only meaningful) when componentType is PERCENTAGE_BPS; 0-10000 range enforced by money.ts's assertIntegerBps at the caller boundary (apps/api), not re-validated here beyond the sum-to-10000 invariant below. */
  bps: number | null;
  /** Required (and only meaningful) when componentType is FIXED_AMOUNT. */
  fixedAmountMinor: bigint | null;
  /** Provenance: the attribution claim that justifies this recipient's share, if any (null for a PLATFORM-margin component, which has no claim behind it). */
  claimId: string | null;
  priority: number;
}

/** One computed distribution — always CREDIT (a fresh ACCRUAL is always money newly owed, never a reduction; reductions are ADJUSTMENT/PAYMENT/REVERSAL rows, computed elsewhere in the ledger, not by this function). */
export interface ComputedLedgerEntry {
  componentId: string;
  recipientOrgId: string;
  claimId: string | null;
  amountMinor: bigint;
  direction: "CREDIT";
}

export interface ComputeCommissionSplitsInput {
  /** the spec: "Received-cash schedules should calculate from cash actually received, not theoretical volume" — whatever figure this is, it is ALREADY the correct denominator for the components passed in (apps/api's service resolves gross/deductions/net BEFORE calling this function; see reconcileRevenueEvent below for the check that gross - deductions really does equal this value). Must be non-negative. */
  netDistributableMinor: bigint;
  /**
   * ALREADY basis-filtered by the caller via selectComponentsForBasis
   * (below) — every component here is assumed to apply to the SAME
   * RevenueEvent basis. Passing components spanning more than one basis
   * produces a bps-sum-to-10000 failure or a wrong split; this function
   * has no way to detect a caller's filtering mistake beyond that.
   */
  components: readonly EconomicsComponentInput[];
  scheduleId: string;
  scheduleVersion: number;
  /** Injected, never read internally — same discipline as @tol/matching's MatchContext.now. */
  now: Date;
  inputVersions?: readonly string[];
}

export interface ComputeCommissionSplitsResult {
  entries: readonly ComputedLedgerEntry[];
  calculationVersion: string;
  /** ISO-8601, echoes `input.now` verbatim. */
  computedAt: string;
  inputVersions: readonly string[];
}

/**
 * the spec's EconomicComponent split, computed with ZERO leakage: the
 * sum of every returned entry's `amountMinor` is EXACTLY
 * `input.netDistributableMinor` — proven by a dedicated internal
 * assertion below (not just hoped for) AND by
 * economics-engine.test.ts's own independent proof across many
 * distributions.
 *
 * Two component kinds, handled in order:
 *   1. FIXED_AMOUNT components are deducted first, exactly (no rounding
 *      possible for a fixed integer amount). Their sum must not exceed
 *      `netDistributableMinor` — fails loud (EconomicsInvariantError) if
 *      it does, rather than silently producing a negative remainder.
 *   2. Whatever remains (`remainingAfterFixed`) is split across
 *      PERCENTAGE_BPS components by the LARGEST-REMAINDER (Hamilton
 *      apportionment) method:
 *        a. Every bps component's EXACT share is
 *           `remainingAfterFixed * bps` (a big numerator, computed
 *           BEFORE any division — BigInt has no precision limit, so this
 *           never loses precision the way a float `remainingAfterFixed *
 *           (bps / 10000)` would).
 *        b. `floorShare = numerator / 10000n` (BigInt division always
 *           truncates toward zero for non-negative operands — an exact,
 *           deterministic floor, never a float rounding mode).
 *        c. The sum of every `floorShare` is, by construction, LESS THAN
 *           OR EQUAL TO `remainingAfterFixed` (each floor loses strictly
 *           less than 1 whole minor unit versus its exact share) — the
 *           difference, `leftoverPool`, is a small non-negative integer,
 *           STRICTLY LESS than the number of bps components (each
 *           component can lose at most a fraction of one unit).
 *        d. `leftoverPool` is distributed ONE MINOR UNIT AT A TIME to the
 *           components with the LARGEST remainder (`numerator % 10000n`),
 *           ranked descending, ties broken by `componentId` ascending
 *           (same deterministic tie-break convention as
 *           @tol/matching's rankMatches — never insertion order, which
 *           would make the split depend on array order rather than the
 *           inputs themselves).
 *   PERCENTAGE_BPS components' `bps` values MUST sum to EXACTLY 10000
 *   (100% of whatever remains after fixed deductions) — same
 *   "assertWeightsSumToOne, fail loud at the boundary, never silently
 *   leave a gap" discipline @tol/attribution/@tol/matching already apply
 *   to their own fixed config weights, applied here to a DYNAMIC,
 *   caller-supplied schedule instead. A schedule that wants "the
 *   platform keeps whatever's left over" must say so with an EXPLICIT
 *   PLATFORM component at the residual bps — never an implicit gap.
 *   If `remainingAfterFixed` is nonzero and there are NO bps components
 *   at all, that remainder has nowhere to go — also a hard failure
 *   (EconomicsInvariantError), never money that silently vanishes.
 *
 * PROOF THIS IS EXACT: floorShares sum to
 * `remainingAfterFixed - leftoverPool` (by construction, since
 * `leftoverPool` is DEFINED as that difference); `leftoverPool` is then
 * distributed in full (the loop below runs until it reaches exactly
 * zero, guarded against ever exceeding one pass over the component list —
 * a structurally unreachable state given point (c) above, but asserted
 * rather than assumed, matching money.ts's own "fail loud on an
 * impossible state" stance). So `sum(finalShares) = remainingAfterFixed`
 * EXACTLY, and `sum(fixed) + remainingAfterFixed = netDistributableMinor`
 * EXACTLY by definition of `remainingAfterFixed` — chained together,
 * every returned entry's `amountMinor` sums to
 * `netDistributableMinor` EXACTLY, always, for any valid input.
 */
export function computeCommissionSplits(input: ComputeCommissionSplitsInput): ComputeCommissionSplitsResult {
  const { netDistributableMinor, components, scheduleId, scheduleVersion, now } = input;

  assertBigIntMinorUnits(netDistributableMinor, "netDistributableMinor");
  if (components.length === 0) {
    throw new EconomicsInvariantError(`no components supplied for schedule ${scheduleId} v${scheduleVersion} — cannot split ${netDistributableMinor} across zero recipients`);
  }
  const seenComponentIds = new Set<string>();
  for (const c of components) {
    if (seenComponentIds.has(c.componentId)) {
      throw new EconomicsInvariantError(`duplicate componentId ${c.componentId} in the components passed to computeCommissionSplits — each component may only appear once per split`);
    }
    seenComponentIds.add(c.componentId);
  }

  const fixedComponents = components.filter((c) => c.componentType === "FIXED_AMOUNT");
  const bpsComponents = components.filter((c) => c.componentType === "PERCENTAGE_BPS");

  let fixedTotal = 0n;
  for (const c of fixedComponents) {
    if (c.fixedAmountMinor === null) {
      throw new EconomicsInvariantError(`component ${c.componentId} is FIXED_AMOUNT but fixedAmountMinor is null`);
    }
    assertBigIntMinorUnits(c.fixedAmountMinor, `component ${c.componentId}.fixedAmountMinor`);
    fixedTotal += c.fixedAmountMinor;
  }
  if (fixedTotal > netDistributableMinor) {
    throw new EconomicsInvariantError(
      `sum of FIXED_AMOUNT components (${fixedTotal}) exceeds netDistributableMinor (${netDistributableMinor}) for schedule ${scheduleId} v${scheduleVersion}`,
    );
  }

  const remainingAfterFixed = netDistributableMinor - fixedTotal;
  const entries: ComputedLedgerEntry[] = fixedComponents.map((c) => ({
    componentId: c.componentId,
    recipientOrgId: c.recipientOrgId,
    claimId: c.claimId,
    amountMinor: c.fixedAmountMinor as bigint,
    direction: "CREDIT" as const,
  }));

  if (bpsComponents.length === 0) {
    if (remainingAfterFixed !== 0n) {
      throw new EconomicsInvariantError(
        `netDistributableMinor (${netDistributableMinor}) exceeds the sum of FIXED_AMOUNT components (${fixedTotal}) by ${remainingAfterFixed} for schedule ${scheduleId} v${scheduleVersion}, and there are no PERCENTAGE_BPS components to absorb the remainder — every minor unit must be assigned to exactly one recipient, never left implicit`,
      );
    }
  } else {
    let bpsTotal = 0;
    for (const c of bpsComponents) {
      if (c.bps === null || c.bps < 0) {
        throw new EconomicsInvariantError(`component ${c.componentId} is PERCENTAGE_BPS but bps is missing or negative`);
      }
      bpsTotal += c.bps;
    }
    if (bpsTotal !== 10_000) {
      throw new EconomicsInvariantError(
        `PERCENTAGE_BPS components for schedule ${scheduleId} v${scheduleVersion} sum to ${bpsTotal} bps, not exactly 10000 (100%) of the amount remaining after fixed deductions — a schedule where the platform keeps the residual must say so with an explicit component, never an implicit gap`,
      );
    }

    const shares = bpsComponents.map((c) => {
      const numerator = remainingAfterFixed * BigInt(c.bps as number);
      return { component: c, floorShare: numerator / 10_000n, remainder: numerator % 10_000n };
    });

    let flooredTotal = 0n;
    for (const s of shares) flooredTotal += s.floorShare;
    let leftoverPool = remainingAfterFixed - flooredTotal;
    if (leftoverPool < 0n) {
      // Structurally unreachable — BigInt floor division of non-negative
      // operands never rounds UP — guarded per this file's "fail loud on
      // an impossible state" discipline rather than trusted blind.
      throw new EconomicsInvariantError(`internal error: leftoverPool went negative (${leftoverPool}) for schedule ${scheduleId} v${scheduleVersion} — floor-division invariant violated`);
    }

    const ranked = [...shares].sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      return a.component.componentId < b.component.componentId ? -1 : a.component.componentId > b.component.componentId ? 1 : 0;
    });

    const bonusUnits = new Map<string, bigint>();
    for (let i = 0; i < ranked.length && leftoverPool > 0n; i++, leftoverPool -= 1n) {
      const id = ranked[i]!.component.componentId;
      bonusUnits.set(id, (bonusUnits.get(id) ?? 0n) + 1n);
    }
    if (leftoverPool > 0n) {
      // Structurally unreachable given each component's floor loses
      // strictly less than 1 minor unit (so leftoverPool is always <
      // bpsComponents.length, i.e. at most one bonus unit per component
      // is ever needed) — asserted rather than assumed, same stance as
      // the negative-leftoverPool guard above.
      throw new EconomicsInvariantError(
        `internal error: leftoverPool (${leftoverPool}) exceeds one full round-robin pass over ${bpsComponents.length} components — apportionment invariant violated for schedule ${scheduleId} v${scheduleVersion}`,
      );
    }

    for (const s of shares) {
      const amountMinor = s.floorShare + (bonusUnits.get(s.component.componentId) ?? 0n);
      entries.push({ componentId: s.component.componentId, recipientOrgId: s.component.recipientOrgId, claimId: s.component.claimId, amountMinor, direction: "CREDIT" });
    }
  }

  let sumCheck = 0n;
  for (const e of entries) sumCheck += e.amountMinor;
  if (sumCheck !== netDistributableMinor) {
    // Should be structurally unreachable given the construction above —
    // asserted anyway per this codebase's "prove it, don't just reason
    // about it" discipline (matchResultRepository's own bidirectional
    // guard, D12, applies the same idea to a different invariant).
    throw new EconomicsInvariantError(
      `internal error: computed entries sum to ${sumCheck}, not netDistributableMinor (${netDistributableMinor}) — zero-leakage invariant violated for schedule ${scheduleId} v${scheduleVersion}`,
    );
  }

  return {
    entries,
    calculationVersion: ECONOMICS_ENGINE_VERSION,
    computedAt: now.toISOString(),
    inputVersions: input.inputVersions ?? [`schedule:${scheduleId}:v${scheduleVersion}`],
  };
}

/**
 * the spec's EconomicComponent "calculation basis" field (independent
 * of the parent CommissionSchedule's own `basis`) resolved: a schedule
 * MAY mix components that apply to different RevenueEvent bases (e.g.
 * three recurring components at GROSS_PROCESSING_VOLUME, plus one
 * one-time component at SETUP_FEE) — computeCommissionSplits itself has
 * no notion of "basis" at all, it only ever sees an already-homogeneous
 * component list for ONE RevenueEvent. This function is that filter: the
 * caller (apps/api's economics service, this stage) selects the component
 * subset for the ACTUAL basis of the RevenueEvent being computed BEFORE
 * calling computeCommissionSplits, so that function's own "bps sum to
 * exactly 10000" invariant is checked per-basis, not across a schedule's
 * full, possibly basis-mixed component list.
 */
export function selectComponentsForBasis(
  components: readonly EconomicsComponentInput[],
  scheduleBasis: CommissionBasis,
  targetBasis: CommissionBasis,
  componentBasisOverride: ReadonlyMap<string, CommissionBasis | null>,
): EconomicsComponentInput[] {
  return components.filter((c) => (componentBasisOverride.get(c.componentId) ?? scheduleBasis) === targetBasis);
}

// =================================================================
// 2. computeAccrualBalance — traceability
// =================================================================

export interface AccrualLedgerEntryLike {
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amountMinor: bigint;
}

export interface AccrualBalance {
  status: AccrualDerivedStatus;
  /** The original ACCRUAL entry's amount — immutable historical fact, never recomputed. */
  originalAmountMinor: bigint;
  /** originalAmountMinor + every ADJUSTMENT entry's signed effect (CREDIT adds, DEBIT subtracts). */
  netAmountMinor: bigint;
  paidAmountMinor: bigint;
  /** netAmountMinor - paidAmountMinor. Zero (or negative, treated as zero-owed) means fully paid. */
  outstandingAmountMinor: bigint;
}

/**
 * Reduces one logical accrual's full append-only entry chain — its
 * original ACCRUAL row plus every ADJUSTMENT/PAYMENT/REVERSAL row that
 * references it (all sharing one `accrualRootId`, schema.prisma's
 * CommissionAccrual) — into a single current balance, WITHOUT mutating
 * any stored row. Same "derive, never denormalize a mutable pointer"
 * precedent as @tol/domain's own isPassportReadinessStale / D12's
 * MatchResult query-the-latest-row convention, applied here to a
 * SEQUENCE of rows instead of picking the single latest one.
 *
 * Order of `entries` does not matter (this function sums, it does not
 * replay a state machine) — proven by economics-engine.test.ts feeding
 * the same entries in multiple shuffled orders and asserting an
 * identical result every time.
 */
export function computeAccrualBalance(entries: readonly AccrualLedgerEntryLike[]): AccrualBalance {
  const accrualEntries = entries.filter((e) => e.entryType === "ACCRUAL");
  if (accrualEntries.length !== 1) {
    throw new EconomicsInvariantError(`expected exactly one ACCRUAL entry in an accrual's ledger chain, found ${accrualEntries.length}`);
  }
  const originalAmountMinor = accrualEntries[0]!.amountMinor;

  let netAmountMinor = originalAmountMinor;
  let paidAmountMinor = 0n;
  let hasAdjustment = false;
  let hasReversal = false;
  for (const e of entries) {
    if (e.entryType === "ADJUSTMENT") {
      hasAdjustment = true;
      netAmountMinor += e.direction === "CREDIT" ? e.amountMinor : -e.amountMinor;
    } else if (e.entryType === "PAYMENT") {
      paidAmountMinor += e.amountMinor;
    } else if (e.entryType === "REVERSAL") {
      hasReversal = true;
    }
  }

  // A REVERSAL voids the accrual outright — zero remains outstanding
  // regardless of the raw netAmountMinor/paidAmountMinor arithmetic (a
  // real fix, review: the original
  // version here computed `outstandingAmountMinor` from
  // netAmountMinor - paidAmountMinor UNCONDITIONALLY, so a reversed
  // accrual with no prior payment would still report its full original
  // amount as "outstanding" even though `status` correctly read
  // REVERSED — a caller that read `outstandingAmountMinor` without
  // separately checking `status` first, e.g. a payment-amount validation
  // against "how much is left to pay," could have accepted a payment
  // against a voided accrual). This mirrors reconcileRevenueEvent's own
  // period-level formula, which already subtracted `reversedMinor`
  // correctly — this per-accrual function had drifted from that
  // precedent.
  const outstandingAmountMinor = hasReversal ? 0n : netAmountMinor - paidAmountMinor;

  let status: AccrualDerivedStatus;
  if (hasReversal) status = "REVERSED";
  else if (outstandingAmountMinor <= 0n) status = "PAID";
  else if (paidAmountMinor > 0n) status = "PARTIALLY_PAID";
  else if (hasAdjustment) status = "ADJUSTED";
  else status = "ACCRUED";

  return { status, originalAmountMinor, netAmountMinor, paidAmountMinor, outstandingAmountMinor };
}

// =================================================================
// 3. reconcileRevenueEvent — the spec's own RECONCILIATION table
// =================================================================

export type RevenueEventMismatchCode = "basis_mismatch" | "distribution_mismatch";
export interface RevenueEventMismatch {
  code: RevenueEventMismatchCode;
  message: string;
}

export interface RevenueEventReconciliationInput {
  grossAmountMinor: bigint;
  deductionsMinor: bigint;
  netDistributableMinor: bigint;
  /** Every CommissionAccrual row (every entryType) for this ONE revenueEventId — the full ledger slice for this period, across every component/recipient. */
  ledgerEntries: readonly AccrualLedgerEntryLike[];
}

export interface RevenueEventReconciliation {
  reconciled: boolean;
  /** SUM of ACCRUAL-type entries only — the original commitment, before any adjustment/payment/reversal. Must equal netDistributableMinor for a healthy period. */
  distributedMinor: bigint;
  paidMinor: bigint;
  /** distributedMinor + net adjustments - paidMinor - reversed. */
  outstandingMinor: bigint;
  mismatches: readonly RevenueEventMismatch[];
}

/**
 * the spec (verbatim, the "RECONCILIATION" table): "Every commission
 * period must reconcile source revenue -> deductions -> distributable
 * base -> recipient components -> paid/owed balance." One real, testable
 * check — same "collapse the scope's own multi-step description into one
 * provable function" shape as this package's own
 * reconcileOpportunityVolume. `reconciled: false` means this period's
 * economics do NOT balance and must be surfaced to a Finance Operator,
 * not silently accepted — this function only computes the fact, callers
 * (apps/api's economics service) decide what to do about it.
 */
export function reconcileRevenueEvent(input: RevenueEventReconciliationInput): RevenueEventReconciliation {
  const mismatches: RevenueEventMismatch[] = [];

  const expectedNet = input.grossAmountMinor - input.deductionsMinor;
  if (expectedNet !== input.netDistributableMinor) {
    mismatches.push({
      code: "basis_mismatch",
      message: `grossAmountMinor (${input.grossAmountMinor}) - deductionsMinor (${input.deductionsMinor}) = ${expectedNet}, not netDistributableMinor (${input.netDistributableMinor})`,
    });
  }

  let distributedMinor = 0n;
  let paidMinor = 0n;
  let adjustmentNetMinor = 0n;
  let reversedMinor = 0n;
  for (const e of input.ledgerEntries) {
    if (e.entryType === "ACCRUAL") distributedMinor += e.amountMinor;
    else if (e.entryType === "PAYMENT") paidMinor += e.amountMinor;
    else if (e.entryType === "ADJUSTMENT") adjustmentNetMinor += e.direction === "CREDIT" ? e.amountMinor : -e.amountMinor;
    else if (e.entryType === "REVERSAL") reversedMinor += e.amountMinor;
  }

  if (distributedMinor !== input.netDistributableMinor) {
    mismatches.push({
      code: "distribution_mismatch",
      message: `SUM(ACCRUAL ledger entries) = ${distributedMinor} does not equal netDistributableMinor (${input.netDistributableMinor})`,
    });
  }

  const outstandingMinor = distributedMinor + adjustmentNetMinor - paidMinor - reversedMinor;

  return { reconciled: mismatches.length === 0, distributedMinor, paidMinor, outstandingMinor, mismatches };
}

// =================================================================
// 4. evaluateScheduleCapFloor — DISCLOSURE, not enforcement
// =================================================================
//
// Follow-up fix. schema.prisma's CommissionSchedule.capMinor/
// floorMinor comment: "Optional ceiling/floor on the TOTAL distributable
// base this schedule version EVER computes against, in minor units —
// p.23: 'cap/floor'." Before this fix, capMinor/floorMinor were
// accepted on schedule creation (apps/api's createSchedule), persisted,
// and rendered in the UI (apps/web's ScheduleSummary.tsx) — but nothing
// anywhere ever compared them against what the schedule had actually
// distributed. A schedule configured with a $50,000 cap could silently
// accumulate accruals well past it across many RevenueEvents with zero
// error, zero warning, ZERO disclosure — worse than a silent clamp,
// since a clamp at least changes a number; this changed nothing at all.
//
// DISCLOSURE, deliberately not enforcement: computeCommissionSplits
// (above) still splits a RevenueEvent's FULL netDistributableMinor with
// zero leakage every time — this function never touches that
// computation, and nothing in this pass makes recordRevenueEvent reject
// or truncate a split because of a cap. Two reasons, both real:
//   1. A cap/floor is scoped to ONE schedule VERSION's cumulative
//      lifetime total (the schema comment, verbatim) — correctly
//      BLOCKING a revenue event that would breach it requires deciding
//      what happens to that revenue event (reject the whole thing?
//      partially apply it and orphan the remainder? split across the
//      old and a new superseding schedule version automatically?) —
//      real product decisions this hardening pass has no mandate to
//      make unilaterally.
//   2. apps/worker's economics-accrual.job.ts computes splits too (its
//      own reconciliation retry path) — enforcing a cap ONLY in apps/
//      api's synchronous path while apps/worker's path stayed
//      unenforced would be an inconsistent, bypassable half-fix, and
//      apps/worker/** is out of bounds for this pass.
// So: compute and expose the FACT (are we over the cap right now? how
// far under the floor?) at every schedule read, the same "compute the
// fact, let the caller/human decide" precedent reconcileRevenueEvent
// above already established for period-level reconciliation
// (`reconciled: false`... "must be surfaced to a Finance Operator, not
// silently accepted"). apps/api's economics service calls this from
// listSchedules(); apps/web's ScheduleSummary.tsx renders it.

export interface ScheduleCapFloorInput {
  capMinor: bigint | null;
  floorMinor: bigint | null;
  /** SUM of every ACCRUAL-type (never ADJUSTMENT/PAYMENT/REVERSAL) CommissionAccrual.amountMinor row ever recorded against this ONE schedule version — the "TOTAL distributable base this schedule version ever computes against" the schema comment names, resolved by the caller (apps/api) via a real DB aggregate, never estimated here. */
  cumulativeDistributedMinor: bigint;
}

export interface ScheduleCapFloorStatus {
  /** true whenever capMinor is null (no cap configured — vacuously within it) or cumulativeDistributedMinor <= capMinor. */
  withinCap: boolean;
  /** How far over capMinor cumulativeDistributedMinor currently sits — null whenever withinCap is true (including "no cap configured" — there is nothing to be "exceeded by"). */
  capExceededByMinor: bigint | null;
  /** true whenever floorMinor is null (no floor configured — vacuously satisfied) or cumulativeDistributedMinor >= floorMinor. */
  withinFloor: boolean;
  /** How far short of floorMinor cumulativeDistributedMinor currently sits — null whenever withinFloor is true (including "no floor configured"). A nonzero shortfall is routine mid-life for a schedule that hasn't finished accruing yet, not necessarily an error — same "compute the fact, let the human read it in context" stance as reconcileRevenueEvent. */
  floorShortfallMinor: bigint | null;
}

/**
 * Pure comparison — zero-DB, zero-clock, same discipline as every other
 * function in this file. `cumulativeDistributedMinor` must already be
 * non-negative (a SUM of ACCRUAL amounts, which are themselves always
 * non-negative CREDIT entries per computeCommissionSplits' own
 * construction); capMinor/floorMinor, when present, must be
 * non-negative too — asserted, not assumed, same "fail loud on a
 * malformed input" stance as this file's other functions.
 */
export function evaluateScheduleCapFloor(input: ScheduleCapFloorInput): ScheduleCapFloorStatus {
  assertBigIntMinorUnits(input.cumulativeDistributedMinor, "cumulativeDistributedMinor");
  if (input.capMinor !== null) assertBigIntMinorUnits(input.capMinor, "capMinor");
  if (input.floorMinor !== null) assertBigIntMinorUnits(input.floorMinor, "floorMinor");

  const capExceededByMinor = input.capMinor !== null && input.cumulativeDistributedMinor > input.capMinor ? input.cumulativeDistributedMinor - input.capMinor : null;
  const floorShortfallMinor = input.floorMinor !== null && input.cumulativeDistributedMinor < input.floorMinor ? input.floorMinor - input.cumulativeDistributedMinor : null;

  return {
    withinCap: capExceededByMinor === null,
    capExceededByMinor,
    withinFloor: floorShortfallMinor === null,
    floorShortfallMinor,
  };
}
