// packages/crypto/src/receipt.test.ts
//
// Proves acceptance criterion 5: a signed receipt verifies when genuine,
// and an edited/forged receipt (any field tampered, or the signature
// itself tampered, or verified under the wrong key) fails verification —
// both directions actually exercised, not asserted.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type LockboxReceiptPayload, signReceipt, verifyReceipt } from "./receipt.js";

function samplePayload(overrides: Partial<LockboxReceiptPayload> = {}): LockboxReceiptPayload {
  return {
    lockboxId: "01930000-0000-7000-8000-000000000001",
    ciphertextHash: "a".repeat(64),
    sealerOrgId: "01930000-0000-7000-8000-000000000002",
    sealedAt: "2026-08-18T12:00:00.000Z",
    state: "SEALED",
    ...overrides,
  };
}

describe("lockbox receipt sign/verify", () => {
  it("a freshly-signed receipt verifies (acceptance criterion 5, direction 1: genuine passes)", () => {
    const key = randomBytes(32);
    const payload = samplePayload();
    const sig = signReceipt(payload, key);
    expect(verifyReceipt(payload, sig, key)).toBe(true);
  });

  it("signature is deterministic for the same payload+key (HMAC, not randomized)", () => {
    const key = randomBytes(32);
    const payload = samplePayload();
    expect(signReceipt(payload, key)).toBe(signReceipt(payload, key));
  });

  it("signing is insensitive to object key ORDER (canonical encoding)", () => {
    const key = randomBytes(32);
    const a = samplePayload();
    const b: LockboxReceiptPayload = {
      state: a.state,
      sealedAt: a.sealedAt,
      sealerOrgId: a.sealerOrgId,
      ciphertextHash: a.ciphertextHash,
      lockboxId: a.lockboxId,
    };
    expect(signReceipt(a, key)).toBe(signReceipt(b, key));
  });

  it("EACH field, individually tampered, fails verification (acceptance criterion 5, direction 2: forged/edited fails)", () => {
    const key = randomBytes(32);
    const payload = samplePayload();
    const sig = signReceipt(payload, key);

    const fields: Array<keyof LockboxReceiptPayload> = ["lockboxId", "ciphertextHash", "sealerOrgId", "sealedAt", "state"];
    for (const field of fields) {
      const tampered = { ...payload, [field]: payload[field] + "-TAMPERED" };
      expect(verifyReceipt(tampered, sig, key)).toBe(false);
    }
  });

  it("a bit-flipped signature fails verification", () => {
    const key = randomBytes(32);
    const payload = samplePayload();
    const sig = signReceipt(payload, key);
    const sigBytes = Buffer.from(sig, "hex");
    sigBytes[0] = sigBytes[0]! ^ 0xff;
    expect(verifyReceipt(payload, sigBytes.toString("hex"), key)).toBe(false);
  });

  it("a receipt signed under one key does not verify under a different key", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const payload = samplePayload();
    const sig = signReceipt(payload, keyA);
    expect(verifyReceipt(payload, sig, keyB)).toBe(false);
  });

  it("a malformed (non-hex, wrong-length, empty) signature string fails verification without throwing", () => {
    const key = randomBytes(32);
    const payload = samplePayload();
    expect(verifyReceipt(payload, "not-hex-at-all!!", key)).toBe(false);
    expect(verifyReceipt(payload, "ab", key)).toBe(false);
    expect(verifyReceipt(payload, "", key)).toBe(false);
    expect(verifyReceipt(payload, "a".repeat(63), key)).toBe(false); // odd length, not valid hex bytes
  });

  it("different payloads produce different signatures (no truncation/collision) — a full state-value swap flips the signature", () => {
    const key = randomBytes(32);
    const a = signReceipt(samplePayload({ state: "SEALED" }), key);
    const b = signReceipt(samplePayload({ state: "OPENED" }), key);
    expect(a).not.toBe(b);
  });

  it("swapping which value goes in which field (same values, different assignment) produces a different signature", () => {
    const key = randomBytes(32);
    const id = "01930000-0000-7000-8000-00000000000a";
    const orgId = "01930000-0000-7000-8000-00000000000b";
    const a = signReceipt(samplePayload({ lockboxId: id, sealerOrgId: orgId }), key);
    const b = signReceipt(samplePayload({ lockboxId: orgId, sealerOrgId: id }), key); // swapped
    expect(a).not.toBe(b);
  });

  it("verifyReceipt never throws even for a runtime-malformed payload that bypasses TypeScript's static types (e.g. a field that is actually undefined at runtime) — always returns a boolean", () => {
    const key = randomBytes(32);
    // Deliberately bypasses the LockboxReceiptPayload type (which requires
    // every field to be a real string) to prove the RUNTIME robustness
    // fix — a caller crossing an untyped boundary (e.g. JSON parsed from
    // an external system without its own validation) can't crash this
    // function.
    const malformed = { lockboxId: "x", ciphertextHash: "y", sealerOrgId: "z", sealedAt: undefined, state: "SEALED" } as unknown as LockboxReceiptPayload;
    expect(() => verifyReceipt(malformed, "ab".repeat(32), key)).not.toThrow();
    expect(verifyReceipt(malformed, "ab".repeat(32), key)).toBe(false);
  });

  it("signReceipt on a payload with an undefined field does not throw, and does NOT collide with a payload whose field is the literal string 'null'", () => {
    const key = randomBytes(32);
    const withUndefined = { ...samplePayload(), state: undefined } as unknown as LockboxReceiptPayload;
    const withNullString = { ...samplePayload(), state: "null" };
    expect(() => signReceipt(withUndefined, key)).not.toThrow();
    // canonicalJson(undefined) emits the unquoted token `null` (matching
    // JSON's own null literal), while canonicalJson("null") emits the
    // QUOTED string `"null"` (via JSON.stringify) — different bytes, so an
    // `undefined` field can never be forged into matching a payload that
    // legitimately has the string "null" in that field, or vice versa.
    expect(signReceipt(withUndefined, key)).not.toBe(signReceipt(withNullString, key));
  });
});
