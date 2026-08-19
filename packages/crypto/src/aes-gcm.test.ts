// packages/crypto/src/aes-gcm.test.ts
//
// Proves acceptance criteria 1 (real AES-256-GCM, fresh IV every call,
// never reused) and 4 (tamper-evidence: any ciphertext/authTag byte flip
// makes decryption throw) with tests that actually execute the real
// Node `crypto` primitives — no simulated/mocked encryption anywhere.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AES_KEY_BYTES, GCM_IV_BYTES, decrypt, encrypt, generateKey } from "./aes-gcm.js";
import { TamperOrWrongKeyError } from "./errors.js";

describe("aes-gcm", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const key = generateKey();
    const plaintext = Buffer.from("the quick brown fox — sensitive lockbox payload", "utf8");
    const { iv, ciphertext, authTag } = encrypt(plaintext, key);
    const decrypted = decrypt({ iv, ciphertext, authTag }, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("generateKey() returns exactly 32 bytes from the platform CSPRNG", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.length).toBe(AES_KEY_BYTES);
    expect(a.equals(b)).toBe(false);
  });

  it("ciphertext is NOT the plaintext (real encryption, not a passthrough)", () => {
    const key = generateKey();
    const plaintext = Buffer.from("this must not appear verbatim in the ciphertext bytes", "utf8");
    const { ciphertext } = encrypt(plaintext, key);
    expect(ciphertext.equals(plaintext)).toBe(false);
    expect(ciphertext.includes(plaintext)).toBe(false);
  });

  it("generates a fresh random IV every call — zero collisions across 10,000 real encryptions of the same plaintext/key (acceptance criterion 1)", () => {
    const key = generateKey();
    const plaintext = Buffer.from("same plaintext every time", "utf8");
    const ivs = new Set<string>();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const { iv } = encrypt(plaintext, key);
      expect(iv.length).toBe(GCM_IV_BYTES);
      ivs.add(iv.toString("hex"));
    }
    expect(ivs.size).toBe(N);
  });

  it("tamper-evidence: flipping ANY single ciphertext byte makes decryption throw TamperOrWrongKeyError (acceptance criterion 4)", () => {
    const key = generateKey();
    const plaintext = Buffer.from("integrity must be enforced", "utf8");
    const { iv, ciphertext, authTag } = encrypt(plaintext, key);

    expect(ciphertext.length).toBeGreaterThan(0);
    for (let byteIdx = 0; byteIdx < ciphertext.length; byteIdx++) {
      const tampered = Buffer.from(ciphertext);
      tampered[byteIdx] = tampered[byteIdx]! ^ 0xff;
      expect(() => decrypt({ iv, ciphertext: tampered, authTag }, key)).toThrow(TamperOrWrongKeyError);
    }
  });

  it("tamper-evidence: flipping any authTag byte makes decryption throw", () => {
    const key = generateKey();
    const plaintext = Buffer.from("tag must also be verified", "utf8");
    const { iv, ciphertext, authTag } = encrypt(plaintext, key);
    for (let byteIdx = 0; byteIdx < authTag.length; byteIdx++) {
      const tampered = Buffer.from(authTag);
      tampered[byteIdx] = tampered[byteIdx]! ^ 0xff;
      expect(() => decrypt({ iv, ciphertext, authTag: tampered }, key)).toThrow(TamperOrWrongKeyError);
    }
  });

  it("TamperOrWrongKeyError preserves the original Node error as .cause for local debugging, without leaking it into .message", () => {
    const key = generateKey();
    const plaintext = Buffer.from("cause chain check", "utf8");
    const { iv, ciphertext, authTag } = encrypt(plaintext, key);
    const tampered = Buffer.from(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    try {
      decrypt({ iv, ciphertext: tampered, authTag }, key);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TamperOrWrongKeyError);
      expect((e as Error).cause).toBeInstanceOf(Error);
      expect((e as Error).message).not.toContain((((e as Error).cause as Error).message));
    }
  });

  it("decrypting with the WRONG key throws, never returns garbage silently accepted as plaintext", () => {
    const key = generateKey();
    const wrongKey = generateKey();
    const plaintext = Buffer.from("wrong key must fail closed", "utf8");
    const { iv, ciphertext, authTag } = encrypt(plaintext, key);
    expect(() => decrypt({ iv, ciphertext, authTag }, wrongKey)).toThrow(TamperOrWrongKeyError);
  });

  it("decrypting with a different IV than the one produced at encryption time throws", () => {
    const key = generateKey();
    const plaintext = Buffer.from("iv is part of the authenticated context", "utf8");
    const { ciphertext, authTag } = encrypt(plaintext, key);
    const wrongIv = randomBytes(GCM_IV_BYTES);
    expect(() => decrypt({ iv: wrongIv, ciphertext, authTag }, key)).toThrow(TamperOrWrongKeyError);
  });

  it("AAD binds ciphertext to context: missing or wrong AAD at decrypt time throws; matching AAD succeeds", () => {
    const key = generateKey();
    const plaintext = Buffer.from("bound to a specific lockbox id", "utf8");
    const aad = Buffer.from("lockbox-123", "utf8");
    const { iv, ciphertext, authTag } = encrypt(plaintext, key, aad);

    expect(() => decrypt({ iv, ciphertext, authTag }, key)).toThrow(TamperOrWrongKeyError);
    expect(() => decrypt({ iv, ciphertext, authTag }, key, Buffer.from("lockbox-456"))).toThrow(TamperOrWrongKeyError);

    const decrypted = decrypt({ iv, ciphertext, authTag }, key, aad);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("rejects a key that isn't exactly 32 bytes, on both encrypt and decrypt", () => {
    expect(() => encrypt(Buffer.from("x"), Buffer.alloc(16))).toThrow(RangeError);
    expect(() => encrypt(Buffer.from("x"), Buffer.alloc(64))).toThrow(RangeError);
    const key = generateKey();
    const { iv, ciphertext, authTag } = encrypt(Buffer.from("x"), key);
    expect(() => decrypt({ iv, ciphertext, authTag }, Buffer.alloc(16))).toThrow(RangeError);
  });

  it("handles empty plaintext", () => {
    const key = generateKey();
    const { iv, ciphertext, authTag } = encrypt(Buffer.alloc(0), key);
    const decrypted = decrypt({ iv, ciphertext, authTag }, key);
    expect(decrypted.length).toBe(0);
  });

  it("handles large plaintext (1 MB)", () => {
    const key = generateKey();
    const plaintext = randomBytes(1024 * 1024);
    const { iv, ciphertext, authTag } = encrypt(plaintext, key);
    const decrypted = decrypt({ iv, ciphertext, authTag }, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("two encryptions of different plaintexts under the same key never produce the same ciphertext", () => {
    const key = generateKey();
    const { ciphertext: c1 } = encrypt(Buffer.from("payload A"), key);
    const { ciphertext: c2 } = encrypt(Buffer.from("payload B"), key);
    expect(c1.equals(c2)).toBe(false);
  });
});
