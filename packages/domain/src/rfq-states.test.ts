import { describe, expect, it } from "vitest";
import {
  InvalidRfqTransitionError,
  QUOTE_STATUSES,
  RFQ_RECIPIENT_STATES,
  RFQ_STATUSES,
  assertValidQuoteTransition,
  assertValidRfqRecipientTransition,
  assertValidRfqTransition,
} from "./rfq-states.js";

describe("RFQ_STATUSES", () => {
  it("matches the spec verbatim (DRAFT -> SENT -> ACKNOWLEDGED -> QUESTIONS -> QUOTED -> EXPIRED/DECLINED/SELECTED)", () => {
    expect(RFQ_STATUSES).toEqual([
      "DRAFT",
      "SENT",
      "ACKNOWLEDGED",
      "QUESTIONS",
      "QUOTED",
      "EXPIRED",
      "DECLINED",
      "SELECTED",
    ]);
  });
});

describe("assertValidRfqTransition", () => {
  it("allows DRAFT -> SENT -> QUOTED -> SELECTED", () => {
    expect(() => assertValidRfqTransition("DRAFT", "SENT")).not.toThrow();
    expect(() => assertValidRfqTransition("SENT", "QUOTED")).not.toThrow();
    expect(() => assertValidRfqTransition("QUOTED", "SELECTED")).not.toThrow();
  });

  it("allows QUOTED -> QUOTED (a second recipient quotes after the first)", () => {
    expect(() => assertValidRfqTransition("QUOTED", "QUOTED")).not.toThrow();
  });

  it("rejects re-sending an already-SELECTED RFQ", () => {
    expect(() => assertValidRfqTransition("SELECTED", "SENT")).toThrow(InvalidRfqTransitionError);
  });

  it("rejects any transition out of terminal states", () => {
    for (const terminal of ["EXPIRED", "DECLINED", "SELECTED"] as const) {
      expect(() => assertValidRfqTransition(terminal, "SENT")).toThrow(InvalidRfqTransitionError);
    }
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidRfqTransition("NOT_A_STATUS" as never, "SENT")).toThrow(InvalidRfqTransitionError);
  });
});

describe("RFQRecipient transitions", () => {
  it("has exactly 5 inferred states", () => {
    expect(RFQ_RECIPIENT_STATES).toEqual(["INVITED", "ACKNOWLEDGED", "DECLINED", "QUOTED", "EXPIRED"]);
  });

  it("allows INVITED -> QUOTED directly (earlier folds acknowledge into the first real action)", () => {
    expect(() => assertValidRfqRecipientTransition("INVITED", "QUOTED")).not.toThrow();
  });

  it("allows INVITED -> DECLINED", () => {
    expect(() => assertValidRfqRecipientTransition("INVITED", "DECLINED")).not.toThrow();
  });

  it("rejects DECLINED -> QUOTED (a provider who declined cannot then quote)", () => {
    expect(() => assertValidRfqRecipientTransition("DECLINED", "QUOTED")).toThrow(InvalidRfqTransitionError);
  });

  it("rejects a same-state call", () => {
    expect(() => assertValidRfqRecipientTransition("INVITED", "INVITED")).toThrow(InvalidRfqTransitionError);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidRfqRecipientTransition("NOT_A_STATUS" as never, "QUOTED")).toThrow(
      InvalidRfqTransitionError,
    );
  });
});

describe("Quote transitions", () => {
  it("has exactly 5 states including WITHDRAWN and REJECTED", () => {
    expect(QUOTE_STATUSES).toEqual(["SUBMITTED", "SELECTED", "REJECTED", "EXPIRED", "WITHDRAWN"]);
  });

  it("allows SUBMITTED -> SELECTED, SUBMITTED -> WITHDRAWN", () => {
    expect(() => assertValidQuoteTransition("SUBMITTED", "SELECTED")).not.toThrow();
    expect(() => assertValidQuoteTransition("SUBMITTED", "WITHDRAWN")).not.toThrow();
  });

  it("rejects any transition out of SELECTED (immutable once chosen)", () => {
    expect(() => assertValidQuoteTransition("SELECTED", "WITHDRAWN")).toThrow(InvalidRfqTransitionError);
  });

  it("rejects withdrawing an already-withdrawn quote", () => {
    expect(() => assertValidQuoteTransition("WITHDRAWN", "WITHDRAWN")).toThrow(InvalidRfqTransitionError);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidQuoteTransition("NOT_A_STATUS" as never, "SELECTED")).toThrow(InvalidRfqTransitionError);
  });
});
