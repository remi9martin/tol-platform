import { describe, expect, it } from "vitest";
import { ATTRIBUTION_CONFIG } from "./config.js";
import { attributionTier } from "./tier.js";

describe("attributionTier", () => {
  it("is 'negligible' below the moderate threshold", () => {
    expect(attributionTier(0)).toBe("negligible");
    expect(attributionTier(ATTRIBUTION_CONFIG.tierThresholds.moderate - 0.1)).toBe("negligible");
  });

  it("is 'moderate' at and above the moderate threshold, below strong", () => {
    expect(attributionTier(ATTRIBUTION_CONFIG.tierThresholds.moderate)).toBe("moderate");
    expect(attributionTier(ATTRIBUTION_CONFIG.tierThresholds.strong - 0.1)).toBe("moderate");
  });

  it("is 'strong' at and above the strong threshold, up to 100", () => {
    expect(attributionTier(ATTRIBUTION_CONFIG.tierThresholds.strong)).toBe("strong");
    expect(attributionTier(100)).toBe("strong");
  });

  it("is independent of a claim's workflow status by design — this function only ever sees a number, never a Claim row (see this file's header comment)", () => {
    // Documented as a type-level guarantee: attributionTier's signature is (total: number) => AttributionTier.
    expect(attributionTier.length).toBe(1);
  });
});
