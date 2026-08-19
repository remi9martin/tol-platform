import { describe, expect, it } from "vitest";
import { MoneyInvariantError } from "./money.js";
import { reconcileOpportunityVolume, type OpportunityVolumeSummary, type VolumeSliceInput } from "./volume-reconciliation.js";

const summary = (overrides: Partial<OpportunityVolumeSummary> = {}): OpportunityVolumeSummary => ({
  currency: "USD",
  offeredCardGpvMinor: 1_000_000n,
  movableNowMinor: 100_000n,
  movable30dMinor: 400_000n,
  movable90dMinor: 800_000n,
  ...overrides,
});

const slice = (overrides: Partial<VolumeSliceInput> = {}): VolumeSliceInput => ({
  jurisdiction: "US",
  mcc: "5411",
  cardOrigin: "DOMESTIC",
  channel: "ECOMMERCE",
  period: "2026-07",
  currency: "USD",
  amountMinor: 600_000n,
  ...overrides,
});

describe("reconcileOpportunityVolume", () => {
  it("reconciles when the slice sum exactly matches offeredCardGpvMinor and movability ordering holds", () => {
    const slices = [slice({ amountMinor: 600_000n }), slice({ mcc: "5812", amountMinor: 400_000n })];
    const result = reconcileOpportunityVolume(slices, summary());
    expect(result.reconciled).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.sliceTotalMinor).toBe(1_000_000n);
  });

  it("reconciles trivially for a fresh Opportunity — zero slices, zero offered volume", () => {
    const result = reconcileOpportunityVolume([], summary({ offeredCardGpvMinor: 0n, movableNowMinor: 0n, movable30dMinor: 0n, movable90dMinor: 0n }));
    expect(result.reconciled).toBe(true);
    expect(result.sliceTotalMinor).toBe(0n);
  });

  it("blocks (does not reconcile) when offered volume is positive but no slices exist yet", () => {
    const result = reconcileOpportunityVolume([], summary());
    expect(result.reconciled).toBe(false);
    expect(result.mismatches).toEqual([
      { code: "sum_mismatch", message: expect.stringContaining("SUM(volume slices) = 0") },
    ]);
  });

  it("groups the SAME finest-grain slices by jurisdiction-only vs mcc-only vs jurisdiction+mcc — all three groupings sum identically, matching the spec's three restated SUM(...) formulas", () => {
    const slices = [
      slice({ jurisdiction: "US", mcc: "5411", amountMinor: 300_000n }),
      slice({ jurisdiction: "US", mcc: "5812", amountMinor: 300_000n }),
      slice({ jurisdiction: "GB", mcc: "5411", amountMinor: 400_000n }),
    ];
    const byJurisdiction = new Map<string, bigint>();
    const byMcc = new Map<string, bigint>();
    for (const s of slices) {
      byJurisdiction.set(s.jurisdiction, (byJurisdiction.get(s.jurisdiction) ?? 0n) + s.amountMinor);
      byMcc.set(s.mcc, (byMcc.get(s.mcc) ?? 0n) + s.amountMinor);
    }
    const sumByJurisdiction = [...byJurisdiction.values()].reduce((a, b) => a + b, 0n);
    const sumByMcc = [...byMcc.values()].reduce((a, b) => a + b, 0n);
    const result = reconcileOpportunityVolume(slices, summary());
    expect(sumByJurisdiction).toBe(1_000_000n);
    expect(sumByMcc).toBe(1_000_000n);
    expect(result.sliceTotalMinor).toBe(1_000_000n);
    expect(result.reconciled).toBe(true);
  });

  it("fails loudly (sum_mismatch) on a genuine total mismatch, never silently accepting an approximate number", () => {
    const slices = [slice({ amountMinor: 999_999n })];
    const result = reconcileOpportunityVolume(slices, summary());
    expect(result.reconciled).toBe(false);
    expect(result.mismatches.map((m) => m.code)).toContain("sum_mismatch");
  });

  it("flags a duplicate (jurisdiction, mcc, cardOrigin, channel, period) cell as double-counting, even if the total happens to match", () => {
    const slices = [
      slice({ amountMinor: 500_000n }),
      slice({ amountMinor: 500_000n }), // identical cell key to the row above
    ];
    const result = reconcileOpportunityVolume(slices, summary());
    expect(result.mismatches.map((m) => m.code)).toContain("duplicate_cell");
  });

  it("flags a movability-order violation independently of whether the sum reconciles", () => {
    const slices = [slice({ amountMinor: 1_000_000n })];
    const badSummary = summary({ movable30dMinor: 50_000n }); // movableNow (100k) > movable30d (50k)
    const result = reconcileOpportunityVolume(slices, badSummary);
    expect(result.reconciled).toBe(false);
    expect(result.mismatches).toEqual([{ code: "movability_order", message: expect.any(String) }]);
  });

  it("allows movability figures to be exactly equal (non-strict <=)", () => {
    const slices = [slice({ amountMinor: 1_000_000n })];
    const equalSummary = summary({ movableNowMinor: 1_000_000n, movable30dMinor: 1_000_000n, movable90dMinor: 1_000_000n, offeredCardGpvMinor: 1_000_000n });
    const result = reconcileOpportunityVolume(slices, equalSummary);
    expect(result.mismatches.find((m) => m.code === "movability_order")).toBeUndefined();
  });

  it("flags a currency mismatch and excludes that slice from the sum, rather than silently combining mixed currencies", () => {
    const slices = [slice({ amountMinor: 600_000n, currency: "USD" }), slice({ mcc: "5812", amountMinor: 400_000n, currency: "EUR" })];
    const result = reconcileOpportunityVolume(slices, summary({ currency: "USD", offeredCardGpvMinor: 600_000n }));
    expect(result.mismatches.map((m) => m.code)).toContain("currency_mismatch");
    // The EUR slice's 400_000n is EXCLUDED, not added — sliceTotalMinor
    // reflects only the USD-matching slice, so it happens to also equal
    // offeredCardGpvMinor here (600_000n) without a false sum_mismatch
    // on top of the real currency_mismatch.
    expect(result.sliceTotalMinor).toBe(600_000n);
    expect(result.mismatches.map((m) => m.code)).not.toContain("sum_mismatch");
    expect(result.reconciled).toBe(false);
  });

  it("throws MoneyInvariantError for a negative amountMinor — a corrupt input, not a reconciliation-level mismatch", () => {
    const slices = [slice({ amountMinor: -1n })];
    expect(() => reconcileOpportunityVolume(slices, summary())).toThrow(MoneyInvariantError);
  });

  it("is deterministic — repeated calls on identical inputs produce byte-identical results", () => {
    const slices = [slice({ amountMinor: 600_000n }), slice({ mcc: "5812", amountMinor: 400_000n })];
    const s = summary();
    const results = Array.from({ length: 25 }, () => reconcileOpportunityVolume(slices, s));
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
  });
});
