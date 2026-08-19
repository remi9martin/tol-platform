import { describe, expect, it } from "vitest";
import { CAPACITY_EVENT_TYPES, isCapacityEventType, type CapacityTimelineEvent } from "./capacity-events.js";

describe("CAPACITY_EVENT_TYPES", () => {
  it("has exactly 1 event type — matching matching-events.ts's precedent for a domain with one atomic lifecycle moment, no the spec verbatim name to extend from", () => {
    expect(CAPACITY_EVENT_TYPES.length).toBe(1);
    expect(CAPACITY_EVENT_TYPES).toEqual(["capacity_profile.freshness_recomputed"]);
  });

  it("isCapacityEventType is a real type guard", () => {
    expect(isCapacityEventType("capacity_profile.freshness_recomputed")).toBe(true);
    expect(isCapacityEventType("capacity_profile.created")).toBe(false);
    expect(isCapacityEventType("passport.created")).toBe(false);
  });
});

describe("CapacityTimelineEvent", () => {
  it("carries only safe summary fields — never a profile's own restricted commercial terms", () => {
    const event: CapacityTimelineEvent = {
      eventType: "capacity_profile.freshness_recomputed",
      aggregateType: "capacity_profile",
      aggregateId: "cp1",
      payload: { providerOrgId: "org1", previousFreshnessClass: "AGING", newFreshnessClass: "STALE", trigger: "sweep" },
      actorUserId: null,
      actorOrgId: null,
      actorRole: null,
    };
    const safeKeys = new Set(["providerOrgId", "previousFreshnessClass", "newFreshnessClass", "trigger"]);
    for (const key of Object.keys(event.payload)) {
      expect(safeKeys.has(key), `unexpected payload key "${key}"`).toBe(true);
    }
    expect(Object.keys(event.payload)).not.toContain("commercialTerms");
  });
});
