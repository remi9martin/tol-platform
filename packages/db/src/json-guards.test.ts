import { describe, expect, it } from "vitest";
import { JsonShapeError, assertJsonSafeObjectArray, assertJsonSafePlainObject, assertJsonSerializableValue, assertStringArray } from "./json-guards.js";

describe("assertStringArray", () => {
  it("accepts an array of strings, including empty", () => {
    expect(() => assertStringArray(["US", "CA"], "f")).not.toThrow();
    expect(() => assertStringArray([], "f")).not.toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => assertStringArray("US", "f")).toThrow(JsonShapeError);
    expect(() => assertStringArray({ 0: "US" }, "f")).toThrow(JsonShapeError);
    expect(() => assertStringArray(null, "f")).toThrow(JsonShapeError);
  });

  it("rejects an array containing a non-string element", () => {
    expect(() => assertStringArray(["US", 5], "f")).toThrow(JsonShapeError);
    expect(() => assertStringArray([{ code: "US" }], "f")).toThrow(JsonShapeError);
  });
});

describe("assertJsonSafePlainObject", () => {
  it("accepts a plain object with nested safe values", () => {
    expect(() =>
      assertJsonSafePlainObject({ rate: { bps: 285, scope: "all_volume" }, list: [1, 2, "x", null] }, "f"),
    ).not.toThrow();
  });

  it("rejects a non-object (array, string, null)", () => {
    expect(() => assertJsonSafePlainObject([1, 2], "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSafePlainObject("x", "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSafePlainObject(null, "f")).toThrow(JsonShapeError);
  });

  it("rejects a bigint anywhere in the structure — the p.12 'never floating point'-adjacent JSON gotcha (bigint isn't JSON-representable at all)", () => {
    expect(() => assertJsonSafePlainObject({ amountMinor: 5n }, "f")).toThrow(JsonShapeError);
  });

  it("rejects a function or symbol value", () => {
    expect(() => assertJsonSafePlainObject({ cb: () => 1 }, "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSafePlainObject({ s: Symbol("x") }, "f")).toThrow(JsonShapeError);
  });

  it("rejects a non-finite number (NaN/Infinity)", () => {
    expect(() => assertJsonSafePlainObject({ x: Number.NaN }, "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSafePlainObject({ x: Number.POSITIVE_INFINITY }, "f")).toThrow(JsonShapeError);
  });

  it("rejects a circular reference instead of hanging or crashing with a stack overflow", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj["self"] = obj;
    expect(() => assertJsonSafePlainObject(obj, "f")).toThrow(JsonShapeError);
  });

  it("error message includes the nested field path for a deeply-nested violation", () => {
    try {
      assertJsonSafePlainObject({ rate: { nested: { bad: undefined } } }, "quote.terms");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JsonShapeError);
      expect((err as Error).message).toContain("rate.nested.bad");
    }
  });
});

describe("assertJsonSafeObjectArray (earlier: ClaimDispute.evidence)", () => {
  it("accepts an array of plain objects, including empty", () => {
    expect(() => assertJsonSafeObjectArray([{ basis: "email" }, { basis: "contract" }], "f")).not.toThrow();
    expect(() => assertJsonSafeObjectArray([], "f")).not.toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => assertJsonSafeObjectArray({ 0: { a: 1 } }, "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSafeObjectArray(null, "f")).toThrow(JsonShapeError);
  });

  it("rejects an array containing a non-plain-object element, with the offending index in the path", () => {
    try {
      assertJsonSafeObjectArray([{ a: 1 }, "not an object"], "evidence");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JsonShapeError);
      expect((err as Error).message).toContain("evidence[1]");
    }
  });

  it("rejects an array element that is itself JSON-unsafe (bigint/function/circular)", () => {
    expect(() => assertJsonSafeObjectArray([{ amountMinor: 5n }], "f")).toThrow(JsonShapeError);
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(() => assertJsonSafeObjectArray([circular], "f")).toThrow(JsonShapeError);
  });
});

describe("assertJsonSerializableValue (earlier: Fact.normalizedValue)", () => {
  it("accepts a string, a number, a boolean, and a plain object — Fact values are polymorphic, unlike every other Json column in this codebase", () => {
    expect(() => assertJsonSerializableValue("Northline Retail Ltd", "f")).not.toThrow();
    expect(() => assertJsonSerializableValue(42, "f")).not.toThrow();
    expect(() => assertJsonSerializableValue(true, "f")).not.toThrow();
    expect(() => assertJsonSerializableValue({ currency: "USD", rail: "ACH" }, "f")).not.toThrow();
  });

  it("rejects null and undefined — an absent Fact is represented by row absence, never a present row holding null", () => {
    expect(() => assertJsonSerializableValue(null, "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSerializableValue(undefined, "f")).toThrow(JsonShapeError);
  });

  it("rejects a bigint and a function, same JSON-unsafe rejection as every other guard in this file", () => {
    expect(() => assertJsonSerializableValue(5n, "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSerializableValue(() => 1, "f")).toThrow(JsonShapeError);
  });

  it("rejects a circular object nested inside the value", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(() => assertJsonSerializableValue(circular, "f")).toThrow(JsonShapeError);
  });

  it("rejects __proto__/constructor/prototype as an object key at any depth (review — defense in depth for a value that ultimately originates from a client-side JSON.parse of free-form Passport Fact input)", () => {
    expect(() => assertJsonSerializableValue(JSON.parse('{"__proto__":{"admin":true}}'), "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSerializableValue(JSON.parse('{"constructor":{"x":1}}'), "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSerializableValue({ nested: { prototype: 1 } }, "f")).toThrow(JsonShapeError);
    expect(() => assertJsonSerializableValue({ safe: "value" }, "f")).not.toThrow();
  });
});
