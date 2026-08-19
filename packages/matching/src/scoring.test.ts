import { describe, expect, it } from "vitest";
import { MATCHING_CONFIG } from "./config.js";
import { RankingInputError } from "./errors.js";
import { scoreMatch } from "./scoring.js";
import { RANKING_FACTORS } from "./types.js";
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

function capacity(overrides: Partial<MatchCapacityInput> = {}): MatchCapacityInput {
  return {
    id: "cap-1",
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
  return { now: new Date("2026-08-18T12:00:00.000Z"), ...overrides };
}

describe("MATCHING_CONFIG.rankingWeights — the spec table", () => {
  it("sums to exactly 1 (22 + 17 + 13 + 13 + 10 + 10 + 7 + 5 + 3)", () => {
    const w = MATCHING_CONFIG.rankingWeights;
    const sum = Object.values(w).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("matches the spec's table verbatim", () => {
    expect(MATCHING_CONFIG.rankingWeights).toEqual({
      mccProductFit: 0.22,
      geographyLicensingFit: 0.17,
      volumeTicketFit: 0.13,
      riskHistoryFit: 0.13,
      settlementCurrencyFit: 0.1,
      commercialUtility: 0.1,
      technicalLaunchFit: 0.07,
      providerReliabilityFreshness: 0.05,
      outcomeCalibratedLikelihood: 0.03,
    });
  });

  it("MCC/product fit is the single largest weight (the spec's own ordering)", () => {
    const w = MATCHING_CONFIG.rankingWeights;
    expect(w.mccProductFit).toBeGreaterThan(w.geographyLicensingFit);
    expect(w.mccProductFit).toBeGreaterThanOrEqual(Math.max(...Object.values(w)));
  });

  it("outcome-calibrated likelihood is the single smallest weight (the spec: '3% initially... grows only with validated data')", () => {
    const w = MATCHING_CONFIG.rankingWeights;
    expect(w.outcomeCalibratedLikelihood).toBeLessThanOrEqual(Math.min(...Object.values(w)));
  });

  it("import itself does not throw — proves the module-load-time weights-sum-to-1 assertion passed for real (assertRankingWeightsSumToOne)", () => {
    expect(true).toBe(true);
  });
});

describe("scoreMatch — a fixture engineered to land every factor on a clean value (exact hand-computed total)", () => {
  it("computes total = 96.4 for an all-boundary-values fixture", () => {
    // mccProductFit: 2/2 MCCs matched, zero extras -> 100
    // geographyLicensingFit: 1/1 jurisdictions matched -> 100
    // volumeTicketFit: headroom ratio exactly 5.0x (the band's own max) -> 100
    // riskHistoryFit: merchant risk supplied at 0 against real ceilings -> 0% utilization -> 100
    // settlementCurrencyFit: settlementCadenceDays = 1 (the band's own min) -> 100
    // commercialUtility: mdrBps = 80 (the band's own min) -> 100
    // technicalLaunchFit: fixed neutral default -> 70
    // providerReliabilityFreshness: FRESH -> 100
    // outcomeCalibratedLikelihood: fixed placeholder -> 50
    // total = 100*.22 + 100*.17 + 100*.13 + 100*.13 + 100*.10 + 100*.10 + 70*.07 + 100*.05 + 50*.03
    //       = 22 + 17 + 13 + 13 + 10 + 10 + 4.9 + 5 + 1.5 = 96.4
    const opp = opportunity({ mccs: ["5411", "5812"], jurisdictions: ["US"], movable30dMinor: 1_000_000n });
    const cap = capacity({
      mccsAccepted: ["5411", "5812"],
      jurisdictions: ["US"],
      monthlyCapacityMinor: 5_000_000n,
      settlementCadenceDays: 1,
      commercialTerms: { mdrBps: 80, fixedFeeMinor: 0, model: "flat" },
      freshnessClass: "FRESH",
    });
    const context = ctx({ merchantRiskProfile: { chargebackBps: 0, fraudBps: 0, refundBps: 0 } });

    const breakdown = scoreMatch(opp, cap, context);
    const byFactor = Object.fromEntries(breakdown.factors.map((f) => [f.factor, f]));

    expect(byFactor.mccProductFit!.score).toBe(100);
    expect(byFactor.geographyLicensingFit!.score).toBe(100);
    expect(byFactor.volumeTicketFit!.score).toBe(100);
    expect(byFactor.riskHistoryFit!.score).toBe(100);
    expect(byFactor.settlementCurrencyFit!.score).toBe(100);
    expect(byFactor.commercialUtility!.score).toBe(100);
    expect(byFactor.technicalLaunchFit!.score).toBe(MATCHING_CONFIG.technicalLaunchFitNeutralDefault);
    expect(byFactor.providerReliabilityFreshness!.score).toBe(100);
    expect(byFactor.outcomeCalibratedLikelihood!.score).toBe(MATCHING_CONFIG.outcomeCalibratedLikelihoodPlaceholder);

    expect(breakdown.total).toBe(96.4);
  });

  it("total always equals the rounded sum of the returned per-factor contributions (internal consistency — a UI/auditor can reproduce it by hand)", () => {
    const breakdown = scoreMatch(opportunity(), capacity(), ctx({ merchantRiskProfile: { chargebackBps: 25 } }));
    const summed = Math.round(breakdown.factors.reduce((s, f) => s + f.contribution, 0) * 10) / 10;
    expect(breakdown.total).toBe(summed);
  });

  it("returns exactly the nine the spec factors, each with its configured weight", () => {
    const breakdown = scoreMatch(opportunity(), capacity(), ctx());
    expect(breakdown.factors.map((f) => f.factor)).toEqual(RANKING_FACTORS);
    for (const f of breakdown.factors) {
      expect(f.weight).toBe(MATCHING_CONFIG.rankingWeights[f.factor]);
    }
  });
});

describe("mccProductFit", () => {
  it("scores 0 when the opportunity has no MCCs", () => {
    const breakdown = scoreMatch(opportunity({ mccs: [] }), capacity(), ctx());
    expect(breakdown.factors.find((f) => f.factor === "mccProductFit")!.score).toBe(0);
  });

  it("applies a specificity penalty when the provider's accepted list carries MCCs beyond the opportunity's own", () => {
    const focused = scoreMatch(opportunity({ mccs: ["5411"] }), capacity({ mccsAccepted: ["5411"] }), ctx());
    const broad = scoreMatch(opportunity({ mccs: ["5411"] }), capacity({ mccsAccepted: ["5411", "5812", "5999", "7995"] }), ctx());
    expect(focused.factors.find((f) => f.factor === "mccProductFit")!.score).toBeGreaterThan(broad.factors.find((f) => f.factor === "mccProductFit")!.score);
  });

  it("the specificity penalty is capped, never driving the score to 0 for a still-fully-covering provider", () => {
    const manyExtras = capacity({ mccsAccepted: ["5411", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"] });
    const breakdown = scoreMatch(opportunity({ mccs: ["5411"] }), manyExtras, ctx());
    expect(breakdown.factors.find((f) => f.factor === "mccProductFit")!.score).toBeGreaterThan(0);
  });
});

describe("volumeTicketFit", () => {
  it("falls back to the neutral default on currency mismatch", () => {
    const breakdown = scoreMatch(opportunity({ currency: "USD" }), capacity({ currency: "EUR" }), ctx());
    expect(breakdown.factors.find((f) => f.factor === "volumeTicketFit")!.score).toBe(MATCHING_CONFIG.neutralFactorDefault);
  });

  it("falls back to the neutral default when the opportunity has zero near-term movable volume", () => {
    const breakdown = scoreMatch(opportunity({ movable30dMinor: 0n }), capacity(), ctx());
    expect(breakdown.factors.find((f) => f.factor === "volumeTicketFit")!.score).toBe(MATCHING_CONFIG.neutralFactorDefault);
  });

  it("scores 0 at exactly the 1.0x headroom floor (comfort band starts at the eligibility minimum)", () => {
    const breakdown = scoreMatch(opportunity({ movable30dMinor: 1_000_000n }), capacity({ monthlyCapacityMinor: 1_000_000n }), ctx());
    expect(breakdown.factors.find((f) => f.factor === "volumeTicketFit")!.score).toBe(0);
  });

  it("more headroom scores strictly higher, up to the band max", () => {
    const low = scoreMatch(opportunity({ movable30dMinor: 1_000_000n }), capacity({ monthlyCapacityMinor: 2_000_000n }), ctx());
    const high = scoreMatch(opportunity({ movable30dMinor: 1_000_000n }), capacity({ monthlyCapacityMinor: 4_000_000n }), ctx());
    expect(high.factors.find((f) => f.factor === "volumeTicketFit")!.score).toBeGreaterThan(low.factors.find((f) => f.factor === "volumeTicketFit")!.score);
  });
});

describe("riskHistoryFit", () => {
  it("falls back to the risk-specific neutral default with no merchant risk history", () => {
    const breakdown = scoreMatch(opportunity(), capacity(), ctx());
    expect(breakdown.factors.find((f) => f.factor === "riskHistoryFit")!.score).toBe(MATCHING_CONFIG.riskHistoryFitNeutralDefault);
  });

  it("scores 100 at zero utilization and lower as utilization climbs toward the ceiling", () => {
    const zero = scoreMatch(opportunity(), capacity({ maxChargebackBps: 200 }), ctx({ merchantRiskProfile: { chargebackBps: 0 } }));
    const half = scoreMatch(opportunity(), capacity({ maxChargebackBps: 200 }), ctx({ merchantRiskProfile: { chargebackBps: 100 } }));
    expect(zero.factors.find((f) => f.factor === "riskHistoryFit")!.score).toBe(100);
    expect(half.factors.find((f) => f.factor === "riskHistoryFit")!.score).toBe(50);
  });
});

describe("commercialUtility", () => {
  it("falls back to the generic neutral default when no commercialTerms are on file", () => {
    const breakdown = scoreMatch(opportunity(), capacity({ commercialTerms: null }), ctx());
    expect(breakdown.factors.find((f) => f.factor === "commercialUtility")!.score).toBe(MATCHING_CONFIG.neutralFactorDefault);
  });

  it("a lower MDR scores strictly higher than a higher MDR", () => {
    const cheap = scoreMatch(opportunity(), capacity({ commercialTerms: { mdrBps: 100, fixedFeeMinor: 0, model: "flat" } }), ctx());
    const expensive = scoreMatch(opportunity(), capacity({ commercialTerms: { mdrBps: 400, fixedFeeMinor: 0, model: "flat" } }), ctx());
    expect(cheap.factors.find((f) => f.factor === "commercialUtility")!.score).toBeGreaterThan(expensive.factors.find((f) => f.factor === "commercialUtility")!.score);
  });
});

describe("providerReliabilityFreshness (the spec: 'AGING — still usable but ranking penalty applies')", () => {
  it("strictly orders FRESH > AGING > STALE > UNKNOWN", () => {
    const scoreFor = (freshnessClass: MatchCapacityInput["freshnessClass"]) => scoreMatch(opportunity(), capacity({ freshnessClass }), ctx()).factors.find((f) => f.factor === "providerReliabilityFreshness")!.score;
    expect(scoreFor("FRESH")).toBeGreaterThan(scoreFor("AGING"));
    expect(scoreFor("AGING")).toBeGreaterThan(scoreFor("STALE"));
    expect(scoreFor("STALE")).toBeGreaterThan(scoreFor("UNKNOWN"));
  });

  it("rejects an out-of-enum freshnessClass", () => {
    expect(() => scoreMatch(opportunity(), capacity({ freshnessClass: "NOT_A_CLASS" as never }), ctx())).toThrow(RankingInputError);
  });
});

describe("outcomeCalibratedLikelihood (ADR-0004)", () => {
  it("is always the fixed configured placeholder, regardless of any other input", () => {
    const a = scoreMatch(opportunity(), capacity(), ctx());
    const b = scoreMatch(opportunity({ mccs: ["9999"] }), capacity({ freshnessClass: "STALE" }), ctx());
    expect(a.factors.find((f) => f.factor === "outcomeCalibratedLikelihood")!.score).toBe(MATCHING_CONFIG.outcomeCalibratedLikelihoodPlaceholder);
    expect(b.factors.find((f) => f.factor === "outcomeCalibratedLikelihood")!.score).toBe(MATCHING_CONFIG.outcomeCalibratedLikelihoodPlaceholder);
  });
});

describe("versioning (the spec: 'Every MatchResult stores... weight set and algorithm version')", () => {
  it("stamps the current algorithmVersion from config", () => {
    const breakdown = scoreMatch(opportunity(), capacity(), ctx());
    expect(breakdown.algorithmVersion).toBe(MATCHING_CONFIG.algorithmVersion);
  });

  it("echoes inputVersions verbatim, defaulting to empty", () => {
    expect(scoreMatch(opportunity(), capacity(), ctx()).inputVersions).toEqual([]);
    expect(scoreMatch(opportunity(), capacity(), ctx({ inputVersions: ["capacity:v4"] })).inputVersions).toEqual(["capacity:v4"]);
  });

  it("never returns a computedAt/rankedAt field — zero clock dependency, caller stamps a real timestamp when persisting", () => {
    const breakdown = scoreMatch(opportunity(), capacity(), ctx());
    expect(breakdown).not.toHaveProperty("computedAt");
    expect(breakdown).not.toHaveProperty("rankedAt");
  });
});

describe("determinism (same inputs -> identical output, run many times — the spec 'explainable... factors and versions')", () => {
  it("500 calls with an identical input all produce a deep-equal breakdown", () => {
    const opp = opportunity({ mccs: ["5411", "5812"], jurisdictions: ["US", "CA"] });
    const cap = capacity({ mccsAccepted: ["5411", "5812", "5999"], jurisdictions: ["US", "CA", "MX"] });
    const context = ctx({ merchantRiskProfile: { chargebackBps: 30, fraudBps: 15, refundBps: 80 }, inputVersions: ["opportunity:v1", "capacity:v2"] });
    const first = scoreMatch(opp, cap, context);
    for (let i = 0; i < 500; i++) {
      expect(scoreMatch(opp, cap, context)).toEqual(first);
    }
  });

  it("does not mutate its inputs", () => {
    const opp = opportunity();
    const cap = capacity();
    const stringify = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
    const oppBefore = stringify(opp);
    const capBefore = stringify(cap);
    scoreMatch(opp, cap, ctx());
    expect(stringify(opp)).toBe(oppBefore);
    expect(stringify(cap)).toBe(capBefore);
  });
});
