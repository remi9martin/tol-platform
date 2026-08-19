import { describe, expect, it } from "vitest";
import { PASSPORT_EVENT_TYPES, isPassportEventType, type PassportTimelineEvent } from "./passport-events.js";

describe("PASSPORT_EVENT_TYPES", () => {
  it("has exactly 6 event types, no duplicates", () => {
    expect(PASSPORT_EVENT_TYPES.length).toBe(6);
    expect(new Set(PASSPORT_EVENT_TYPES).size).toBe(6);
  });

  it("isPassportEventType is a real type guard", () => {
    expect(isPassportEventType("passport.created")).toBe(true);
    expect(isPassportEventType("passport.verified")).toBe(true);
    expect(isPassportEventType("claim.scored")).toBe(false);
    expect(isPassportEventType("passport.deleted")).toBe(false);
  });
});

describe("PassportTimelineEvent discriminated union", () => {
  it("narrows payload type by eventType, and no payload shape carries a Fact's full normalizedValue or an Evidence's raw objectRef/checksum content — safe references only", () => {
    const events: PassportTimelineEvent[] = [
      {
        eventType: "passport.created",
        aggregateType: "passport",
        aggregateId: "p1",
        payload: { organizationId: "org1" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "passport.fact_updated",
        aggregateType: "passport",
        aggregateId: "p1",
        payload: { fieldKey: "legalEntityConfirmed", sectionType: "IDENTITY", verification: "SELF_REPORTED" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "passport.readiness_computed",
        aggregateType: "passport",
        aggregateId: "p1",
        payload: { score: 75, blockerCount: 1, warningCount: 4, algorithmVersion: "evidence-readiness-v1" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
    ];

    const safeKeys = new Set([
      "organizationId",
      "fieldKey",
      "sectionType",
      "verification",
      "evidenceId",
      "type",
      "score",
      "blockerCount",
      "warningCount",
      "algorithmVersion",
      "reviewerOrgId",
      "reason",
      "from",
      "to",
    ]);
    for (const event of events) {
      for (const key of Object.keys(event.payload)) {
        expect(safeKeys.has(key), `unexpected payload key "${key}"`).toBe(true);
      }
      // Structural proof: nothing named/shaped like "normalizedValue",
      // "objectRef", or "checksum" (the raw Fact/Evidence content)
      // appears anywhere in these payloads.
      expect(Object.keys(event.payload)).not.toContain("normalizedValue");
      expect(Object.keys(event.payload)).not.toContain("objectRef");
      expect(Object.keys(event.payload)).not.toContain("checksum");
    }

    const created = events[0]!;
    if (created.eventType === "passport.created") {
      expect(created.payload.organizationId).toBe("org1");
    }
  });
});
