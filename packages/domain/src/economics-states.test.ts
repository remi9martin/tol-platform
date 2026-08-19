import { describe, expect, it } from "vitest";
import {
  ACCRUAL_DERIVED_STATUSES,
  COMMISSION_BASIS_VALUES,
  COMMISSION_COMPONENT_TYPES,
  COMMISSION_RECIPIENT_TYPES,
  COMMISSION_SCHEDULE_STATUSES,
  InvalidCommissionScheduleTransitionError,
  LEDGER_DIRECTIONS,
  LEDGER_ENTRY_TYPES,
  assertValidCommissionScheduleTransition,
  isAccrualDerivedStatus,
  isCommissionBasis,
  isCommissionComponentType,
  isCommissionRecipientType,
  isCommissionScheduleStatus,
  isLedgerDirection,
  isLedgerEntryType,
} from "./economics-states.js";

describe("COMMISSION_SCHEDULE_STATUSES", () => {
  it("has exactly the four documented states", () => {
    expect(COMMISSION_SCHEDULE_STATUSES).toEqual(["DRAFT", "ACTIVE", "SUPERSEDED", "RETIRED"]);
  });
});

describe("assertValidCommissionScheduleTransition", () => {
  it("allows DRAFT -> ACTIVE", () => {
    expect(() => assertValidCommissionScheduleTransition("DRAFT", "ACTIVE")).not.toThrow();
  });

  it("allows DRAFT -> RETIRED (abandoned before ever going live)", () => {
    expect(() => assertValidCommissionScheduleTransition("DRAFT", "RETIRED")).not.toThrow();
  });

  it("allows ACTIVE -> SUPERSEDED (the spec: 'changing a schedule creates a new effective-dated version')", () => {
    expect(() => assertValidCommissionScheduleTransition("ACTIVE", "SUPERSEDED")).not.toThrow();
  });

  it("allows ACTIVE -> RETIRED (withdrawn with no replacement)", () => {
    expect(() => assertValidCommissionScheduleTransition("ACTIVE", "RETIRED")).not.toThrow();
  });

  it("rejects any transition out of terminal SUPERSEDED or RETIRED — a historical version is never reactivated", () => {
    expect(() => assertValidCommissionScheduleTransition("SUPERSEDED", "ACTIVE")).toThrow(InvalidCommissionScheduleTransitionError);
    expect(() => assertValidCommissionScheduleTransition("RETIRED", "DRAFT")).toThrow(InvalidCommissionScheduleTransitionError);
  });

  it("rejects DRAFT -> SUPERSEDED (a version that was never ACTIVE cannot be superseded)", () => {
    expect(() => assertValidCommissionScheduleTransition("DRAFT", "SUPERSEDED")).toThrow(InvalidCommissionScheduleTransitionError);
  });

  it("rejects a self-transition (from === to)", () => {
    expect(() => assertValidCommissionScheduleTransition("ACTIVE", "ACTIVE")).toThrow(InvalidCommissionScheduleTransitionError);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidCommissionScheduleTransition("NOT_A_STATUS" as never, "ACTIVE")).toThrow(InvalidCommissionScheduleTransitionError);
  });

  it("throws the typed error for an out-of-enum 'to' value", () => {
    expect(() => assertValidCommissionScheduleTransition("DRAFT", "NOT_A_STATUS" as never)).toThrow(InvalidCommissionScheduleTransitionError);
  });
});

describe("closed vocabularies", () => {
  it("COMMISSION_BASIS_VALUES matches the spec verbatim", () => {
    expect(COMMISSION_BASIS_VALUES).toEqual(["GROSS_PROCESSING_VOLUME", "NET_PLATFORM_REVENUE", "RECEIVED_COMMISSION", "FIXED_FEE", "SETUP_FEE", "OTHER"]);
  });

  it("COMMISSION_RECIPIENT_TYPES has exactly 3 values", () => {
    expect(COMMISSION_RECIPIENT_TYPES).toEqual(["CONTRIBUTOR", "PLATFORM", "OTHER"]);
  });

  it("COMMISSION_COMPONENT_TYPES has exactly 2 values", () => {
    expect(COMMISSION_COMPONENT_TYPES).toEqual(["PERCENTAGE_BPS", "FIXED_AMOUNT"]);
  });

  it("LEDGER_ENTRY_TYPES has exactly 4 values", () => {
    expect(LEDGER_ENTRY_TYPES).toEqual(["ACCRUAL", "ADJUSTMENT", "PAYMENT", "REVERSAL"]);
  });

  it("LEDGER_DIRECTIONS has exactly 2 values", () => {
    expect(LEDGER_DIRECTIONS).toEqual(["CREDIT", "DEBIT"]);
  });

  it("ACCRUAL_DERIVED_STATUSES has exactly 5 values, DISPUTED deliberately not among them (named, not-built extension — ADR-0013)", () => {
    expect(ACCRUAL_DERIVED_STATUSES).toEqual(["ACCRUED", "ADJUSTED", "PARTIALLY_PAID", "PAID", "REVERSED"]);
    expect(ACCRUAL_DERIVED_STATUSES as readonly string[]).not.toContain("DISPUTED");
  });

  it("every type guard accepts its own vocabulary and rejects garbage", () => {
    expect(isCommissionScheduleStatus("ACTIVE")).toBe(true);
    expect(isCommissionScheduleStatus("NOPE")).toBe(false);
    expect(isCommissionBasis("GROSS_PROCESSING_VOLUME")).toBe(true);
    expect(isCommissionBasis("NOPE")).toBe(false);
    expect(isCommissionRecipientType("CONTRIBUTOR")).toBe(true);
    expect(isCommissionRecipientType("NOPE")).toBe(false);
    expect(isCommissionComponentType("PERCENTAGE_BPS")).toBe(true);
    expect(isCommissionComponentType("NOPE")).toBe(false);
    expect(isLedgerEntryType("ACCRUAL")).toBe(true);
    expect(isLedgerEntryType("NOPE")).toBe(false);
    expect(isLedgerDirection("CREDIT")).toBe(true);
    expect(isLedgerDirection("NOPE")).toBe(false);
    expect(isAccrualDerivedStatus("PAID")).toBe(true);
    expect(isAccrualDerivedStatus("NOPE")).toBe(false);
  });
});
