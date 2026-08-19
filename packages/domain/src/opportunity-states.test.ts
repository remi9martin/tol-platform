import { describe, expect, it } from "vitest";
import {
  InvalidOpportunityTransitionError,
  OPPORTUNITY_STATUSES,
  assertValidOpportunityTransition,
  isOpportunityStatus,
} from "./opportunity-states.js";

describe("OPPORTUNITY_STATUSES", () => {
  it("has exactly the 9 values from the spec, in order", () => {
    expect(OPPORTUNITY_STATUSES).toEqual([
      "DRAFT",
      "READINESS_BLOCKED",
      "MATCH_READY",
      "INVITED",
      "QUOTED",
      "SELECTED",
      "ACTIVATING",
      "LIVE",
      "CLOSED",
    ]);
  });

  it("isOpportunityStatus is a real type guard", () => {
    expect(isOpportunityStatus("DRAFT")).toBe(true);
    expect(isOpportunityStatus("NOT_A_STATUS")).toBe(false);
  });
});

describe("assertValidOpportunityTransition", () => {
  it("allows the documented happy path DRAFT -> MATCH_READY -> INVITED", () => {
    expect(() => assertValidOpportunityTransition("DRAFT", "MATCH_READY")).not.toThrow();
    expect(() => assertValidOpportunityTransition("MATCH_READY", "INVITED")).not.toThrow();
  });

  it("allows the readiness-blocked side path", () => {
    expect(() => assertValidOpportunityTransition("DRAFT", "READINESS_BLOCKED")).not.toThrow();
    expect(() => assertValidOpportunityTransition("READINESS_BLOCKED", "MATCH_READY")).not.toThrow();
  });

  it("rejects skipping straight from DRAFT to SELECTED", () => {
    expect(() => assertValidOpportunityTransition("DRAFT", "SELECTED")).toThrow(InvalidOpportunityTransitionError);
  });

  it("rejects any transition out of the terminal CLOSED state", () => {
    expect(() => assertValidOpportunityTransition("CLOSED", "DRAFT")).toThrow(InvalidOpportunityTransitionError);
    expect(() => assertValidOpportunityTransition("CLOSED", "LIVE")).toThrow(InvalidOpportunityTransitionError);
  });

  it("rejects a same-state 'transition' — callers must not call this as a no-op", () => {
    expect(() => assertValidOpportunityTransition("MATCH_READY", "MATCH_READY")).toThrow(
      InvalidOpportunityTransitionError,
    );
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidOpportunityTransition("NOT_A_STATUS" as never, "MATCH_READY")).toThrow(
      InvalidOpportunityTransitionError,
    );
  });

  it("every status has a defined (possibly empty) transition set — no gaps", () => {
    for (const status of OPPORTUNITY_STATUSES) {
      // Calling with itself always throws (same-state rule), but must
      // throw InvalidOpportunityTransitionError specifically, not a
      // TypeError from an undefined lookup — proves every status is a key.
      expect(() => assertValidOpportunityTransition(status, status)).toThrow(InvalidOpportunityTransitionError);
    }
  });
});
