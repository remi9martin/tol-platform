// packages/crypto/src/aes-gcm.ts
//
// Real authenticated encryption: AES-256-GCM via Node's built-in `crypto`
// module — not a home-rolled cipher, not an unauthenticated mode (no ECB,
// no plain CBC). This package runs server-side (apps/api's lockbox
// service calls it directly; see docs/adr/0009-lockbox-crypto.md for why
// server-side Node `crypto` was chosen over browser Web Crypto for this
// build). A fresh random 96-bit IV is generated on every `encrypt()` call
// and is NEVER reused under the same key (acceptance criterion 1) — the
// IV is returned alongside the ciphertext for the caller to persist; it
// is never derived, cached, or reused across calls.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TamperOrWrongKeyError } from "./errors.js";

export const AES_KEY_BYTES = 32; // 256-bit key
export const GCM_IV_BYTES = 12; // 96-bit — NIST SP 800-38D's recommended IV length for GCM
export const GCM_AUTH_TAG_BYTES = 16; // 128-bit

export interface AesGcmCiphertext {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

/** Generates a fresh random 256-bit key from the platform CSPRNG. Used for both DEKs and share-wrapping KEKs — same primitive, different caller-assigned role. */
export function generateKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

/**
 * Encrypts `plaintext` under `key` (must be exactly 32 bytes) with a
 * freshly-generated random IV — a new call to `crypto.randomBytes`, every
 * single invocation, no exceptions. `aad` (additional authenticated data,
 * e.g. a lockbox's own ID) is authenticated but not encrypted: it binds
 * this specific ciphertext to a specific record so it can't be silently
 * swapped onto a different row even if both happened to decrypt under the
 * same key.
 */
export function encrypt(plaintext: Buffer, key: Buffer, aad?: Buffer): AesGcmCiphertext {
  assertKeyLength(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, ciphertext, authTag };
}

/**
 * Decrypts and verifies. Throws `TamperOrWrongKeyError` if the auth tag
 * doesn't match — this single failure signal covers both "ciphertext/IV/
 * authTag/AAD was tampered with" (acceptance criterion 4) and "the key
 * was wrong" (e.g. a DEK reconstructed from an under-threshold set of
 * Shamir shares, acceptance criterion 3); see errors.ts for why that's a
 * deliberate design choice, not a gap. Never returns partial or
 * best-effort plaintext on failure — `Buffer.concat` only runs if
 * `decipher.final()` didn't throw, and `final()` is exactly where GCM's
 * own tag check lives.
 */
export function decrypt(input: AesGcmCiphertext, key: Buffer, aad?: Buffer): Buffer {
  assertKeyLength(key);
  if (input.authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new TamperOrWrongKeyError("malformed authTag length");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, input.iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(input.authTag);
  try {
    return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
  } catch (cause) {
    // Node's native error here is a generic, implementation-specific
    // string ("Unsupported state or unable to authenticate data") —
    // normalized to our own typed error so callers never need to
    // string-match Node's message, and so the failure reason (tamper vs.
    // wrong key) is never distinguishable to a caller by error text —
    // deliberately, per errors.ts's doc comment. The original Node error
    // is preserved as `.cause` (not swallowed) purely for local debugging
    // — it is never included in the thrown error's own `.message`, so it
    // never reaches a caller that only logs/displays `.message`.
    throw new TamperOrWrongKeyError(undefined, { cause });
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== AES_KEY_BYTES) {
    throw new RangeError(`AES-256-GCM key must be exactly ${AES_KEY_BYTES} bytes, got ${key.length}`);
  }
}
