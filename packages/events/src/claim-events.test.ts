import { describe, expect, it } from "vitest";
import { CLAIM_EVENT_TYPES, isClaimEventType, type ClaimTimelineEvent } from "./claim-events.js";

describe("CLAIM_EVENT_TYPES", () => {
  it("includes the spec's verbatim names: claim.submitted, claim.verified, claim.disputed", () => {
    for (const name of ["claim.submitted", "claim.verified", "claim.disputed"]) {
      expect(CLAIM_EVENT_TYPES).toContain(name);
    }
  });

  it("extends the scope's 3 named events with 4 more for full lifecycle coverage — 7 total, no duplicates", () => {
    expect(CLAIM_EVENT_TYPES.length).toBe(7);
    expect(new Set(CLAIM_EVENT_TYPES).size).toBe(7);
    for (const name of ["claim.scored", "claim.partial", "claim.rejected", "claim.dispute_decided"]) {
      expect(CLAIM_EVENT_TYPES).toContain(name);
    }
  });

  it("isClaimEventType is a real type guard", () => {
    expect(isClaimEventType("claim.submitted")).toBe(true);
    expect(isClaimEventType("claim.decided")).toBe(false); // not a real event name — decisions split into verified/partial/rejected
    expect(isClaimEventType("lockbox.sealed")).toBe(false);
  });

  it("claim.filed is NOT a valid event type — the FILED status name (claim-states.ts) and the claim.submitted EVENT name (the spec) deliberately diverge, see this file's header comment", () => {
    expect(isClaimEventType("claim.filed")).toBe(false);
  });
});

describe("ClaimTimelineEvent discriminated union", () => {
  it("narrows payload type by eventType at compile time (type-level check, asserted via a runtime switch)", () => {
    const events: ClaimTimelineEvent[] = [
      {
        eventType: "claim.submitted",
        aggregateType: "claim",
        aggregateId: "c1",
        payload: { claimantOrgId: "org1", subjectOrgId: "org2", relationshipType: "ACQUIRER_INTRODUCTION", directnessTier: "D4", opportunityId: null },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "claim.scored",
        aggregateType: "claim",
        aggregateId: "c1",
        payload: { scoreTotal: 46.4, algorithmVersion: "attribution-v1" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "claim.disputed",
        aggregateType: "claim",
        aggregateId: "c1",
        payload: { challengerOrgId: "org3", basis: "A later direct executive relationship supersedes." },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
      {
        eventType: "claim.dispute_decided",
        aggregateType: "claim",
        aggregateId: "c1",
        payload: { disputeId: "d1", resolution: "REJECTED_ORIGINAL", reviewerOrgId: "org-platform" },
        actorUserId: null,
        actorOrgId: null,
        actorRole: null,
      },
    ];

    for (const event of events) {
      switch (event.eventType) {
        case "claim.submitted":
          expect(event.payload.claimantOrgId).toBe("org1");
          break;
        case "claim.scored":
          expect(event.payload.scoreTotal).toBe(46.4);
          break;
        case "claim.disputed":
          expect(event.payload.challengerOrgId).toBe("org3");
          break;
        case "claim.dispute_decided":
          expect(event.payload.resolution).toBe("REJECTED_ORIGINAL");
          break;
        default:
          break;
      }
    }
  });

  it("no payload shape carries a score BREAKDOWN object, only a total + version — full explainability lives on the Claim row itself, not duplicated into the timeline (see this file's ClaimScoredPayload comment)", () => {
    const scoredPayloadKeys = new Set(["scoreTotal", "algorithmVersion"]);
    const event: ClaimTimelineEvent = {
      eventType: "claim.scored",
      aggregateType: "claim",
      aggregateId: "c1",
      payload: { scoreTotal: 50, algorithmVersion: "attribution-v1" },
      actorUserId: null,
      actorOrgId: null,
      actorRole: null,
    };
    for (const key of Object.keys(event.payload)) {
      expect(scoredPayloadKeys.has(key)).toBe(true);
    }
  });
});
