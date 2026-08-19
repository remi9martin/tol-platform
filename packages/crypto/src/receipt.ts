// packages/crypto/src/receipt.ts
//
// Signed Lockbox receipt: HMAC-SHA256 over a canonical encoding of
// {lockboxId, ciphertextHash, sealerOrgId, sealedAt, state} (acceptance
// criterion 5). HMAC rather than Ed25519 because this is a
// single-issuer signature (the platform signs; the platform, or anyone
// the platform shares the HMAC key with for verification purposes,
// verifies) — no asymmetric key distribution to an independent
// public-verifying third party is needed for this MVP pass. See
// docs/adr/0009-lockbox-crypto.md for the HMAC-vs-Ed25519 tradeoff
// record.
//
// Canonical encoding matters for a signature scheme: signing and
// verifying must hash EXACTLY the same bytes for the same logical
// payload regardless of a caller's object-literal key order.
// `canonicalJson` recursively sorts object keys before stringifying —
// this stops a semantically-identical-but-differently-ordered payload
// object from spuriously failing verification, and (the security-relevant
// direction) stops two genuinely DIFFERENT payloads from ever being
// serialized to the same string.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface LockboxReceiptPayload {
  lockboxId: string;
  /** sha256(ciphertext), hex — NEVER plaintext or DEK/share material (acceptance criterion 9). */
  ciphertextHash: string;
  sealerOrgId: string;
  /** ISO 8601. */
  sealedAt: string;
  state: string;
}

function canonicalJson(value: unknown): string {
  // `undefined` is handled explicitly (not left to fall through to
  // `JSON.stringify`, which returns the `undefined` *value* rather than a
  // string for this one input) — that value would otherwise be silently
  // coerced to the unquoted text `undefined` by the template literals
  // below wherever it's interpolated, which is deterministic but easy to
  // misread as a bug. Mapped to the literal string "null" instead: a
  // canonical, unambiguous, valid-JSON placeholder distinct from every
  // real string field `LockboxReceiptPayload` ever holds.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Signs `payload` with HMAC-SHA256 under `hmacKey` (32+ bytes). Returns the hex-encoded signature — persisted as `LockboxReceipt.signature` (packages/db). */
export function signReceipt(payload: LockboxReceiptPayload, hmacKey: Buffer): string {
  const canonical = canonicalJson(payload);
  return createHmac("sha256", hmacKey).update(canonical).digest("hex");
}

/**
 * Verifies `signature` against `payload` under `hmacKey` using a
 * constant-time comparison (`timingSafeEqual`) — a naive `===` string
 * compare would leak how many leading bytes matched via response timing,
 * a real (if narrow) side channel for any endpoint that verifies a
 * caller-supplied receipt. Returns `false` for ANY mismatch, including a
 * malformed or wrong-length signature string — never throws — so callers
 * get one simple boolean to branch on.
 */
export function verifyReceipt(payload: LockboxReceiptPayload, signature: string, hmacKey: Buffer): boolean {
  // The ENTIRE body runs inside one try/catch, not just the signature-hex
  // parsing — `signReceipt` itself is included so that if a future caller
  // ever passes a malformed (non-typechecked, e.g. from an untyped JSON
  // boundary) payload that trips something inside canonicalJson/createHmac,
  // this function still honors its documented "never throws, always
  // returns a boolean" contract rather than propagating an exception past
  // its own API surface.
  try {
    const expected = signReceipt(payload, hmacKey);
    const expectedBuf = Buffer.from(expected, "hex");
    if (!/^[0-9a-fA-F]*$/.test(signature) || signature.length % 2 !== 0) return false;
    const actualBuf = Buffer.from(signature, "hex");
    if (actualBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}
