import { describe, expect, it } from "vitest";
import { EVIDENCE_CONFIG } from "./config.js";
import { computeReadiness, isReadinessBlocked } from "./readiness.js";
import type { FactSnapshot, RequiredFact } from "./types.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY_MS);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

const REQUIRED: readonly RequiredFact[] = [
  { fieldKey: "a", sectionType: "IDENTITY", blocking: true, label: "Fact A (blocking)" },
  { fieldKey: "b", sectionType: "RISK", blocking: true, label: "Fact B (blocking)" },
  { fieldKey: "c", sectionType: "COMMERCIAL", blocking: false, label: "Fact C (non-blocking)" },
];

const fact = (overrides: Partial<FactSnapshot> & { fieldKey: string }): FactSnapshot => ({
  sectionType: "IDENTITY",
  hasValue: true,
  verification: "OPERATOR_VERIFIED",
  expiresAt: null,
  updatedAt: NOW,
  ...overrides,
});

describe("computeReadiness", () => {
  it("is 100% with zero blockers/warnings when every required fact is present, fresh, and independently verified", () => {
    const facts = [fact({ fieldKey: "a" }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })];
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.score).toBe(100);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(isReadinessBlocked(result)).toBe(false);
  });

  it("blocks readiness when a BLOCKING required fact is entirely missing, and names exactly which one (p.29 acceptance example)", () => {
    const facts = [fact({ fieldKey: "b" }), fact({ fieldKey: "c" })]; // "a" missing
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers).toEqual([{ fieldKey: "a", sectionType: "IDENTITY", message: expect.stringContaining("Fact A") }]);
    expect(isReadinessBlocked(result)).toBe(true);
  });

  it("does NOT block readiness when only a NON-blocking required fact is missing — it becomes a warning instead", () => {
    const facts = [fact({ fieldKey: "a" }), fact({ fieldKey: "b" })]; // "c" (non-blocking) missing
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([{ fieldKey: "c", sectionType: "COMMERCIAL", message: expect.stringContaining("Fact C") }]);
    expect(isReadinessBlocked(result)).toBe(false);
  });

  it("a present-but-hasValue:false Fact row counts the same as a missing one — presence alone isn't enough", () => {
    const facts = [fact({ fieldKey: "a", hasValue: false }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })];
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers.map((b) => b.fieldKey)).toEqual(["a"]);
  });

  it("a STALE blocking fact becomes a BLOCKER (expired evidence no longer satisfies the requirement)", () => {
    const facts = [fact({ fieldKey: "a", expiresAt: daysAgo(10) }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })];
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers).toEqual([{ fieldKey: "a", sectionType: "IDENTITY", message: expect.stringContaining("expired") }]);
  });

  it("a STALE non-blocking fact becomes a WARNING, not a blocker", () => {
    const facts = [fact({ fieldKey: "a" }), fact({ fieldKey: "b" }), fact({ fieldKey: "c", expiresAt: daysAgo(5) })];
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((w) => w.fieldKey === "c" && w.message.includes("expired"))).toBe(true);
  });

  it("an AGING fact (blocking or not) generates a warning but never a blocker", () => {
    const facts = [fact({ fieldKey: "a", expiresAt: daysFromNow(5) }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })];
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((w) => w.fieldKey === "a" && w.message.includes("approaching expiry"))).toBe(true);
  });

  it("a SELF_REPORTED-only fact generates a provenance warning even though it's present and fresh", () => {
    const facts = [fact({ fieldKey: "a", verification: "SELF_REPORTED" }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })];
    const result = computeReadiness(facts, NOW, [], REQUIRED);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((w) => w.fieldKey === "a" && w.message.includes("self-reported"))).toBe(true);
  });

  it("score reflects the fraction of ALL required facts present (blocking + non-blocking), independent of blockers", () => {
    // Only "a" present out of 3 required (1/3).
    const result = computeReadiness([fact({ fieldKey: "a" })], NOW, [], REQUIRED);
    expect(result.score).toBeCloseTo((1 / 3) * 100, 5);
  });

  it("throws TypeError on a duplicate fieldKey in facts — structurally unreachable via the real DB (Fact has @@unique([passportId, fieldKey])), but this pure function fails loud rather than silently letting the last entry win", () => {
    const facts = [fact({ fieldKey: "a", verification: "SELF_REPORTED" }), fact({ fieldKey: "a", verification: "OPERATOR_VERIFIED" })];
    expect(() => computeReadiness(facts, NOW, [], REQUIRED)).toThrow(TypeError);
  });

  it("score is 100 for a zero-required-facts config — nothing to be incomplete about", () => {
    const result = computeReadiness([], NOW, [], []);
    expect(result.score).toBe(100);
    expect(result.blockers).toEqual([]);
    expect(isReadinessBlocked(result)).toBe(false);
  });

  it("echoes inputVersions verbatim and stamps ruleVersion/algorithmVersion from EVIDENCE_CONFIG", () => {
    const result = computeReadiness([fact({ fieldKey: "a" }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })], NOW, ["fact:a:v3", "fact:b:v1"], REQUIRED);
    expect(result.inputVersions).toEqual(["fact:a:v3", "fact:b:v1"]);
    expect(result.ruleVersion).toBe(EVIDENCE_CONFIG.ruleVersion);
    expect(result.algorithmVersion).toBe(EVIDENCE_CONFIG.algorithmVersion);
  });

  it("works against the REAL production EVIDENCE_CONFIG.requiredFacts (not just the small test fixture above) — the exact list apps/api's passport service will use", () => {
    const facts = EVIDENCE_CONFIG.requiredFacts.filter((r) => r.blocking).map((r) => fact({ fieldKey: r.fieldKey, sectionType: r.sectionType }));
    const result = computeReadiness(facts, NOW, [], EVIDENCE_CONFIG.requiredFacts);
    expect(result.blockers).toEqual([]); // every blocking fact present
    expect(result.warnings.length).toBeGreaterThan(0); // the 2 non-blocking facts are still missing
    expect(isReadinessBlocked(result)).toBe(false);
  });

  it("matches an earlier seed fixture shape (Meridian: 5 of 6 blocking facts present, missing technicalIntegrationProfile) — still blocked", () => {
    const blockingKeys = EVIDENCE_CONFIG.requiredFacts.filter((r) => r.blocking).map((r) => r.fieldKey);
    const presentKeys = blockingKeys.filter((k) => k !== "technicalIntegrationProfile");
    const facts = presentKeys.map((k) => fact({ fieldKey: k, sectionType: EVIDENCE_CONFIG.requiredFacts.find((r) => r.fieldKey === k)!.sectionType }));
    const result = computeReadiness(facts, NOW, [], EVIDENCE_CONFIG.requiredFacts);
    expect(result.blockers.map((b) => b.fieldKey)).toEqual(["technicalIntegrationProfile"]);
    expect(isReadinessBlocked(result)).toBe(true);
  });

  it("is deterministic — repeated calls on identical inputs (facts array, reference time) produce byte-identical results, 200 calls", () => {
    const facts = [fact({ fieldKey: "a", verification: "SELF_REPORTED" }), fact({ fieldKey: "b", expiresAt: daysFromNow(5) })];
    const results = Array.from({ length: 200 }, () => computeReadiness(facts, NOW, ["v1"], REQUIRED));
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
  });

  it("two independent computeReadiness calls built from freshly-reconstructed (not shared-reference) input objects still produce byte-identical results — proves determinism doesn't rely on object identity", () => {
    const buildFacts = () => [fact({ fieldKey: "a" }), fact({ fieldKey: "b" }), fact({ fieldKey: "c" })];
    const resultOne = computeReadiness(buildFacts(), new Date(NOW.getTime()), [], REQUIRED);
    const resultTwo = computeReadiness(buildFacts(), new Date(NOW.getTime()), [], REQUIRED);
    expect(resultOne).toEqual(resultTwo);
  });
});
