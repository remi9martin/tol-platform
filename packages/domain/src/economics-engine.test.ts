import { describe, expect, it } from "vitest";
import { MoneyInvariantError } from "./money.js";
import {
  ECONOMICS_ENGINE_VERSION,
  EconomicsInvariantError,
  computeAccrualBalance,
  computeCommissionSplits,
  evaluateScheduleCapFloor,
  reconcileRevenueEvent,
  selectComponentsForBasis,
  type AccrualLedgerEntryLike,
  type EconomicsComponentInput,
} from "./economics-engine.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");

const component = (overrides: Partial<EconomicsComponentInput> = {}): EconomicsComponentInput => ({
  componentId: "comp-a",
  recipientOrgId: "org-a",
  componentType: "PERCENTAGE_BPS",
  bps: 10_000,
  fixedAmountMinor: null,
  claimId: null,
  priority: 1,
  ...overrides,
});

describe("computeCommissionSplits — money exactness", () => {
  it("splits a single 100% bps component exactly", () => {
    const result = computeCommissionSplits({
      netDistributableMinor: 1_000_00n,
      components: [component()],
      scheduleId: "sched-1",
      scheduleVersion: 1,
      now: NOW,
    });
    expect(result.entries).toEqual([{ componentId: "comp-a", recipientOrgId: "org-a", claimId: null, amountMinor: 1_000_00n, direction: "CREDIT" }]);
    expect(result.calculationVersion).toBe(ECONOMICS_ENGINE_VERSION);
    expect(result.computedAt).toBe(NOW.toISOString());
  });

  it("splits two bps components (7000/3000) with zero leakage on a round number", () => {
    const result = computeCommissionSplits({
      netDistributableMinor: 100_000n,
      components: [component({ componentId: "platform", bps: 7_000 }), component({ componentId: "contributor", recipientOrgId: "org-b", bps: 3_000, claimId: "claim-1" })],
      scheduleId: "sched-2",
      scheduleVersion: 1,
      now: NOW,
    });
    const byId = new Map(result.entries.map((e) => [e.componentId, e.amountMinor]));
    expect(byId.get("platform")).toBe(70_000n);
    expect(byId.get("contributor")).toBe(30_000n);
    const sum = result.entries.reduce((a, e) => a + e.amountMinor, 0n);
    expect(sum).toBe(100_000n);
  });

  it("distributes an UNEVEN split (3334/3333/3333 bps of 100 minor units) via largest-remainder with zero leakage — the core money-exactness proof", () => {
    // 100 * 3334 / 10000 = 33.34 -> floor 33, remainder 3400/10000
    // 100 * 3333 / 10000 = 33.33 -> floor 33, remainder 3300/10000 (x2)
    // floored sum = 99, leftoverPool = 1 -> goes to the LARGEST remainder (3334 component)
    const result = computeCommissionSplits({
      netDistributableMinor: 100n,
      components: [
        component({ componentId: "c1", bps: 3_334 }),
        component({ componentId: "c2", bps: 3_333 }),
        component({ componentId: "c3", bps: 3_333 }),
      ],
      scheduleId: "sched-3",
      scheduleVersion: 1,
      now: NOW,
    });
    const byId = new Map(result.entries.map((e) => [e.componentId, e.amountMinor]));
    expect(byId.get("c1")).toBe(34n); // 33 + the leftover unit (largest remainder)
    expect(byId.get("c2")).toBe(33n);
    expect(byId.get("c3")).toBe(33n);
    const sum = result.entries.reduce((a, e) => a + e.amountMinor, 0n);
    expect(sum).toBe(100n);
  });

  it("breaks a remainder TIE by componentId ascending, deterministically", () => {
    // 3 components at equal 3333/3333/3334... use an exact tie instead:
    // netDistributableMinor=10, bps [3400,3300,3300] -> exact shares 3.4/3.3/3.3
    // floors 3/3/3=9, leftover=1 -> the ONLY largest remainder is c1 (0.4 > 0.3) — not a tie.
    // For a genuine tie, use bps [3350,3350,3300]: exact 3.35/3.35/3.30 -> floors 3/3/3=9, leftover=1,
    // remainders equal for c1 and c2 (both .35) — tie broken by componentId ascending ("ca" < "cb").
    const result = computeCommissionSplits({
      netDistributableMinor: 10n,
      components: [
        component({ componentId: "cb", bps: 3_350 }),
        component({ componentId: "ca", bps: 3_350 }),
        component({ componentId: "cc", bps: 3_300 }),
      ],
      scheduleId: "sched-tie",
      scheduleVersion: 1,
      now: NOW,
    });
    const byId = new Map(result.entries.map((e) => [e.componentId, e.amountMinor]));
    expect(byId.get("ca")).toBe(4n); // tie winner: lexicographically smaller componentId
    expect(byId.get("cb")).toBe(3n);
    expect(byId.get("cc")).toBe(3n);
  });

  it("handles a FIXED_AMOUNT component deducted first, remainder split by bps", () => {
    const result = computeCommissionSplits({
      netDistributableMinor: 1_000n,
      components: [
        component({ componentId: "referral-fee", componentType: "FIXED_AMOUNT", bps: null, fixedAmountMinor: 100n }),
        component({ componentId: "rest", bps: 10_000 }),
      ],
      scheduleId: "sched-4",
      scheduleVersion: 1,
      now: NOW,
    });
    const byId = new Map(result.entries.map((e) => [e.componentId, e.amountMinor]));
    expect(byId.get("referral-fee")).toBe(100n);
    expect(byId.get("rest")).toBe(900n);
  });

  it("handles 100% FIXED_AMOUNT coverage with no bps components at all", () => {
    const result = computeCommissionSplits({
      netDistributableMinor: 500n,
      components: [component({ componentId: "flat", componentType: "FIXED_AMOUNT", bps: null, fixedAmountMinor: 500n })],
      scheduleId: "sched-5",
      scheduleVersion: 1,
      now: NOW,
    });
    expect(result.entries).toEqual([{ componentId: "flat", recipientOrgId: "org-a", claimId: null, amountMinor: 500n, direction: "CREDIT" }]);
  });

  it("throws EconomicsInvariantError when bps components do not sum to exactly 10000", () => {
    expect(() =>
      computeCommissionSplits({
        netDistributableMinor: 100n,
        components: [component({ bps: 9_000 })],
        scheduleId: "sched-6",
        scheduleVersion: 1,
        now: NOW,
      }),
    ).toThrow(EconomicsInvariantError);
  });

  it("throws when FIXED_AMOUNT components exceed netDistributableMinor", () => {
    expect(() =>
      computeCommissionSplits({
        netDistributableMinor: 100n,
        components: [component({ componentType: "FIXED_AMOUNT", bps: null, fixedAmountMinor: 200n })],
        scheduleId: "sched-7",
        scheduleVersion: 1,
        now: NOW,
      }),
    ).toThrow(EconomicsInvariantError);
  });

  it("throws when a remainder is left over with zero bps components to absorb it — money must never vanish silently", () => {
    expect(() =>
      computeCommissionSplits({
        netDistributableMinor: 100n,
        components: [component({ componentType: "FIXED_AMOUNT", bps: null, fixedAmountMinor: 60n })],
        scheduleId: "sched-8",
        scheduleVersion: 1,
        now: NOW,
      }),
    ).toThrow(EconomicsInvariantError);
  });

  it("throws on an empty component list", () => {
    expect(() =>
      computeCommissionSplits({ netDistributableMinor: 100n, components: [], scheduleId: "sched-9", scheduleVersion: 1, now: NOW }),
    ).toThrow(EconomicsInvariantError);
  });

  it("throws on a duplicate componentId", () => {
    expect(() =>
      computeCommissionSplits({
        netDistributableMinor: 100n,
        components: [component({ componentId: "dupe", bps: 5_000 }), component({ componentId: "dupe", bps: 5_000 })],
        scheduleId: "sched-10",
        scheduleVersion: 1,
        now: NOW,
      }),
    ).toThrow(EconomicsInvariantError);
  });

  it("throws MoneyInvariantError for a negative netDistributableMinor — a corrupt input, not a splitting-level concern", () => {
    expect(() =>
      computeCommissionSplits({ netDistributableMinor: -1n, components: [component()], scheduleId: "sched-11", scheduleVersion: 1, now: NOW }),
    ).toThrow(MoneyInvariantError);
  });

  it("is deterministic — repeated calls on identical inputs produce byte-identical results", () => {
    const input = {
      netDistributableMinor: 987_654n,
      components: [component({ componentId: "c1", bps: 4_321 }), component({ componentId: "c2", bps: 3_333 }), component({ componentId: "c3", bps: 2_346 })],
      scheduleId: "sched-det",
      scheduleVersion: 1,
      now: NOW,
    };
    const results = Array.from({ length: 15 }, () => computeCommissionSplits(input));
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("is order-independent — shuffling the components array produces the SAME final amounts per componentId (largest-remainder ranks by remainder value, never array position)", () => {
    const comps = [component({ componentId: "c1", bps: 3_334 }), component({ componentId: "c2", bps: 3_333 }), component({ componentId: "c3", bps: 3_333 })];
    const forward = computeCommissionSplits({ netDistributableMinor: 100n, components: comps, scheduleId: "sched-order", scheduleVersion: 1, now: NOW });
    const reversed = computeCommissionSplits({ netDistributableMinor: 100n, components: [...comps].reverse(), scheduleId: "sched-order", scheduleVersion: 1, now: NOW });
    const toMap = (entries: typeof forward.entries) => new Map(entries.map((e) => [e.componentId, e.amountMinor]));
    expect(toMap(forward.entries)).toEqual(toMap(reversed.entries));
  });

  it("proves zero leakage across a spread of uneven bps distributions and net amounts — the headline money-exactness proof for this gate", () => {
    const cases: { net: bigint; bpsSplit: number[] }[] = [
      { net: 1n, bpsSplit: [3_334, 3_333, 3_333] },
      { net: 7n, bpsSplit: [5_000, 3_000, 2_000] },
      { net: 999n, bpsSplit: [1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_112] },
      { net: 1_234_567n, bpsSplit: [6_667, 3_333] },
      { net: 30_000_000_00n, bpsSplit: [7_500, 1_500, 1_000] },
      { net: 0n, bpsSplit: [5_000, 5_000] },
    ];
    for (const { net, bpsSplit } of cases) {
      const comps = bpsSplit.map((bps, i) => component({ componentId: `c${i}`, bps }));
      const result = computeCommissionSplits({ netDistributableMinor: net, components: comps, scheduleId: "sched-sweep", scheduleVersion: 1, now: NOW });
      const sum = result.entries.reduce((a, e) => a + e.amountMinor, 0n);
      expect(sum).toBe(net);
      // Every individual amount is non-negative — no component ever goes
      // negative as a side effect of the remainder distribution.
      for (const e of result.entries) expect(e.amountMinor >= 0n).toBe(true);
    }
  });
});

describe("selectComponentsForBasis", () => {
  it("selects components whose override matches the target basis", () => {
    const comps = [component({ componentId: "recurring" }), component({ componentId: "setup", claimId: null })];
    const overrides = new Map<string, "GROSS_PROCESSING_VOLUME" | "SETUP_FEE" | null>([
      ["recurring", null], // inherits schedule basis
      ["setup", "SETUP_FEE"],
    ]);
    const selected = selectComponentsForBasis(comps, "GROSS_PROCESSING_VOLUME", "GROSS_PROCESSING_VOLUME", overrides);
    expect(selected.map((c) => c.componentId)).toEqual(["recurring"]);

    const setupSelected = selectComponentsForBasis(comps, "GROSS_PROCESSING_VOLUME", "SETUP_FEE", overrides);
    expect(setupSelected.map((c) => c.componentId)).toEqual(["setup"]);
  });

  it("returns an empty array when nothing matches the target basis", () => {
    const comps = [component()];
    const selected = selectComponentsForBasis(comps, "GROSS_PROCESSING_VOLUME", "SETUP_FEE", new Map());
    expect(selected).toEqual([]);
  });
});

describe("computeAccrualBalance — traceability", () => {
  const accrual = (amountMinor: bigint): AccrualLedgerEntryLike => ({ entryType: "ACCRUAL", direction: "CREDIT", amountMinor });
  const payment = (amountMinor: bigint): AccrualLedgerEntryLike => ({ entryType: "PAYMENT", direction: "DEBIT", amountMinor });
  const adjustment = (amountMinor: bigint, direction: "CREDIT" | "DEBIT"): AccrualLedgerEntryLike => ({ entryType: "ADJUSTMENT", direction, amountMinor });
  const reversal = (amountMinor: bigint): AccrualLedgerEntryLike => ({ entryType: "REVERSAL", direction: "DEBIT", amountMinor });

  it("a lone ACCRUAL entry is ACCRUED, fully outstanding", () => {
    const balance = computeAccrualBalance([accrual(1_000n)]);
    expect(balance).toEqual({ status: "ACCRUED", originalAmountMinor: 1_000n, netAmountMinor: 1_000n, paidAmountMinor: 0n, outstandingAmountMinor: 1_000n });
  });

  it("ACCRUAL + full PAYMENT is PAID, zero outstanding", () => {
    const balance = computeAccrualBalance([accrual(1_000n), payment(1_000n)]);
    expect(balance.status).toBe("PAID");
    expect(balance.outstandingAmountMinor).toBe(0n);
  });

  it("ACCRUAL + partial PAYMENT is PARTIALLY_PAID", () => {
    const balance = computeAccrualBalance([accrual(1_000n), payment(400n)]);
    expect(balance.status).toBe("PARTIALLY_PAID");
    expect(balance.outstandingAmountMinor).toBe(600n);
  });

  it("ACCRUAL + two PAYMENTs summing to the full amount is PAID", () => {
    const balance = computeAccrualBalance([accrual(1_000n), payment(400n), payment(600n)]);
    expect(balance.status).toBe("PAID");
    expect(balance.paidAmountMinor).toBe(1_000n);
  });

  it("ACCRUAL + CREDIT adjustment increases the net amount and is ADJUSTED", () => {
    const balance = computeAccrualBalance([accrual(1_000n), adjustment(200n, "CREDIT")]);
    expect(balance.status).toBe("ADJUSTED");
    expect(balance.netAmountMinor).toBe(1_200n);
    expect(balance.outstandingAmountMinor).toBe(1_200n);
  });

  it("ACCRUAL + DEBIT adjustment decreases the net amount and is ADJUSTED", () => {
    const balance = computeAccrualBalance([accrual(1_000n), adjustment(300n, "DEBIT")]);
    expect(balance.status).toBe("ADJUSTED");
    expect(balance.netAmountMinor).toBe(700n);
  });

  it("a DEBIT adjustment that fully zeroes the net amount reads as PAID (zero outstanding), not merely ADJUSTED — outstanding balance is what matters, not entry-type presence", () => {
    const balance = computeAccrualBalance([accrual(1_000n), adjustment(1_000n, "DEBIT")]);
    expect(balance.outstandingAmountMinor).toBe(0n);
    expect(balance.status).toBe("PAID");
  });

  it("REVERSAL always wins, regardless of prior payments/adjustments", () => {
    const balance = computeAccrualBalance([accrual(1_000n), payment(200n), adjustment(50n, "CREDIT"), reversal(850n)]);
    expect(balance.status).toBe("REVERSED");
  });

  it("a REVERSAL zeroes outstandingAmountMinor unconditionally — real fix, review: a caller validating a payment/adjustment amount against outstandingAmountMinor alone (without separately checking status) must never see a reversed accrual as still having money owed", () => {
    // A reversal with NO prior payment — the original bug reported the
    // full original amount (1000) as still outstanding here.
    const balance = computeAccrualBalance([accrual(1_000n), reversal(1_000n)]);
    expect(balance.status).toBe("REVERSED");
    expect(balance.outstandingAmountMinor).toBe(0n);
  });

  it("a REVERSAL zeroes outstandingAmountMinor even alongside a prior partial payment and a credit adjustment (the netAmountMinor/paidAmountMinor arithmetic would otherwise still show a positive balance)", () => {
    const balance = computeAccrualBalance([accrual(1_000n), payment(200n), adjustment(50n, "CREDIT"), reversal(850n)]);
    expect(balance.outstandingAmountMinor).toBe(0n);
  });

  it("throws when there is no ACCRUAL entry at all", () => {
    expect(() => computeAccrualBalance([payment(100n)])).toThrow(EconomicsInvariantError);
  });

  it("throws when there is more than one ACCRUAL entry in the same chain — a data-integrity violation", () => {
    expect(() => computeAccrualBalance([accrual(1_000n), accrual(500n)])).toThrow(EconomicsInvariantError);
  });

  it("is order-independent — shuffled entry order produces an identical balance", () => {
    const entries = [accrual(1_000n), adjustment(100n, "CREDIT"), payment(300n), payment(200n)];
    const forward = computeAccrualBalance(entries);
    const shuffled = computeAccrualBalance([entries[2]!, entries[0]!, entries[3]!, entries[1]!]);
    expect(shuffled).toEqual(forward);
  });
});

describe("reconcileRevenueEvent — the spec's own RECONCILIATION requirement", () => {
  it("reconciles when gross - deductions = net AND the ledger's ACCRUAL entries sum to net", () => {
    const result = reconcileRevenueEvent({
      grossAmountMinor: 1_000_000n,
      deductionsMinor: 50_000n,
      netDistributableMinor: 950_000n,
      ledgerEntries: [
        { entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 700_000n },
        { entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 250_000n },
      ],
    });
    expect(result.reconciled).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.distributedMinor).toBe(950_000n);
    expect(result.outstandingMinor).toBe(950_000n);
  });

  it("flags basis_mismatch when gross - deductions != netDistributableMinor", () => {
    const result = reconcileRevenueEvent({
      grossAmountMinor: 1_000_000n,
      deductionsMinor: 50_000n,
      netDistributableMinor: 900_000n, // should be 950_000n
      ledgerEntries: [{ entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 900_000n }],
    });
    expect(result.reconciled).toBe(false);
    expect(result.mismatches.map((m) => m.code)).toContain("basis_mismatch");
  });

  it("flags distribution_mismatch when ACCRUAL entries don't sum to netDistributableMinor", () => {
    const result = reconcileRevenueEvent({
      grossAmountMinor: 1_000_000n,
      deductionsMinor: 0n,
      netDistributableMinor: 1_000_000n,
      ledgerEntries: [{ entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 999_999n }],
    });
    expect(result.reconciled).toBe(false);
    expect(result.mismatches.map((m) => m.code)).toContain("distribution_mismatch");
  });

  it("computes outstandingMinor across a full accrual -> adjustment -> payment lifecycle for the whole period", () => {
    const result = reconcileRevenueEvent({
      grossAmountMinor: 100_000n,
      deductionsMinor: 0n,
      netDistributableMinor: 100_000n,
      ledgerEntries: [
        { entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 100_000n },
        { entryType: "ADJUSTMENT", direction: "DEBIT", amountMinor: 10_000n },
        { entryType: "PAYMENT", direction: "DEBIT", amountMinor: 60_000n },
      ],
    });
    // distributed 100k, net-adjusted 90k, paid 60k -> outstanding 30k
    expect(result.distributedMinor).toBe(100_000n);
    expect(result.paidMinor).toBe(60_000n);
    expect(result.outstandingMinor).toBe(30_000n);
    expect(result.reconciled).toBe(true); // basis + distribution both still hold; outstanding balance is informational, not itself a mismatch
  });

  it("reconciles trivially for a zero-amount period", () => {
    const result = reconcileRevenueEvent({ grossAmountMinor: 0n, deductionsMinor: 0n, netDistributableMinor: 0n, ledgerEntries: [] });
    expect(result.reconciled).toBe(true);
    expect(result.outstandingMinor).toBe(0n);
  });

  it("is deterministic and order-independent over ledgerEntries", () => {
    const entries: AccrualLedgerEntryLike[] = [
      { entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 500_000n },
      { entryType: "ACCRUAL", direction: "CREDIT", amountMinor: 500_000n },
      { entryType: "PAYMENT", direction: "DEBIT", amountMinor: 300_000n },
    ];
    const forward = reconcileRevenueEvent({ grossAmountMinor: 1_000_000n, deductionsMinor: 0n, netDistributableMinor: 1_000_000n, ledgerEntries: entries });
    const reversed = reconcileRevenueEvent({ grossAmountMinor: 1_000_000n, deductionsMinor: 0n, netDistributableMinor: 1_000_000n, ledgerEntries: [...entries].reverse() });
    expect(reversed).toEqual(forward);
  });
});

// Follow-up fix: DISCLOSURE, not enforcement — see
// evaluateScheduleCapFloor's own doc comment above for the full
// reasoning (a cap/floor breach is exposed as a fact, never blocks or
// truncates a split).
describe("evaluateScheduleCapFloor — disclosure, not enforcement (Follow-up fix)", () => {
  it("no cap, no floor: vacuously within both, nothing to disclose", () => {
    const result = evaluateScheduleCapFloor({ capMinor: null, floorMinor: null, cumulativeDistributedMinor: 500_000n });
    expect(result).toEqual({ withinCap: true, capExceededByMinor: null, withinFloor: true, floorShortfallMinor: null });
  });

  it("exactly AT the cap is still within it (breach is strictly greater-than)", () => {
    const result = evaluateScheduleCapFloor({ capMinor: 1_000_000n, floorMinor: null, cumulativeDistributedMinor: 1_000_000n });
    expect(result.withinCap).toBe(true);
    expect(result.capExceededByMinor).toBeNull();
  });

  it("one minor unit over the cap discloses the exact overage, never a clamped/rounded figure", () => {
    const result = evaluateScheduleCapFloor({ capMinor: 1_000_000n, floorMinor: null, cumulativeDistributedMinor: 1_000_001n });
    expect(result.withinCap).toBe(false);
    expect(result.capExceededByMinor).toBe(1n);
  });

  it("well over the cap discloses the real, large overage", () => {
    const result = evaluateScheduleCapFloor({ capMinor: 1_000_000n, floorMinor: null, cumulativeDistributedMinor: 4_500_000n });
    expect(result.capExceededByMinor).toBe(3_500_000n);
  });

  it("exactly AT the floor is within it (shortfall is strictly less-than)", () => {
    const result = evaluateScheduleCapFloor({ capMinor: null, floorMinor: 200_000n, cumulativeDistributedMinor: 200_000n });
    expect(result.withinFloor).toBe(true);
    expect(result.floorShortfallMinor).toBeNull();
  });

  it("a brand-new schedule (zero distributed yet) discloses the FULL floor as its shortfall — routine mid-life state, not an error", () => {
    const result = evaluateScheduleCapFloor({ capMinor: null, floorMinor: 50_000n, cumulativeDistributedMinor: 0n });
    expect(result.withinCap).toBe(true); // no cap configured
    expect(result.withinFloor).toBe(false);
    expect(result.floorShortfallMinor).toBe(50_000n);
  });

  it("above the floor by any amount is within it", () => {
    const result = evaluateScheduleCapFloor({ capMinor: null, floorMinor: 200_000n, cumulativeDistributedMinor: 200_001n });
    expect(result.withinFloor).toBe(true);
    expect(result.floorShortfallMinor).toBeNull();
  });

  it("cap AND floor configured together: over cap and (trivially) at/above floor discloses only the cap breach", () => {
    const result = evaluateScheduleCapFloor({ capMinor: 1_000_000n, floorMinor: 100_000n, cumulativeDistributedMinor: 1_200_000n });
    expect(result.withinCap).toBe(false);
    expect(result.capExceededByMinor).toBe(200_000n);
    expect(result.withinFloor).toBe(true);
    expect(result.floorShortfallMinor).toBeNull();
  });

  it("rejects a negative cumulativeDistributedMinor — fail loud, same discipline as every other function in this file", () => {
    expect(() => evaluateScheduleCapFloor({ capMinor: null, floorMinor: null, cumulativeDistributedMinor: -1n })).toThrow(MoneyInvariantError);
  });

  it("is a pure function: two calls with identical inputs produce a deep-equal result", () => {
    const input = { capMinor: 1_000_000n, floorMinor: 100_000n, cumulativeDistributedMinor: 1_200_000n };
    expect(evaluateScheduleCapFloor(input)).toEqual(evaluateScheduleCapFloor({ ...input }));
  });
});
