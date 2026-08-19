import { describe, expect, it } from "vitest";
import { EVIDENCE_CONFIG } from "./config.js";

describe("EVIDENCE_CONFIG", () => {
  it("has non-empty algorithmVersion and ruleVersion strings, independently versioned", () => {
    expect(EVIDENCE_CONFIG.algorithmVersion.length).toBeGreaterThan(0);
    expect(EVIDENCE_CONFIG.ruleVersion.length).toBeGreaterThan(0);
    expect(EVIDENCE_CONFIG.algorithmVersion).not.toBe(EVIDENCE_CONFIG.ruleVersion);
  });

  it("requiredFacts has at least one blocking and one non-blocking entry, every entry well-formed", () => {
    expect(EVIDENCE_CONFIG.requiredFacts.length).toBeGreaterThan(0);
    expect(EVIDENCE_CONFIG.requiredFacts.some((f) => f.blocking)).toBe(true);
    expect(EVIDENCE_CONFIG.requiredFacts.some((f) => !f.blocking)).toBe(true);
    for (const f of EVIDENCE_CONFIG.requiredFacts) {
      expect(f.fieldKey.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it("requiredFacts has no duplicate fieldKeys — each is judged exactly once", () => {
    const keys = EVIDENCE_CONFIG.requiredFacts.map((f) => f.fieldKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("requiredFacts spans more than one PassportSectionType — readiness is not a single-section gate", () => {
    const sections = new Set(EVIDENCE_CONFIG.requiredFacts.map((f) => f.sectionType));
    expect(sections.size).toBeGreaterThan(1);
  });

  it("capacityFreshnessWindowDays.fresh < .aging — a real, non-degenerate ladder", () => {
    expect(EVIDENCE_CONFIG.capacityFreshnessWindowDays.fresh).toBeLessThan(EVIDENCE_CONFIG.capacityFreshnessWindowDays.aging);
    expect(EVIDENCE_CONFIG.capacityFreshnessWindowDays.fresh).toBeGreaterThan(0);
  });

  it("factFreshnessWarnWithinDays is a positive number", () => {
    expect(EVIDENCE_CONFIG.factFreshnessWarnWithinDays).toBeGreaterThan(0);
  });
});
