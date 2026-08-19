import { describe, expect, it } from "vitest";
import { buildDomainEvent } from "./envelope.js";

describe("buildDomainEvent", () => {
  it("returns the envelope unchanged — a typed pass-through, not a mutator", () => {
    const input = {
      eventType: "rfq.sent" as const,
      aggregateType: "rfq",
      aggregateId: "rfq-1",
      payload: { opportunityId: "opp-1", recipientOrgIds: ["org-1"], versionNumber: 1 },
      actorUserId: "user-1",
      actorOrgId: "org-1",
      actorRole: "MARKETPLACE_OPERATOR",
    };
    expect(buildDomainEvent(input)).toEqual(input);
  });

  it("does not stamp id/occurredAt — that is @tol/db's job, not this package's", () => {
    const built = buildDomainEvent({
      eventType: "quote.submitted" as const,
      aggregateType: "rfq",
      aggregateId: "rfq-1",
      payload: { quoteId: "q-1", providerOrgId: "org-2", quoteVersion: 1 },
      actorUserId: null,
      actorOrgId: null,
      actorRole: null,
    });
    expect(built).not.toHaveProperty("id");
    expect(built).not.toHaveProperty("occurredAt");
  });

  it("returns a frozen copy, not the same mutable reference as the input — fixed after review (review, 2026-08-18)", () => {
    const input = {
      eventType: "deal.opened" as const,
      aggregateType: "deal_room",
      aggregateId: "deal-1",
      payload: { opportunityId: "o1", rfqId: "r1", selectedQuoteId: "q1", merchantOrgId: "m1", providerOrgId: "p1" },
      actorUserId: null,
      actorOrgId: null,
      actorRole: null,
    };
    const built = buildDomainEvent(input);
    expect(built).not.toBe(input);
    expect(Object.isFrozen(built)).toBe(true);
    expect(() => {
      (built as { aggregateId: string }).aggregateId = "tampered";
    }).toThrow();
  });
});
