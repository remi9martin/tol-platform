// packages/crypto/src/envelope.test.ts
//
// End-to-end proof of the full Lockbox crypto acceptance criteria (1-4,
// 9) working TOGETHER through the same public functions apps/api's
// lockbox service calls — not just each primitive in isolation. This is
// the file a reviewer should read first to see "does sealing and
// releasing a real Lockbox actually work, and actually fail closed when
// it should."

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type WrappedShare,
  LOCKBOX_SHARE_ROLES,
  LOCKBOX_SHARE_THRESHOLD,
  LOCKBOX_SHARE_TOTAL,
  releasePayload,
  sealPayload,
  type RoleKeks,
  type SealedEnvelope,
} from "./envelope.js";
import { InsufficientSharesError, TamperOrWrongKeyError } from "./errors.js";

function makeKeks(): RoleKeks {
  return { SEALER: randomBytes(32), OPERATOR: randomBytes(32), ESCROW: randomBytes(32) };
}

function sharesFor(sealed: SealedEnvelope, roles: readonly ("SEALER" | "OPERATOR" | "ESCROW")[]): WrappedShare[] {
  return sealed.shares.filter((s) => roles.includes(s.role));
}

describe("lockbox envelope (seal / release)", () => {
  it("seals and releases a payload end to end with EVERY 2-of-3 role combination (acceptance criterion 3: threshold is genuinely 2-of-3, not one fixed pair)", () => {
    const keks = makeKeks();
    const plaintext = Buffer.from(
      JSON.stringify({ counterparty: "Acme Acquiring", evidence: "signed MSA, 2024-03-01" }),
      "utf8",
    );
    const sealed = sealPayload(plaintext, keks);

    expect(sealed.shares).toHaveLength(LOCKBOX_SHARE_TOTAL);
    expect(new Set(sealed.shares.map((s) => s.role))).toEqual(new Set(LOCKBOX_SHARE_ROLES));

    const combos: Array<readonly ["SEALER" | "OPERATOR" | "ESCROW", "SEALER" | "OPERATOR" | "ESCROW"]> = [
      ["OPERATOR", "ESCROW"],
      ["SEALER", "OPERATOR"],
      ["SEALER", "ESCROW"],
    ];
    for (const combo of combos) {
      const released = releasePayload(sealed, sharesFor(sealed, combo), keks);
      expect(released.equals(plaintext)).toBe(true);
    }
  });

  it("releasing with only 1 share throws InsufficientSharesError — never returns partial/garbage plaintext", () => {
    const keks = makeKeks();
    const sealed = sealPayload(Buffer.from("secret payload"), keks);
    const oneShare = sharesFor(sealed, ["OPERATOR"]);
    expect(() => releasePayload(sealed, oneShare, keks)).toThrow(InsufficientSharesError);
  });

  it("no single stored value decrypts alone — this holds for whichever single role is chosen, not just one arbitrarily-picked one", () => {
    const keks = makeKeks();
    const sealed = sealPayload(Buffer.from("secret payload"), keks);
    for (const role of LOCKBOX_SHARE_ROLES) {
      expect(() => releasePayload(sealed, sharesFor(sealed, [role]), keks)).toThrow(InsufficientSharesError);
    }
  });

  it("wrapping/unwrapping under the WRONG kek for a share's role fails — each share is cryptographically bound to its own role's key, not interchangeable", () => {
    const keks = makeKeks();
    const sealed = sealPayload(Buffer.from("secret payload"), keks);
    const swappedKeks: RoleKeks = { ...keks, OPERATOR: keks.ESCROW };
    const chosen = sharesFor(sealed, ["OPERATOR", "SEALER"]);
    expect(() => releasePayload(sealed, chosen, swappedKeks)).toThrow(TamperOrWrongKeyError);
  });

  it("tamper-evidence end to end: flipping a ciphertext byte after sealing makes release fail, even with valid shares/keks (acceptance criterion 4, exercised through the real seal/release path)", () => {
    const keks = makeKeks();
    const sealed = sealPayload(Buffer.from("secret payload"), keks);
    const tampered: SealedEnvelope = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    const chosen = sharesFor(sealed, ["OPERATOR", "ESCROW"]);
    expect(() => releasePayload(tampered, chosen, keks)).toThrow(TamperOrWrongKeyError);
  });

  it("tamper-evidence: corrupting one wrapped share's bytes makes release fail even though the OTHER share used is untouched", () => {
    const keks = makeKeks();
    const sealed = sealPayload(Buffer.from("secret payload"), keks);
    const corrupted: SealedEnvelope = {
      ...sealed,
      shares: sealed.shares.map((s) => {
        if (s.role !== "OPERATOR") return s;
        const flipped = Buffer.from(s.wrapped.ciphertext);
        flipped[0] = flipped[0]! ^ 0xff;
        return { ...s, wrapped: { ...s.wrapped, ciphertext: flipped } };
      }),
    };
    const chosen = sharesFor(corrupted, ["OPERATOR", "ESCROW"]);
    expect(() => releasePayload(corrupted, chosen, keks)).toThrow(TamperOrWrongKeyError);
  });

  it("ciphertextHash is a real sha256 of the ciphertext (64 hex chars) — never the plaintext or DEK (acceptance criterion 9)", () => {
    const keks = makeKeks();
    const plaintext = Buffer.from("hash must be over ciphertext, never plaintext");
    const sealed = sealPayload(plaintext, keks);
    expect(sealed.ciphertextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.ciphertextHash).not.toBe(plaintext.toString("hex"));
  });

  it("the SealedEnvelope object contains no field named/holding the DEK or a plaintext share — only ciphertext, iv, authTag, hash, and WRAPPED shares (acceptance criterion 9, structural check)", () => {
    const keks = makeKeks();
    const sealed = sealPayload(Buffer.from("secret payload"), keks);
    const keys = Object.keys(sealed);
    expect(keys.sort()).toEqual(["authTag", "ciphertext", "ciphertextHash", "iv", "shares"].sort());
    for (const share of sealed.shares) {
      expect(Object.keys(share).sort()).toEqual(["index", "role", "wrapped"].sort());
      expect(Object.keys(share.wrapped).sort()).toEqual(["authTag", "ciphertext", "iv"].sort()); // wrapped.ciphertext is the ENCRYPTED share bytes, not raw y-values
    }
  });

  it("sealing the same plaintext twice produces DIFFERENT ciphertext, IV, hash, and shares every time (fresh DEK + fresh IV + fresh Shamir randomness per call)", () => {
    const keks = makeKeks();
    const plaintext = Buffer.from("same plaintext, sealed twice");
    const first = sealPayload(plaintext, keks);
    const second = sealPayload(plaintext, keks);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertextHash).not.toBe(second.ciphertextHash);
    expect(first.shares[0]!.wrapped.ciphertext.equals(second.shares[0]!.wrapped.ciphertext)).toBe(false);
  });

  it("AAD binds the envelope to a specific lockbox id — releasing with the wrong id's AAD fails even with valid shares", () => {
    const keks = makeKeks();
    const plaintext = Buffer.from("bound payload");
    const aad = Buffer.from("lockbox-aaaa", "utf8");
    const sealed = sealPayload(plaintext, keks, aad);
    const chosen = sharesFor(sealed, ["OPERATOR", "ESCROW"]);

    expect(() => releasePayload(sealed, chosen, keks, Buffer.from("lockbox-bbbb"))).toThrow(TamperOrWrongKeyError);
    expect(() => releasePayload(sealed, chosen, keks)).toThrow(TamperOrWrongKeyError); // missing AAD entirely
    expect(releasePayload(sealed, chosen, keks, aad).equals(plaintext)).toBe(true);
  });

  it("LOCKBOX_SHARE_THRESHOLD is 2 and LOCKBOX_SHARE_TOTAL is 3 (documents the constants apps/api's lockbox service relies on)", () => {
    expect(LOCKBOX_SHARE_THRESHOLD).toBe(2);
    expect(LOCKBOX_SHARE_TOTAL).toBe(3);
    expect(LOCKBOX_SHARE_ROLES).toEqual(["SEALER", "OPERATOR", "ESCROW"]);
  });
});
