import { describe, expect, it } from "vitest";
import { ECONOMICS_EVENT_TYPES, isEconomicsEventType, type EconomicsTimelineEvent } from "./economics-events.js";

describe("ECONOMICS_EVENT_TYPES", () => {
  it("has exactly 5 event types, no duplicates", () => {
    expect(ECONOMICS_EVENT_TYPES.length).toBe(5);
    expect(new Set(ECONOMICS_EVENT_TYPES).size).toBe(5);
  });

  it("isEconomicsEventType is a real type guard", () => {
    expect(isEconomicsEventType("commission.accrued")).toBe(true);
    expect(isEconomicsEventType("commission.paid")).toBe(true);
    expect(isEconomicsEventType("economics.schedule_created")).toBe(true);
    expect(isEconomicsEventType("economics.schedule_superseded")).toBe(true);
    expect(isEconomicsEventType("commission.adjusted")).toBe(true);
    expect(isEconomicsEventType("commission.reversed")).toBe(false);
    expect(isEconomicsEventType("claim.scored")).toBe(false);
  });
});

describe("EconomicsTimelineEvent discriminated union", () => {
  it("narrows payload type by eventType, and every money field is a minor-units STRING, never a bare number — no payload carries a component's bps/fixedAmountMinor rate or a payment's evidenceRef", () => {
    const events: EconomicsTimelineEvent[] = [
      {
        eventType: "economics.schedule_created",
        aggregateType: "deal_room",
        aggregateId: "deal-1",
        payload: { scheduleId: "sched-1", versionNumber: 1, basis: "GROSS_MERCHANDISE_VALUE" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "economics.schedule_superseded",
        aggregateType: "deal_room",
        aggregateId: "deal-1",
        payload: { scheduleId: "sched-2", versionNumber: 2, basis: "GROSS_MERCHANDISE_VALUE" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "commission.accrued",
        aggregateType: "deal_room",
        aggregateId: "deal-1",
        payload: { revenueEventId: "rev-1", scheduleId: "sched-1", netDistributableMinor: "50000000", entryCount: 2 },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "commission.paid",
        aggregateType: "deal_room",
        aggregateId: "deal-1",
        payload: { paymentId: "pay-1", recipientOrgId: "org-1", totalAmountMinor: "20000000", accrualRootIds: ["acc-1"] },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "commission.adjusted",
        aggregateType: "deal_room",
        aggregateId: "deal-1",
        payload: { accrualRootId: "acc-1", direction: "CREDIT", amountMinor: "500" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
    ];

    const safeKeys = new Set([
      "scheduleId",
      "versionNumber",
      "basis",
      "revenueEventId",
      "netDistributableMinor",
      "entryCount",
      "paymentId",
      "recipientOrgId",
      "totalAmountMinor",
      "accrualRootIds",
      "accrualRootId",
      "direction",
      "amountMinor",
    ]);
    for (const event of events) {
      for (const key of Object.keys(event.payload)) {
        expect(safeKeys.has(key), `unexpected payload key "${key}"`).toBe(true);
      }
      // Structural proof: nothing named/shaped like a component's rate
      // fields or a payment's evidence reference appears anywhere here.
      expect(Object.keys(event.payload)).not.toContain("bps");
      expect(Object.keys(event.payload)).not.toContain("fixedAmountMinor");
      expect(Object.keys(event.payload)).not.toContain("evidenceRef");
      expect(Object.keys(event.payload)).not.toContain("reference");
    }

    // Every money-shaped value across every payload is a string, never a number.
    const moneyKeys = ["netDistributableMinor", "totalAmountMinor", "amountMinor"];
    for (const event of events) {
      for (const key of moneyKeys) {
        const value = (event.payload as unknown as Record<string, unknown>)[key];
        if (value !== undefined) {
          expect(typeof value, `${key} must be a minor-units string, not a number`).toBe("string");
        }
      }
    }

    const accrued = events[2]!;
    if (accrued.eventType === "commission.accrued") {
      expect(accrued.payload.netDistributableMinor).toBe("50000000");
    }
  });
});
