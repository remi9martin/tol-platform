import { describe, expect, it } from "vitest";
import {
  MoneyInvariantError,
  assertBigIntMinorUnits,
  assertCurrencyCode,
  assertIntegerBps,
  assertIntegerMinorUnits,
  parseBigIntMinorUnits,
} from "./money.js";

describe("assertIntegerMinorUnits", () => {
  it("accepts a non-negative integer", () => {
    expect(() => assertIntegerMinorUnits(499_00, "amountMinor")).not.toThrow();
    expect(() => assertIntegerMinorUnits(0, "amountMinor")).not.toThrow();
  });

  it("rejects a float — the p.12 'never floating point' invariant", () => {
    expect(() => assertIntegerMinorUnits(499.99, "amountMinor")).toThrow(MoneyInvariantError);
  });

  it("rejects a negative value", () => {
    expect(() => assertIntegerMinorUnits(-100, "amountMinor")).toThrow(MoneyInvariantError);
  });

  it("rejects NaN/Infinity", () => {
    expect(() => assertIntegerMinorUnits(Number.NaN, "amountMinor")).toThrow(MoneyInvariantError);
    expect(() => assertIntegerMinorUnits(Number.POSITIVE_INFINITY, "amountMinor")).toThrow(MoneyInvariantError);
  });
});

describe("assertBigIntMinorUnits", () => {
  it("accepts a non-negative bigint, including very large GPV-scale values", () => {
    expect(() => assertBigIntMinorUnits(30_000_000_00n, "offeredCardGpvMinor")).not.toThrow();
  });

  it("rejects a negative bigint", () => {
    expect(() => assertBigIntMinorUnits(-1n, "offeredCardGpvMinor")).toThrow(MoneyInvariantError);
  });
});

describe("assertIntegerBps", () => {
  it("accepts a value within the default range", () => {
    expect(() => assertIntegerBps(250, "feeBps")).not.toThrow();
  });

  it("rejects a float", () => {
    expect(() => assertIntegerBps(12.5, "feeBps")).toThrow(MoneyInvariantError);
  });

  it("rejects a negative value", () => {
    expect(() => assertIntegerBps(-5, "feeBps")).toThrow(MoneyInvariantError);
  });

  it("rejects a value above an explicit max", () => {
    expect(() => assertIntegerBps(15_000, "feeBps", 10_000)).toThrow(MoneyInvariantError);
    expect(() => assertIntegerBps(10_000, "feeBps", 10_000)).not.toThrow();
  });
});

describe("parseBigIntMinorUnits", () => {
  it("returns 0n for undefined (the 'field not supplied' case)", () => {
    expect(parseBigIntMinorUnits(undefined, "amountMinor")).toBe(0n);
  });

  it("parses a valid non-negative integer string", () => {
    expect(parseBigIntMinorUnits("3000000000", "amountMinor")).toBe(3_000_000_000n);
  });

  it("throws MoneyInvariantError (not a raw SyntaxError) on a non-numeric string — fixed after review (review, 2026-08-18)", () => {
    expect(() => parseBigIntMinorUnits("not-a-number", "amountMinor")).toThrow(MoneyInvariantError);
  });

  it("throws MoneyInvariantError on a negative string", () => {
    expect(() => parseBigIntMinorUnits("-100", "amountMinor")).toThrow(MoneyInvariantError);
  });

  it("throws MoneyInvariantError (not a raw error) on a decimal string", () => {
    expect(() => parseBigIntMinorUnits("100.50", "amountMinor")).toThrow(MoneyInvariantError);
  });
});

describe("assertCurrencyCode", () => {
  it("accepts a valid 3-letter uppercase code", () => {
    expect(() => assertCurrencyCode("USD", "currency")).not.toThrow();
  });

  it("rejects lowercase, wrong length, or non-letters", () => {
    expect(() => assertCurrencyCode("usd", "currency")).toThrow(MoneyInvariantError);
    expect(() => assertCurrencyCode("US", "currency")).toThrow(MoneyInvariantError);
    expect(() => assertCurrencyCode("US1", "currency")).toThrow(MoneyInvariantError);
  });
});
