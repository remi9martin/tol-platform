// packages/domain/src/volume-reconciliation.ts
//
// the spec "Mandatory reconciliation" (verbatim):
//   SUM(volume_by_jurisdiction)       = offered_card_gpv
//   SUM(volume_by_mcc)                = offered_card_gpv
//   SUM(volume_by_jurisdiction_mcc)   = offered_card_gpv
//   movable_now <= movable_30d <= movable_90d <= offered_card_gpv
// "If totals do not reconcile, readiness is BLOCKED rather than silently
// accepting approximate numbers."
//
// WHY THREE SUM(...) CHECKS COLLAPSE TO ONE: each VolumeSlice row
// (schema.prisma) is already the FINEST-GRAIN cell — one
// (jurisdiction, mcc, cardOrigin, channel, period) combination. Grouping
// that SAME set of finest-grain rows by jurisdiction alone, by MCC
// alone, or by the jurisdiction+MCC pair, and summing each grouping, all
// produce the IDENTICAL grand total — grouping never changes a sum, only
// how it is partitioned for display. So "SUM(volume_by_jurisdiction) =
// offered_card_gpv" AND "SUM(volume_by_mcc) = offered_card_gpv" AND
// "SUM(volume_by_jurisdiction_mcc) = offered_card_gpv" are the SAME
// arithmetic fact restated three ways, PROVIDED no cell is
// double-counted — which is exactly what schema.prisma's VolumeSlice
// `@@unique([opportunityId, jurisdiction, mcc, cardOrigin, channel,
// period])` constraint (a real DB-level guard, not just an
// application-level one) exists to prevent. This function re-verifies
// that same no-duplicate-cell invariant defensively (belt and suspenders
// — same reasoning json-guards.ts already applies ALONGSIDE its DB
// constraints, not instead of them) before trusting the sum, so a caller
// that assembles slices from somewhere other than a fresh DB read (a
// draft/preview computation, a test fixture) still gets the real check.
//
// Pure, zero-DB, zero-clock — takes already-loaded slices and the
// Opportunity's own summary figures as plain arguments, same "compute
// against passed-in values, never a live query or clock read" discipline
// as this package's money.ts guards and claim-states.ts's
// isClaimProvisionalExpired.

import { MoneyInvariantError } from "./money.js";

export interface VolumeSliceInput {
  jurisdiction: string;
  mcc: string;
  cardOrigin: string;
  channel: string;
  period: string;
  currency: string;
  amountMinor: bigint;
}

export interface OpportunityVolumeSummary {
  currency: string;
  offeredCardGpvMinor: bigint;
  movableNowMinor: bigint;
  movable30dMinor: bigint;
  movable90dMinor: bigint;
}

export type VolumeMismatchCode = "duplicate_cell" | "sum_mismatch" | "movability_order" | "currency_mismatch";

export interface VolumeMismatch {
  code: VolumeMismatchCode;
  message: string;
}

export interface VolumeReconciliationResult {
  reconciled: boolean;
  sliceTotalMinor: bigint;
  offeredCardGpvMinor: bigint;
  mismatches: VolumeMismatch[];
}

/**
 * the spec's full "Mandatory reconciliation" block, as one real,
 * fail-loud check — see this file's header comment for why the scope's
 * three separate SUM(...) formulas collapse to one grand-total
 * comparison over VolumeSlice's finest-grain rows, plus a duplicate-cell
 * guard that is what makes that collapse valid. `reconciled: false`
 * means readiness MUST be BLOCKED (p.15: "If totals do not reconcile,
 * readiness is BLOCKED rather than silently accepting approximate
 * numbers") — this function only computes the fact; callers
 * (packages/evidence's Passport readiness engine, apps/api's
 * opportunities service) are responsible for actually blocking on it.
 * An Opportunity with zero slices and zero offeredCardGpvMinor
 * reconciles trivially (0n === 0n) — nothing to block on yet; a fresh
 * Opportunity with offered volume but no slices yet does NOT reconcile
 * (0n !== a positive figure), correctly blocking until slices are added.
 *
 * Every slice's `currency` must match the Opportunity's own `currency`
 * (real fix, review — correctly caught that summing `amountMinor` across
 * MIXED currencies would silently add USD cents to EUR cents as if they
 * were the same unit, producing a meaningless total). A currency
 * mismatch is reported per-slice and, per this function's own "fail
 * loud, never approximate" mandate, does NOT contribute that slice's
 * amount to `sliceTotalMinor` — a wrong-currency figure is excluded
 * from the sum rather than corrupting it.
 */
export function reconcileOpportunityVolume(
  slices: readonly VolumeSliceInput[],
  summary: OpportunityVolumeSummary,
): VolumeReconciliationResult {
  const mismatches: VolumeMismatch[] = [];

  const seenCells = new Set<string>();
  let sliceTotalMinor = 0n;
  for (const s of slices) {
    if (s.amountMinor < 0n) {
      throw new MoneyInvariantError(`VolumeSlice.amountMinor must not be negative — got ${s.amountMinor}`);
    }
    const cellKey = `${s.jurisdiction}|${s.mcc}|${s.cardOrigin}|${s.channel}|${s.period}`;
    if (seenCells.has(cellKey)) {
      mismatches.push({
        code: "duplicate_cell",
        message: `duplicate volume slice cell (jurisdiction=${s.jurisdiction}, mcc=${s.mcc}, cardOrigin=${s.cardOrigin}, channel=${s.channel}, period=${s.period}) — would double-count volume in the SUM check`,
      });
    }
    seenCells.add(cellKey);

    if (s.currency !== summary.currency) {
      mismatches.push({
        code: "currency_mismatch",
        message: `volume slice cell (jurisdiction=${s.jurisdiction}, mcc=${s.mcc}, period=${s.period}) is in ${s.currency}, but the Opportunity's currency is ${summary.currency} — excluded from the sum rather than silently combined`,
      });
      continue;
    }
    sliceTotalMinor += s.amountMinor;
  }

  if (sliceTotalMinor !== summary.offeredCardGpvMinor) {
    mismatches.push({
      code: "sum_mismatch",
      message: `SUM(volume slices) = ${sliceTotalMinor} does not equal offeredCardGpvMinor = ${summary.offeredCardGpvMinor}`,
    });
  }

  if (
    !(
      summary.movableNowMinor <= summary.movable30dMinor &&
      summary.movable30dMinor <= summary.movable90dMinor &&
      summary.movable90dMinor <= summary.offeredCardGpvMinor
    )
  ) {
    mismatches.push({
      code: "movability_order",
      message: `movable_now (${summary.movableNowMinor}) <= movable_30d (${summary.movable30dMinor}) <= movable_90d (${summary.movable90dMinor}) <= offered_card_gpv (${summary.offeredCardGpvMinor}) does not hold`,
    });
  }

  return {
    reconciled: mismatches.length === 0,
    sliceTotalMinor,
    offeredCardGpvMinor: summary.offeredCardGpvMinor,
    mismatches,
  };
}
