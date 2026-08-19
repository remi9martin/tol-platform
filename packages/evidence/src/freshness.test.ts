import { describe, expect, it } from "vitest";
import { EVIDENCE_CONFIG } from "./config.js";
import { classifyCapacityFreshness, classifyFactFreshness } from "./freshness.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

describe("classifyCapacityFreshness", () => {
  const { fresh, aging } = EVIDENCE_CONFIG.capacityFreshnessWindowDays;

  it("returns UNKNOWN when sourceType is not PLATFORM, regardless of asOf age — the spec 'discovery lead only'", () => {
    for (const sourceType of ["IMPORT", "CONNECTOR", "MIGRATION", "SYSTEM"]) {
      expect(classifyCapacityFreshness({ asOf: NOW, sourceType }, NOW)).toBe("UNKNOWN");
      expect(classifyCapacityFreshness({ asOf: daysAgo(9999), sourceType }, NOW)).toBe("UNKNOWN");
    }
  });

  it("is FRESH at zero age (asOf === now) for a PLATFORM-sourced profile", () => {
    expect(classifyCapacityFreshness({ asOf: NOW, sourceType: "PLATFORM" }, NOW)).toBe("FRESH");
  });

  it("FRESH/AGING boundary — exactly at the fresh window is still FRESH, one millisecond past is AGING", () => {
    const exactlyAtFresh = new Date(NOW.getTime() - fresh * DAY_MS);
    const oneMsPastFresh = new Date(NOW.getTime() - fresh * DAY_MS - 1);
    expect(classifyCapacityFreshness({ asOf: exactlyAtFresh, sourceType: "PLATFORM" }, NOW)).toBe("FRESH");
    expect(classifyCapacityFreshness({ asOf: oneMsPastFresh, sourceType: "PLATFORM" }, NOW)).toBe("AGING");
  });

  it("AGING/STALE boundary — exactly at the aging window is still AGING, one millisecond past is STALE", () => {
    const exactlyAtAging = new Date(NOW.getTime() - aging * DAY_MS);
    const oneMsPastAging = new Date(NOW.getTime() - aging * DAY_MS - 1);
    expect(classifyCapacityFreshness({ asOf: exactlyAtAging, sourceType: "PLATFORM" }, NOW)).toBe("AGING");
    expect(classifyCapacityFreshness({ asOf: oneMsPastAging, sourceType: "PLATFORM" }, NOW)).toBe("STALE");
  });

  it("is STALE far past the aging window", () => {
    expect(classifyCapacityFreshness({ asOf: daysAgo(aging + 365), sourceType: "PLATFORM" }, NOW)).toBe("STALE");
  });

  it("treats a future asOf (clock skew) as FRESH rather than throwing", () => {
    expect(classifyCapacityFreshness({ asOf: daysFromNow(5), sourceType: "PLATFORM" }, NOW)).toBe("FRESH");
  });

  it("accepts custom windows, overriding EVIDENCE_CONFIG's defaults", () => {
    expect(classifyCapacityFreshness({ asOf: daysAgo(5), sourceType: "PLATFORM" }, NOW, { fresh: 1, aging: 10 })).toBe("AGING");
  });

  it("is deterministic — same inputs, same reference time, byte-identical output across 100 repeated calls", () => {
    const input = { asOf: daysAgo(45), sourceType: "PLATFORM" };
    const results = Array.from({ length: 100 }, () => classifyCapacityFreshness(input, NOW));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("AGING");
  });
});

describe("classifyFactFreshness", () => {
  const { factFreshnessWarnWithinDays: warnWithin } = EVIDENCE_CONFIG;

  it("returns UNKNOWN when expiresAt is null — no expiry information at all", () => {
    expect(classifyFactFreshness({ expiresAt: null }, NOW)).toBe("UNKNOWN");
  });

  it("is FRESH when expiry is well in the future, beyond the warn window", () => {
    expect(classifyFactFreshness({ expiresAt: daysFromNow(warnWithin + 30) }, NOW)).toBe("FRESH");
  });

  it("FRESH/AGING boundary — exactly at warnWithinDays before expiry is AGING, one day further out is FRESH", () => {
    const exactlyAtWarn = daysFromNow(warnWithin);
    const oneDayFurtherOut = daysFromNow(warnWithin + 1);
    expect(classifyFactFreshness({ expiresAt: exactlyAtWarn }, NOW)).toBe("AGING");
    expect(classifyFactFreshness({ expiresAt: oneDayFurtherOut }, NOW)).toBe("FRESH");
  });

  it("AGING/STALE boundary — the instant of expiry is still AGING (0 days until expiry, non-negative), one millisecond past is STALE", () => {
    const theInstantOfExpiry = NOW;
    const oneMsPastExpiry = new Date(NOW.getTime() - 1);
    expect(classifyFactFreshness({ expiresAt: theInstantOfExpiry }, NOW)).toBe("AGING");
    expect(classifyFactFreshness({ expiresAt: oneMsPastExpiry }, NOW)).toBe("STALE");
  });

  it("is STALE for a long-expired fact", () => {
    expect(classifyFactFreshness({ expiresAt: daysAgo(365) }, NOW)).toBe("STALE");
  });

  it("accepts a custom warnWithinDays override", () => {
    expect(classifyFactFreshness({ expiresAt: daysFromNow(2) }, NOW, 1)).toBe("FRESH");
    expect(classifyFactFreshness({ expiresAt: daysFromNow(2) }, NOW, 3)).toBe("AGING");
  });

  it("is deterministic — same inputs, same reference time, byte-identical output across 100 repeated calls", () => {
    const input = { expiresAt: daysFromNow(10) };
    const results = Array.from({ length: 100 }, () => classifyFactFreshness(input, NOW));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("AGING");
  });
});
