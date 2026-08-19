// packages/crypto/src/keys.test.ts

import { describe, expect, it } from "vitest";
import { MissingKeyMaterialError } from "./errors.js";
import { parseKeyHex } from "./keys.js";

describe("parseKeyHex", () => {
  it("parses a valid 64-hex-char string into a 32-byte Buffer", () => {
    const hex = "a".repeat(64);
    const buf = parseKeyHex(hex, "TEST_KEY");
    expect(buf.length).toBe(32);
    expect(buf.toString("hex")).toBe(hex);
  });

  it("trims incidental leading/trailing whitespace (e.g. a trailing newline from .env) before validating", () => {
    const hex = "b".repeat(64);
    expect(parseKeyHex(`${hex}\n`, "TEST_KEY").toString("hex")).toBe(hex);
    expect(parseKeyHex(`  ${hex}  `, "TEST_KEY").toString("hex")).toBe(hex);
    expect(parseKeyHex(`\t${hex}\t`, "TEST_KEY").toString("hex")).toBe(hex);
  });

  it("still rejects internal whitespace (not just leading/trailing) as malformed", () => {
    const half = "c".repeat(32);
    expect(() => parseKeyHex(`${half} ${half}`, "TEST_KEY")).toThrow(MissingKeyMaterialError);
  });

  it("throws MissingKeyMaterialError when undefined", () => {
    expect(() => parseKeyHex(undefined, "TEST_KEY")).toThrow(MissingKeyMaterialError);
  });

  it("throws MissingKeyMaterialError when empty", () => {
    expect(() => parseKeyHex("", "TEST_KEY")).toThrow(MissingKeyMaterialError);
  });

  it("throws when too short", () => {
    expect(() => parseKeyHex("abcd", "TEST_KEY")).toThrow(MissingKeyMaterialError);
  });

  it("throws when too long", () => {
    expect(() => parseKeyHex("a".repeat(65), "TEST_KEY")).toThrow(MissingKeyMaterialError);
  });

  it("throws when non-hex characters are present", () => {
    expect(() => parseKeyHex("z".repeat(64), "TEST_KEY")).toThrow(MissingKeyMaterialError);
  });

  it("error message includes the label but never the (absent/invalid) key material itself", () => {
    try {
      parseKeyHex(undefined, "LOCKBOX_KEK_SEALER");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("LOCKBOX_KEK_SEALER");
    }
    try {
      parseKeyHex("not-valid-hex", "LOCKBOX_KEK_OPERATOR");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("LOCKBOX_KEK_OPERATOR");
      expect((e as Error).message).not.toContain("not-valid-hex");
    }
  });
});
