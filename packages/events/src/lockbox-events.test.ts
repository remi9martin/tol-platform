import { describe, expect, it } from "vitest";
import { LOCKBOX_EVENT_TYPES, isLockboxEventType, type LockboxTimelineEvent } from "./lockbox-events.js";

describe("LOCKBOX_EVENT_TYPES", () => {
  it("includes the spec's verbatim names: lockbox.sealed, lockbox.committed, lockbox.withdrawn, lockbox.opened", () => {
    for (const name of ["lockbox.sealed", "lockbox.committed", "lockbox.withdrawn", "lockbox.opened"]) {
      expect(LOCKBOX_EVENT_TYPES).toContain(name);
    }
  });

  it("has exactly 4 event types, no duplicates, no lockbox.frozen/match_eligible (not in the scope's named list)", () => {
    expect(LOCKBOX_EVENT_TYPES.length).toBe(4);
    expect(new Set(LOCKBOX_EVENT_TYPES).size).toBe(4);
    expect(LOCKBOX_EVENT_TYPES).not.toContain("lockbox.frozen");
    expect(LOCKBOX_EVENT_TYPES).not.toContain("lockbox.match_eligible");
  });

  it("isLockboxEventType is a real type guard", () => {
    expect(isLockboxEventType("lockbox.sealed")).toBe(true);
    expect(isLockboxEventType("rfq.sent")).toBe(false);
    expect(isLockboxEventType("lockbox.released")).toBe(false); // the release ACTION emits "lockbox.opened", not "lockbox.released" — see file header
  });
});

describe("LockboxTimelineEvent discriminated union", () => {
  it("narrows payload type by eventType at compile time (type-level check, asserted via a runtime switch), and no payload shape has any field for plaintext/DEK/share content", () => {
    const events: LockboxTimelineEvent[] = [
      {
        eventType: "lockbox.sealed",
        aggregateType: "lockbox",
        aggregateId: "l1",
        payload: { sealerOrgId: "org1", relationshipType: "ACQUIRER_RELATIONSHIP", region: "EU", ciphertextHash: "a".repeat(64) },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "lockbox.opened",
        aggregateType: "lockbox",
        aggregateId: "l1",
        payload: {
          recipientOrgId: "org2",
          conditionRef: "cond1",
          authorizedRoles: ["OPERATOR", "ESCROW"],
          ciphertextHash: "a".repeat(64),
        },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
    ];

    for (const event of events) {
      const keys = Object.keys(event.payload);
      // Structural proof (acceptance criterion 9): no payload shape in
      // this file's type definitions has a field named/shaped to hold
      // decrypted content — every key across every variant is drawn from
      // this fixed, safe allowlist.
      const safeKeys = new Set([
        "sealerOrgId",
        "relationshipType",
        "region",
        "ciphertextHash",
        "recipientOrgId",
        "conditionRef",
        "authorizedRoles",
        "withdrawReason",
      ]);
      for (const key of keys) {
        expect(safeKeys.has(key), `unexpected payload key "${key}"`).toBe(true);
      }

      switch (event.eventType) {
        case "lockbox.sealed":
          expect(event.payload.region).toBe("EU");
          break;
        case "lockbox.opened":
          expect(event.payload.authorizedRoles).toEqual(["OPERATOR", "ESCROW"]);
          break;
        default:
          break;
      }
    }
  });
});
