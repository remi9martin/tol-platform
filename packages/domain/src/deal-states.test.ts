import { describe, expect, it } from "vitest";
import {
  DEAL_CONDITION_STATES,
  DEAL_DECISION_TYPES,
  DEAL_ROOM_STATUSES,
  InvalidDealTransitionError,
  assertValidDealConditionTransition,
  assertValidDealRoomTransition,
} from "./deal-states.js";

describe("DEAL_ROOM_STATUSES", () => {
  it("matches the spec verbatim (OPEN -> CONDITIONS -> APPROVED/DECLINED -> ACTIVATION -> LIVE -> ARCHIVED)", () => {
    expect(DEAL_ROOM_STATUSES).toEqual(["OPEN", "CONDITIONS", "APPROVED", "DECLINED", "ACTIVATION", "LIVE", "ARCHIVED"]);
  });
});

describe("assertValidDealRoomTransition", () => {
  it("allows OPEN -> CONDITIONS -> APPROVED", () => {
    expect(() => assertValidDealRoomTransition("OPEN", "CONDITIONS")).not.toThrow();
    expect(() => assertValidDealRoomTransition("CONDITIONS", "APPROVED")).not.toThrow();
  });

  it("allows OPEN straight to APPROVED (no conditions were needed) — a real, reachable earlier path", () => {
    expect(() => assertValidDealRoomTransition("OPEN", "APPROVED")).not.toThrow();
  });

  it("allows DECLINED from either OPEN or CONDITIONS", () => {
    expect(() => assertValidDealRoomTransition("OPEN", "DECLINED")).not.toThrow();
    expect(() => assertValidDealRoomTransition("CONDITIONS", "DECLINED")).not.toThrow();
  });

  it("rejects any transition out of terminal DECLINED or ARCHIVED", () => {
    expect(() => assertValidDealRoomTransition("DECLINED", "OPEN")).toThrow(InvalidDealTransitionError);
    expect(() => assertValidDealRoomTransition("ARCHIVED", "LIVE")).toThrow(InvalidDealTransitionError);
  });

  it("rejects skipping CONDITIONS/APPROVED straight to ACTIVATION", () => {
    expect(() => assertValidDealRoomTransition("OPEN", "ACTIVATION")).toThrow(InvalidDealTransitionError);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidDealRoomTransition("NOT_A_STATUS" as never, "CONDITIONS")).toThrow(
      InvalidDealTransitionError,
    );
  });
});

describe("DealCondition transitions", () => {
  it("has exactly 4 inferred states", () => {
    expect(DEAL_CONDITION_STATES).toEqual(["PENDING", "SATISFIED", "WAIVED", "REJECTED"]);
  });

  it("allows PENDING -> SATISFIED, PENDING -> WAIVED, PENDING -> REJECTED", () => {
    expect(() => assertValidDealConditionTransition("PENDING", "SATISFIED")).not.toThrow();
    expect(() => assertValidDealConditionTransition("PENDING", "WAIVED")).not.toThrow();
    expect(() => assertValidDealConditionTransition("PENDING", "REJECTED")).not.toThrow();
  });

  it("allows REJECTED -> PENDING (resubmission) as the one backward edge", () => {
    expect(() => assertValidDealConditionTransition("REJECTED", "PENDING")).not.toThrow();
  });

  it("rejects any transition out of terminal SATISFIED or WAIVED", () => {
    expect(() => assertValidDealConditionTransition("SATISFIED", "PENDING")).toThrow(InvalidDealTransitionError);
    expect(() => assertValidDealConditionTransition("WAIVED", "PENDING")).toThrow(InvalidDealTransitionError);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidDealConditionTransition("NOT_A_STATUS" as never, "PENDING")).toThrow(
      InvalidDealTransitionError,
    );
  });
});

describe("DEAL_DECISION_TYPES", () => {
  it("matches the spec verbatim (quote selection, approvals, declines, exceptions)", () => {
    expect(DEAL_DECISION_TYPES).toEqual(["QUOTE_SELECTED", "APPROVAL", "DECLINE", "EXCEPTION"]);
  });
});
