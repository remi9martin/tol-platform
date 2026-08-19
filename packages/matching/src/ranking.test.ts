import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "./eligibility.js";
import { rankMatches } from "./ranking.js";
import type { MatchCapacityInput, MatchContext, MatchOpportunityInput } from "./types.js";

function opportunity(overrides: Partial<MatchOpportunityInput> = {}): MatchOpportunityInput {
  return {
    id: "opp-1",
    currency: "USD",
    jurisdictions: ["US"],
    mccs: ["5411"],
    movable30dMinor: 1_000_000n,
    ...overrides,
  };
}

function capacity(id: string, overrides: Partial<MatchCapacityInput> = {}): MatchCapacityInput {
  return {
    id,
    currency: "USD",
    jurisdictions: ["US"],
    mccsAccepted: ["5411"],
    mccsExcluded: [],
    acceptingNewVolume: true,
    monthlyCapacityMinor: 5_000_000n,
    minTicketMinor: 100,
    maxTicketMinor: 100_000,
    maxChargebackBps: 200,
    maxFraudBps: 200,
    maxRefundBps: 500,
    settlementRail: "ACH",
    settlementCadenceDays: 2,
    freshnessClass: "FRESH",
    commercialTerms: { mdrBps: 250, fixedFeeMinor: 30, model: "blended" },
    ...overrides,
  };
}

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  // providerPassportStatus defaults to READY so a fixture capacity is
  // genuinely fully-eligible by default (matches eligibility.test.ts's
  // own ctx() convention) — rankMatches itself doesn't read this field,
  // it only matters for the eligibility-integration test below, but
  // keeping ONE shared default here avoids a second, inconsistent helper.
  return { now: new Date("2026-08-18T12:00:00.000Z"), providerPassportStatus: "READY", ...overrides };
}

describe("rankMatches — basic ordering", () => {
  it("returns an empty array for no eligible capacities", () => {
    expect(rankMatches(opportunity(), [], ctx())).toEqual([]);
  });

  it("a single capacity ranks 1 with no ties", () => {
    const result = rankMatches(opportunity(), [capacity("only")], ctx());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ capacityId: "only", rank: 1, tiedWith: [] });
  });

  it("orders strictly by total score, highest first", () => {
    const cheap = capacity("cheap", { commercialTerms: { mdrBps: 90, fixedFeeMinor: 0, model: "flat" } });
    const expensive = capacity("expensive", { commercialTerms: { mdrBps: 440, fixedFeeMinor: 0, model: "flat" } });
    const mid = capacity("mid", { commercialTerms: { mdrBps: 265, fixedFeeMinor: 0, model: "flat" } });
    const result = rankMatches(opportunity(), [mid, expensive, cheap], ctx());
    expect(result.map((r) => r.capacityId)).toEqual(["cheap", "mid", "expensive"]);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("each entry carries a full explainable breakdown (9 factors + algorithmVersion)", () => {
    const result = rankMatches(opportunity(), [capacity("a")], ctx());
    expect(result[0]!.breakdown.factors).toHaveLength(9);
    expect(result[0]!.breakdown.algorithmVersion).toBeTruthy();
  });
});

describe("rankMatches — tie-breaking (no scope-named ranking tie-breaker; documented capacityId-ascending determinism key)", () => {
  it("breaks an exact-total tie by ascending capacityId", () => {
    // Identical capacities (down to id) produce identical totals.
    const result = rankMatches(opportunity(), [capacity("zzz"), capacity("aaa")], ctx());
    expect(result.map((r) => r.capacityId)).toEqual(["aaa", "zzz"]);
  });

  it("a genuine tie surfaces both capacityIds in tiedWith", () => {
    const result = rankMatches(opportunity(), [capacity("zzz"), capacity("aaa")], ctx());
    expect(result.find((r) => r.capacityId === "aaa")!.tiedWith).toEqual(["zzz"]);
    expect(result.find((r) => r.capacityId === "zzz")!.tiedWith).toEqual(["aaa"]);
  });

  it("a capacity NOT part of any tie has an empty tiedWith even when other entries in the same set are tied", () => {
    const distinct = capacity("distinct", { commercialTerms: { mdrBps: 90, fixedFeeMinor: 0, model: "flat" } });
    const result = rankMatches(opportunity(), [capacity("tie-a"), capacity("tie-b"), distinct], ctx());
    expect(result.find((r) => r.capacityId === "distinct")!.tiedWith).toEqual([]);
  });

  it("three-way ties all list each other", () => {
    const result = rankMatches(opportunity(), [capacity("c"), capacity("a"), capacity("b")], ctx());
    for (const entry of result) {
      expect([...entry.tiedWith].sort()).toEqual(["a", "b", "c"].filter((id) => id !== entry.capacityId));
    }
  });
});

describe("rankMatches — determinism / permutation invariance (the spec)", () => {
  it("the same set of capacities produces the same ranking regardless of input order", () => {
    const capacities = [
      capacity("a", { commercialTerms: { mdrBps: 300, fixedFeeMinor: 0, model: "flat" } }),
      capacity("b", { commercialTerms: { mdrBps: 100, fixedFeeMinor: 0, model: "flat" } }),
      capacity("c", { commercialTerms: { mdrBps: 100, fixedFeeMinor: 0, model: "flat" } }),
      capacity("d", { commercialTerms: { mdrBps: 200, fixedFeeMinor: 0, model: "flat" } }),
    ];
    const baseline = rankMatches(opportunity(), capacities, ctx());

    const permutations = [
      [capacities[3]!, capacities[1]!, capacities[0]!, capacities[2]!],
      [capacities[2]!, capacities[0]!, capacities[3]!, capacities[1]!],
      [...capacities].reverse(),
    ];
    for (const perm of permutations) {
      expect(rankMatches(opportunity(), perm, ctx())).toEqual(baseline);
    }
  });

  it("500 calls with identical inputs all produce a deep-equal ranking", () => {
    const capacities = [capacity("a"), capacity("b", { settlementCadenceDays: 5 })];
    const context = ctx({ merchantRiskProfile: { chargebackBps: 10 } });
    const first = rankMatches(opportunity(), capacities, context);
    for (let i = 0; i < 500; i++) {
      expect(rankMatches(opportunity(), capacities, context)).toEqual(first);
    }
  });

  it("does not mutate the input array or its elements", () => {
    const capacities = [capacity("b"), capacity("a")];
    const stringify = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
    const before = stringify(capacities);
    rankMatches(opportunity(), capacities, ctx());
    expect(stringify(capacities)).toBe(before);
  });
});

describe("integration: eligibility runs first (the spec INVARIANT — 'an ineligible provider cannot receive a higher final recommendation rank than an eligible provider')", () => {
  it("filtering to eligible-only before ranking means an ineligible candidate never appears in the ranked output at all", () => {
    const opp = opportunity({ jurisdictions: ["US"], mccs: ["5411"] });
    const eligibleCap = capacity("eligible-provider");
    const ineligibleCap = capacity("ineligible-provider", { jurisdictions: ["DE"] }); // no jurisdiction overlap -> INELIGIBLE
    const context = ctx();

    const evalEligible = evaluateEligibility(opp, eligibleCap, context);
    const evalIneligible = evaluateEligibility(opp, ineligibleCap, context);
    expect(evalEligible.eligible).toBe(true);
    expect(evalIneligible.eligible).toBe(false);

    // The real pipeline (apps/api's matching service, this stage): evaluate
    // every candidate, keep only eligible: true, rank ONLY those.
    const eligibleCapacities = [eligibleCap, ineligibleCap].filter((c) => evaluateEligibility(opp, c, context).eligible);
    const ranked = rankMatches(opp, eligibleCapacities, context);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.capacityId).toBe("eligible-provider");
    expect(ranked.some((r) => r.capacityId === "ineligible-provider")).toBe(false);
  });
});
