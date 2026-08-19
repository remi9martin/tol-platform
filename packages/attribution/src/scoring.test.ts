import { describe, expect, it } from "vitest";
import { ATTRIBUTION_CONFIG } from "./config.js";
import { ClaimScoringInputError, normalize, normalizeInvert, scoreClaim, scoreEvidence } from "./scoring.js";
import { CLAIM_EVIDENCE_TYPES, DIRECTNESS_TIERS, EVIDENCE_VERIFICATION_STATES } from "./types.js";
import type { ClaimScoringInput } from "./types.js";

const baseInput: ClaimScoringInput = {
  priorCommercialHistoryMonths: 0,
  directnessTier: "D3",
  evidenceItems: [],
  submissionLagDays: 0,
};

describe("ATTRIBUTION_CONFIG", () => {
  it("weights sum to exactly 1 (the spec: 40% + 30% + 20% + 10%)", () => {
    const { history, proximity, evidence, time } = ATTRIBUTION_CONFIG.weights;
    expect(history + proximity + evidence + time).toBeCloseTo(1, 10);
  });

  it("matches the spec's table verbatim", () => {
    expect(ATTRIBUTION_CONFIG.weights).toEqual({ history: 0.4, proximity: 0.3, evidence: 0.2, time: 0.1 });
  });

  it("TIME is the lightest weight of the four (the spec: being early can never be the dominant factor)", () => {
    const { history, proximity, evidence, time } = ATTRIBUTION_CONFIG.weights;
    expect(time).toBeLessThan(evidence);
    expect(time).toBeLessThan(proximity);
    expect(time).toBeLessThan(history);
  });

  it("D0 is the only zero-attribution tier", () => {
    expect(ATTRIBUTION_CONFIG.zeroAttributionTiers).toEqual(["D0"]);
  });

  it("proximityScoreByTier.D0 is 0 (belt-and-suspenders alongside the hard zeroAttributionTiers rule)", () => {
    expect(ATTRIBUTION_CONFIG.proximityScoreByTier.D0).toBe(0);
  });

  it("import itself does not throw — proves the module-load-time weights-sum-to-1 assertion (scoring.ts's assertWeightsSumToOne) passed for real, not just in a mock", () => {
    // If ATTRIBUTION_CONFIG.weights ever drifted off summing to 1, importing
    // ./scoring.js (which every test in this file already did, at module
    // load, before this test body even runs) would have thrown synchronously
    // and this entire file would report zero passing tests, not a single
    // failing assertion here — this test exists as an explicit, readable
    // marker of that guarantee for anyone reading test output.
    expect(true).toBe(true);
  });

  it("config completeness: every DirectnessTier has a proximityScoreByTier entry (review: guards against a future tier being added to one list but not the other)", () => {
    for (const tier of DIRECTNESS_TIERS) {
      expect(ATTRIBUTION_CONFIG.proximityScoreByTier).toHaveProperty(tier);
      expect(typeof ATTRIBUTION_CONFIG.proximityScoreByTier[tier]).toBe("number");
    }
  });

  it("config completeness: every ClaimEvidenceType has an evidenceBasePoints entry", () => {
    for (const type of CLAIM_EVIDENCE_TYPES) {
      expect(ATTRIBUTION_CONFIG.evidenceBasePoints).toHaveProperty(type);
      expect(typeof ATTRIBUTION_CONFIG.evidenceBasePoints[type]).toBe("number");
    }
  });

  it("config completeness: every EvidenceVerificationState has an evidenceVerificationMultiplier entry", () => {
    for (const state of EVIDENCE_VERIFICATION_STATES) {
      expect(ATTRIBUTION_CONFIG.evidenceVerificationMultiplier).toHaveProperty(state);
      expect(typeof ATTRIBUTION_CONFIG.evidenceVerificationMultiplier[state]).toBe("number");
    }
  });
});

describe("normalize / normalizeInvert — degenerate-band guard (review)", () => {
  it("normalize throws ClaimScoringInputError when min === max, instead of silently producing NaN/Infinity", () => {
    expect(() => normalize(5, 10, 10)).toThrow(ClaimScoringInputError);
    expect(() => normalize(5, 10, 10)).toThrow(/degenerate/);
  });

  it("normalizeInvert throws the same way", () => {
    expect(() => normalizeInvert(5, 10, 10)).toThrow(ClaimScoringInputError);
  });

  it("normalize behaves correctly for every non-degenerate band (sanity check the guard didn't break the happy path)", () => {
    expect(normalize(0, 0, 36)).toBe(0);
    expect(normalize(36, 0, 36)).toBe(100);
  });
});

describe("scoreEvidence — EVIDENCE factor (20% weight)", () => {
  it("scores 0 for an empty evidence list", () => {
    const result = scoreEvidence([]);
    expect(result.total).toBe(0);
    expect(result.rawTotal).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("a single SELF_REPORTED CRM_RECORD scores basePoints * multiplier exactly", () => {
    const result = scoreEvidence([{ evidenceType: "CRM_RECORD", verificationState: "SELF_REPORTED" }]);
    // CRM_RECORD base 15 * SELF_REPORTED 0.4 = 6
    expect(result.items[0]).toMatchObject({ basePoints: 15, multiplier: 0.4, contribution: 6 });
    expect(result.total).toBe(6);
  });

  it("an OPERATOR_VERIFIED CONTRACT scores the maximum single-item contribution (40 * 1.0 = 40)", () => {
    const result = scoreEvidence([{ evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }]);
    expect(result.items[0]!.contribution).toBe(40);
    expect(result.total).toBe(40);
  });

  it("sums multiple items", () => {
    const result = scoreEvidence([
      { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }, // 40
      { evidenceType: "EMAIL_THREAD", verificationState: "DOCUMENT_EXTRACTED" }, // 20 * 0.7 = 14
    ]);
    expect(result.rawTotal).toBe(54);
    expect(result.total).toBe(54);
  });

  it("caps the total at 100 even when many strong items would sum higher, and preserves rawTotal for transparency", () => {
    const result = scoreEvidence([
      { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }, // 40
      { evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", verificationState: "COUNTERPARTY_CONFIRMED" }, // 35
      { evidenceType: "EMAIL_THREAD", verificationState: "OPERATOR_VERIFIED" }, // 20
      { evidenceType: "CRM_RECORD", verificationState: "OPERATOR_VERIFIED" }, // 15
      { evidenceType: "OTHER", verificationState: "OPERATOR_VERIFIED" }, // 5
    ]);
    expect(result.rawTotal).toBe(115);
    expect(result.total).toBe(100);
  });

  it("preserves item order and index in the breakdown", () => {
    const result = scoreEvidence([
      { evidenceType: "OTHER", verificationState: "SELF_REPORTED" },
      { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" },
    ]);
    expect(result.items[0]!.index).toBe(0);
    expect(result.items[0]!.evidenceType).toBe("OTHER");
    expect(result.items[1]!.index).toBe(1);
    expect(result.items[1]!.evidenceType).toBe("CONTRACT");
  });

  it("rejects an unrecognized evidenceType with the offending index in the message", () => {
    expect(() =>
      scoreEvidence([{ evidenceType: "NOT_A_TYPE" as never, verificationState: "SELF_REPORTED" }]),
    ).toThrow(ClaimScoringInputError);
    expect(() =>
      scoreEvidence([{ evidenceType: "NOT_A_TYPE" as never, verificationState: "SELF_REPORTED" }]),
    ).toThrow(/evidenceItems\[0\]\.evidenceType/);
  });

  it("rejects an unrecognized verificationState", () => {
    expect(() =>
      scoreEvidence([{ evidenceType: "CONTRACT", verificationState: "NOT_A_STATE" as never }]),
    ).toThrow(ClaimScoringInputError);
  });
});

describe("scoreClaim — HISTORY factor (40% weight)", () => {
  it("0 months of history normalizes to 0", () => {
    const b = scoreClaim({ ...baseInput, priorCommercialHistoryMonths: 0, directnessTier: "D5" });
    expect(b.history).toBe(0);
  });

  it("36 months (the configured band max) normalizes to 100", () => {
    const b = scoreClaim({ ...baseInput, priorCommercialHistoryMonths: 36, directnessTier: "D5" });
    expect(b.history).toBe(100);
  });

  it("18 months (half the band) normalizes to 50", () => {
    const b = scoreClaim({ ...baseInput, priorCommercialHistoryMonths: 18, directnessTier: "D5" });
    expect(b.history).toBe(50);
  });

  it("clamps values beyond the band max at 100 rather than extrapolating", () => {
    const b = scoreClaim({ ...baseInput, priorCommercialHistoryMonths: 999, directnessTier: "D5" });
    expect(b.history).toBe(100);
  });

  it("rejects negative history months", () => {
    expect(() => scoreClaim({ ...baseInput, priorCommercialHistoryMonths: -1 })).toThrow(ClaimScoringInputError);
  });
});

describe("scoreClaim — PROXIMITY factor (30% weight)", () => {
  it("maps each directness tier to its configured score", () => {
    expect(scoreClaim({ ...baseInput, directnessTier: "D5" }).proximity).toBe(100);
    expect(scoreClaim({ ...baseInput, directnessTier: "D4" }).proximity).toBe(80);
    expect(scoreClaim({ ...baseInput, directnessTier: "D3" }).proximity).toBe(60);
    expect(scoreClaim({ ...baseInput, directnessTier: "D2" }).proximity).toBe(35);
    expect(scoreClaim({ ...baseInput, directnessTier: "D1" }).proximity).toBe(15);
    expect(scoreClaim({ ...baseInput, directnessTier: "D0" }).proximity).toBe(0);
  });

  it("rejects an unrecognized directness tier", () => {
    expect(() => scoreClaim({ ...baseInput, directnessTier: "D9" as never })).toThrow(ClaimScoringInputError);
  });

  it("proximity strictly increases as directness gets closer (D0 < D1 < D2 < D3 < D4 < D5)", () => {
    const tiers = ["D0", "D1", "D2", "D3", "D4", "D5"] as const;
    const scores = tiers.map((t) => scoreClaim({ ...baseInput, directnessTier: t }).proximity);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });
});

describe("scoreClaim — TIME factor (10% weight)", () => {
  it("0 days of lag normalizes to 100 (fastest qualifying submission)", () => {
    const b = scoreClaim({ ...baseInput, directnessTier: "D5", submissionLagDays: 0 });
    expect(b.time).toBe(100);
  });

  it("60 days (the configured band max) normalizes to 0", () => {
    const b = scoreClaim({ ...baseInput, directnessTier: "D5", submissionLagDays: 60 });
    expect(b.time).toBe(0);
  });

  it("30 days (half the band) normalizes to 50", () => {
    const b = scoreClaim({ ...baseInput, directnessTier: "D5", submissionLagDays: 30 });
    expect(b.time).toBe(50);
  });

  it("clamps values beyond the band max at 0 rather than going negative", () => {
    const b = scoreClaim({ ...baseInput, directnessTier: "D5", submissionLagDays: 9999 });
    expect(b.time).toBe(0);
  });

  it("rejects negative submission lag", () => {
    expect(() => scoreClaim({ ...baseInput, submissionLagDays: -1 })).toThrow(ClaimScoringInputError);
  });
});

describe("scoreClaim — weighted total (hand-computed)", () => {
  it("computes the exact weighted total for a known, hand-calculated input", () => {
    // history: 18/36 -> 50; proximity: D4 -> 80; evidence: one OPERATOR_VERIFIED CONTRACT -> 40; time: 30/60 -> 50 (inverted)
    // weighted = 50*0.4 + 80*0.3 + 40*0.2 + 50*0.1 = 20 + 24 + 8 + 5 = 57
    const b = scoreClaim({
      priorCommercialHistoryMonths: 18,
      directnessTier: "D4",
      evidenceItems: [{ evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }],
      submissionLagDays: 30,
    });
    expect(b.history).toBe(50);
    expect(b.proximity).toBe(80);
    expect(b.evidence).toBe(40);
    expect(b.time).toBe(50);
    expect(b.weighted).toBe(57);
    expect(b.total).toBe(57);
    expect(b.cappedFrom).toBeUndefined();
  });

  it("a maxed-out claim (D5, full history, evidence at its own 100 ceiling, zero lag) scores exactly 100", () => {
    // Evidence needs enough items to actually HIT its own 100 ceiling (a single
    // CONTRACT+OPERATOR_VERIFIED item only contributes 40, not 100 — see the
    // "sums multiple items" / "caps the total at 100" scoreEvidence suite above).
    const b = scoreClaim({
      priorCommercialHistoryMonths: 36,
      directnessTier: "D5",
      evidenceItems: [
        { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }, // 40
        { evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", verificationState: "COUNTERPARTY_CONFIRMED" }, // 35
        { evidenceType: "EMAIL_THREAD", verificationState: "OPERATOR_VERIFIED" }, // 20
        { evidenceType: "CRM_RECORD", verificationState: "OPERATOR_VERIFIED" }, // 15 -- sums to 110, capped at 100
      ],
      submissionLagDays: 0,
    });
    expect(b.evidence).toBe(100);
    expect(b.total).toBe(100);
  });

  it("populates evidenceRawTotal when the EVIDENCE factor's own 100-point ceiling actually binds (review: per-factor ceiling transparency, mirroring cappedFrom for the top-level D0 rule)", () => {
    const b = scoreClaim({
      priorCommercialHistoryMonths: 0,
      directnessTier: "D3",
      evidenceItems: [
        { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }, // 40
        { evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", verificationState: "COUNTERPARTY_CONFIRMED" }, // 35
        { evidenceType: "EMAIL_THREAD", verificationState: "OPERATOR_VERIFIED" }, // 20
        { evidenceType: "CRM_RECORD", verificationState: "OPERATOR_VERIFIED" }, // 15 -- sums to 110
      ],
      submissionLagDays: 0,
    });
    expect(b.evidence).toBe(100);
    expect(b.evidenceRawTotal).toBe(110);
  });

  it("does NOT populate evidenceRawTotal when the evidence ceiling never bound", () => {
    const b = scoreClaim({ ...baseInput, evidenceItems: [{ evidenceType: "CRM_RECORD", verificationState: "SELF_REPORTED" }] });
    expect(b.evidenceRawTotal).toBeUndefined();
  });

  it("a single-strong-item claim (D5, full history, ONE contract, zero lag) scores 88 -- evidence's own factor is 40, not 100, from just one item", () => {
    const b = scoreClaim({
      priorCommercialHistoryMonths: 36,
      directnessTier: "D5",
      evidenceItems: [{ evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" }],
      submissionLagDays: 0,
    });
    // weighted = 100*0.4 (history) + 100*0.3 (proximity) + 40*0.2 (evidence) + 100*0.1 (time) = 40+30+8+10 = 88
    expect(b.total).toBe(88);
  });
});

describe("scoreClaim — anti-squatting D0 hard-zero rule (the spec + p.18 anti-gaming test)", () => {
  it("a D0 claim scores total 0 even with a fully maxed-out history/evidence/time", () => {
    const b = scoreClaim({
      priorCommercialHistoryMonths: 36,
      directnessTier: "D0",
      evidenceItems: [
        { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" },
        { evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", verificationState: "COUNTERPARTY_CONFIRMED" },
      ],
      submissionLagDays: 0,
    });
    expect(b.total).toBe(0);
    // The ceiling actually bound (pre-rule weighted total was > 0) — cappedFrom must be populated and reflect it.
    expect(b.cappedFrom).toBeGreaterThan(0);
  });

  it('the spec verbatim anti-gaming test: "Twenty public provider names submitted with no relationship evidence yield zero verified equity/attribution credit"', () => {
    // Simulates all twenty: D0 directness, zero history, zero evidence, submitted immediately.
    for (let i = 0; i < 20; i++) {
      const b = scoreClaim({
        priorCommercialHistoryMonths: 0,
        directnessTier: "D0",
        evidenceItems: [],
        submissionLagDays: 0,
      });
      expect(b.total).toBe(0);
    }
  });

  it("does NOT populate cappedFrom when the pre-rule weighted total was already 0 (nothing was actually capped)", () => {
    const b = scoreClaim({ priorCommercialHistoryMonths: 0, directnessTier: "D0", evidenceItems: [], submissionLagDays: 60 });
    expect(b.total).toBe(0);
    expect(b.cappedFrom).toBeUndefined();
  });

  it('anti-gaming test: "a later direct executive relationship can defeat an earlier generic-mailbox claim" — a D5 claim outscores a D1 claim with identical history/evidence/time', () => {
    const shared = { priorCommercialHistoryMonths: 6, evidenceItems: [], submissionLagDays: 10 };
    const genericMailbox = scoreClaim({ ...shared, directnessTier: "D1" });
    const directExecutive = scoreClaim({ ...shared, directnessTier: "D5" });
    expect(directExecutive.total).toBeGreaterThan(genericMailbox.total);
  });
});

describe("scoreClaim — versioning (the spec: inputVersion(s), algorithmVersion)", () => {
  it("stamps the current algorithmVersion from config", () => {
    const b = scoreClaim(baseInput);
    expect(b.algorithmVersion).toBe(ATTRIBUTION_CONFIG.algorithmVersion);
  });

  it("echoes back inputVersions verbatim when provided", () => {
    const b = scoreClaim({ ...baseInput, inputVersions: ["relationship:v3", "opportunity:v1"] });
    expect(b.inputVersions).toEqual(["relationship:v3", "opportunity:v1"]);
  });

  it("defaults inputVersions to an empty array when omitted", () => {
    const b = scoreClaim(baseInput);
    expect(b.inputVersions).toEqual([]);
  });

  it("never returns a computedAt field — the pure engine has zero clock dependency (see this file's header comment); the caller stamps a real timestamp when persisting", () => {
    const b = scoreClaim(baseInput);
    expect(b).not.toHaveProperty("computedAt");
  });
});

describe("scoreClaim — determinism (same inputs -> same output, proven empirically)", () => {
  it("500 calls with an identical input all produce a deep-equal breakdown", () => {
    const input: ClaimScoringInput = {
      priorCommercialHistoryMonths: 11,
      directnessTier: "D3",
      evidenceItems: [
        { evidenceType: "CONTRACT", verificationState: "OPERATOR_VERIFIED" },
        { evidenceType: "EMAIL_THREAD", verificationState: "SELF_REPORTED" },
      ],
      submissionLagDays: 7,
      inputVersions: ["relationship:v2"],
    };
    const first = scoreClaim(input);
    for (let i = 0; i < 500; i++) {
      expect(scoreClaim(input)).toEqual(first);
    }
  });

  it("determinism holds across every directness tier, including the D0 hard-zero path", () => {
    const tiers = ["D0", "D1", "D2", "D3", "D4", "D5"] as const;
    for (const tier of tiers) {
      const input: ClaimScoringInput = { ...baseInput, directnessTier: tier, priorCommercialHistoryMonths: 4, submissionLagDays: 3 };
      const first = scoreClaim(input);
      for (let i = 0; i < 25; i++) {
        expect(scoreClaim(input)).toEqual(first);
      }
    }
  });

  it("does not mutate its input (the returned evidenceBreakdown is independent of the caller's evidenceItems array)", () => {
    const items = [{ evidenceType: "CONTRACT" as const, verificationState: "OPERATOR_VERIFIED" as const }];
    const input: ClaimScoringInput = { ...baseInput, evidenceItems: items };
    const frozenItemsCopy = JSON.parse(JSON.stringify(items));
    scoreClaim(input);
    expect(items).toEqual(frozenItemsCopy);
  });
});

describe("scoreClaim — input validation", () => {
  it("rejects a non-finite history value", () => {
    expect(() => scoreClaim({ ...baseInput, priorCommercialHistoryMonths: Number.NaN })).toThrow(ClaimScoringInputError);
    expect(() => scoreClaim({ ...baseInput, priorCommercialHistoryMonths: Number.POSITIVE_INFINITY })).toThrow(ClaimScoringInputError);
  });

  it("rejects a non-finite submission lag value", () => {
    expect(() => scoreClaim({ ...baseInput, submissionLagDays: Number.NaN })).toThrow(ClaimScoringInputError);
  });

  it("error messages name the offending field", () => {
    expect(() => scoreClaim({ ...baseInput, priorCommercialHistoryMonths: -5 })).toThrow(/priorCommercialHistoryMonths/);
    expect(() => scoreClaim({ ...baseInput, submissionLagDays: -5 })).toThrow(/submissionLagDays/);
  });
});
