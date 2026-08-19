import { describe, expect, it } from "vitest";
import {
  DEAL_CONDITION_RESOLUTION_STATES,
  DEAL_DECISION_TYPE_NAMES,
  DEAL_EVENT_TYPES,
  DEAL_PARTICIPANT_ROLE_NAMES,
  isDealEventType,
  type DealStageChangedPayload,
  type DealTimelineEvent,
} from "./deal-events.js";

describe("DEAL_EVENT_TYPES", () => {
  it("includes the spec's verbatim names: condition.created (as deal.condition_created), deal.activated, deal.live", () => {
    for (const name of ["deal.condition_created", "deal.activated", "deal.live"]) {
      expect(DEAL_EVENT_TYPES).toContain(name);
    }
  });

  it("has exactly 9 event types, no duplicates", () => {
    expect(DEAL_EVENT_TYPES.length).toBe(9);
    expect(new Set(DEAL_EVENT_TYPES).size).toBe(9);
  });

  it("isDealEventType is a real type guard", () => {
    expect(isDealEventType("deal.opened")).toBe(true);
    expect(isDealEventType("rfq.sent")).toBe(false);
  });
});

describe("exported named union types (extracted after review)", () => {
  it("DEAL_PARTICIPANT_ROLE_NAMES has exactly the 3 DealParticipantRole enum values", () => {
    expect(DEAL_PARTICIPANT_ROLE_NAMES).toEqual(["MERCHANT", "PROVIDER", "OPERATOR"]);
  });

  it("DEAL_CONDITION_RESOLUTION_STATES has exactly the 3 non-PENDING DealConditionState values", () => {
    expect(DEAL_CONDITION_RESOLUTION_STATES).toEqual(["SATISFIED", "WAIVED", "REJECTED"]);
  });

  it("DEAL_DECISION_TYPE_NAMES matches @tol/domain's DEAL_DECISION_TYPES", () => {
    expect(DEAL_DECISION_TYPE_NAMES).toEqual(["QUOTE_SELECTED", "APPROVAL", "DECLINE", "EXCEPTION"]);
  });

  it("DealStageChangedPayload.from/to accept real DealRoomStatus values (compile-time check)", () => {
    const payload: DealStageChangedPayload = { from: "OPEN", to: "CONDITIONS" };
    expect(payload.from).toBe("OPEN");
  });
});

describe("DealTimelineEvent discriminated union", () => {
  it("narrows payload type by eventType at compile time (asserted via a runtime switch)", () => {
    const events: DealTimelineEvent[] = [
      {
        eventType: "deal.opened",
        aggregateType: "deal_room",
        aggregateId: "d1",
        payload: {
          opportunityId: "o1",
          rfqId: "r1",
          selectedQuoteId: "q1",
          merchantOrgId: "m1",
          providerOrgId: "p1",
        },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "deal.decision_recorded",
        aggregateType: "deal_room",
        aggregateId: "d1",
        payload: { decisionId: "dec1", decisionType: "APPROVAL" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
    ];

    for (const event of events) {
      switch (event.eventType) {
        case "deal.opened":
          expect(event.payload.merchantOrgId).toBe("m1");
          break;
        case "deal.decision_recorded":
          expect(event.payload.decisionType).toBe("APPROVAL");
          break;
        default:
          break;
      }
    }
  });
});
