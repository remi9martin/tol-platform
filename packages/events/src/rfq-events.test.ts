import { describe, expect, it } from "vitest";
import { RFQ_EVENT_TYPES, isRfqEventType, type RfqTimelineEvent } from "./rfq-events.js";

describe("RFQ_EVENT_TYPES", () => {
  it("includes the spec's verbatim names: rfq.sent, rfq.acknowledged, quote.submitted, quote.selected", () => {
    for (const name of ["rfq.sent", "rfq.acknowledged", "quote.submitted", "quote.selected"]) {
      expect(RFQ_EVENT_TYPES).toContain(name);
    }
  });

  it("has exactly 7 event types, no duplicates (earlier added rfq.expired)", () => {
    expect(RFQ_EVENT_TYPES.length).toBe(7);
    expect(new Set(RFQ_EVENT_TYPES).size).toBe(7);
  });

  it("isRfqEventType is a real type guard", () => {
    expect(isRfqEventType("rfq.sent")).toBe(true);
    expect(isRfqEventType("rfq.expired")).toBe(true);
    expect(isRfqEventType("deal.opened")).toBe(false);
    expect(isRfqEventType("not.a.real.event")).toBe(false);
  });
});

describe("RfqTimelineEvent discriminated union", () => {
  it("narrows payload type by eventType at compile time (type-level check, asserted via a runtime switch)", () => {
    const events: RfqTimelineEvent[] = [
      {
        eventType: "rfq.sent",
        aggregateType: "rfq",
        aggregateId: "r1",
        payload: { opportunityId: "o1", recipientOrgIds: ["p1"], versionNumber: 1 },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "quote.selected",
        aggregateType: "rfq",
        aggregateId: "r1",
        payload: { quoteId: "q1", dealRoomId: "d1" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "rfq.expired",
        aggregateType: "rfq",
        aggregateId: "r1",
        payload: { from: "QUOTED", dueAt: "2026-08-01T00:00:00.000Z" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
    ];

    for (const event of events) {
      switch (event.eventType) {
        case "rfq.sent":
          expect(event.payload.versionNumber).toBe(1);
          break;
        case "quote.selected":
          expect(event.payload.dealRoomId).toBe("d1");
          break;
        case "rfq.expired":
          expect(event.payload.from).toBe("QUOTED");
          break;
        default:
          break;
      }
    }
  });
});
