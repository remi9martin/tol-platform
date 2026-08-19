// packages/crypto/src/gf256.ts
//
// GF(2^8) finite-field arithmetic (reduction polynomial x^8+x^4+x^3+x+1 =
// 0x11B — the same field AES itself uses for MixColumns) — the arithmetic
// Shamir Secret Sharing (shamir.ts) runs its polynomial evaluation and
// Lagrange interpolation over. This is NOT an encryption primitive; it is
// the standard, well-documented finite field every textbook/production
// Shamir implementation (HashiCorp Vault's `shamir` package, the classic
// `ssss` tool, PGP's SSSS) uses for exactly this purpose. The only place
// actual confidentiality/integrity work happens in this package is
// AES-256-GCM (aes-gcm.ts, via Node's built-in `crypto`) — this module
// only supplies the field arithmetic Shamir splits/combines a key over; it
// never encrypts anything itself. See docs/adr/0009-lockbox-crypto.md.
//
// Log/exp tables (built once, at module load) make multiply/divide O(1)
// instead of a slower per-call reduction loop, and — more importantly for
// review — make the arithmetic easy to verify against a reference: every
// nonzero element must appear exactly once in EXP[0..254] (generator 3 is
// primitive over this field), and LOG must be EXP's exact inverse.
// gf256.test.ts checks both directly, plus cross-checks gfMul against an
// independently-written peasant-multiplication reference for all 65,536
// byte pairs.

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);

/**
 * Doubles `x` in GF(2^8)/(x^8+x^4+x^3+x+1) — i.e. multiplies by the field
 * element "2". Shifting left by one bit can overflow into bit 8 exactly
 * when the original value's bit 7 was set; when it does, XOR with the
 * FULL 9-bit reduction polynomial 0x11B (not just its low byte 0x1B) so
 * bit 8 cancels via XOR and the result is already a clean 8-bit value —
 * a common off-by-one in naive implementations is XORing with 0x1B
 * instead of 0x11B, which fails to clear bit 8.
 */
function xtime(x: number): number {
  const shifted = x << 1;
  return (x & 0x80) !== 0 ? (shifted ^ 0x11b) & 0xff : shifted & 0xff;
}

// Build EXP/LOG tables using generator g=3 (a primitive element of this
// field: repeated multiplication by 3 starting from 1 visits all 255
// nonzero elements before returning to 1). 3*x = 2*x XOR x = xtime(x) XOR x
// (distributivity: 3 = 2 XOR 1 as field elements, and multiplication
// distributes over addition/XOR in this field).
(function buildTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = xtime(x) ^ x;
  }
  // EXP[255] is intentionally left at its Uint8Array default (0) and never
  // written here. gfMul/gfDiv below only ever index EXP via `(... ) % 255`,
  // whose result is provably always in [0, 254] (LOG values populated above
  // are themselves always in [0, 254], and 254 + 254 = 508, 508 % 255 =
  // 253) — index 255 is structurally unreachable through the public API, so
  // giving it a value (e.g. aliasing it to EXP[0]) would be dead code that
  // invites exactly the "what does index 255 mean" question a prior
  // review raised, for a branch that can never execute. Verified
  // exhaustively, not just by this argument: gf256.test.ts cross-checks
  // gfMul against an independent reference implementation for all 65,536
  // byte pairs.
})();

/** a + b in GF(256). Addition (and subtraction) is XOR in a characteristic-2 field — there is no separate gfSub because a - b === a + b === a ^ b here. */
export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

/** a * b in GF(256) via the log/exp tables built above. Returns 0 if either operand is 0 (log(0) is undefined; handled as a special case, not looked up). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}

/** a / b in GF(256). Throws RangeError if b === 0 — Shamir's share x-coordinates are always nonzero by construction (see shamir.ts), so a caller hitting this indicates a real bug (e.g. duplicate share indices reaching interpolation), not a normal runtime condition to recover from silently. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("gfDiv: division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

/** Exposed for tests only — lets gf256.test.ts verify the tables' internal consistency (every nonzero byte appears exactly once, LOG is EXP's true inverse) directly, rather than only indirectly through gfMul/gfDiv's behavior. */
export function _debugTables(): { exp: Uint8Array; log: Uint8Array } {
  return { exp: EXP, log: LOG };
}
