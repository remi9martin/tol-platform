import { describe, expect, it } from "vitest";
import { DomainTransitionError } from "./transition-error.js";
import { InvalidOpportunityTransitionError } from "./opportunity-states.js";
import { InvalidRfqTransitionError } from "./rfq-states.js";
import { InvalidDealTransitionError } from "./deal-states.js";

describe("DomainTransitionError — common base class for apps/api's central error handler", () => {
  it("InvalidOpportunityTransitionError is a DomainTransitionError", () => {
    expect(new InvalidOpportunityTransitionError("DRAFT", "CLOSED")).toBeInstanceOf(DomainTransitionError);
  });

  it("InvalidRfqTransitionError is a DomainTransitionError", () => {
    expect(new InvalidRfqTransitionError("RFQ", "SENT", "DRAFT")).toBeInstanceOf(DomainTransitionError);
  });

  it("InvalidDealTransitionError is a DomainTransitionError", () => {
    expect(new InvalidDealTransitionError("DealRoom", "OPEN", "LIVE")).toBeInstanceOf(DomainTransitionError);
  });

  it("all three are still real Error instances (name/message/stack intact)", () => {
    const err = new InvalidRfqTransitionError("Quote", "SELECTED", "WITHDRAWN");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("SELECTED -> WITHDRAWN");
  });
});
