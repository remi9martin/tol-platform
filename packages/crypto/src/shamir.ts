// packages/crypto/src/shamir.ts
//
// Shamir (t, n)-threshold secret sharing over GF(256) (gf256.ts) — splits
// an arbitrary-length secret (here: a 32-byte AES-256 DEK, see envelope.ts)
// into `n` shares such that any `t` of them reconstruct the secret
// exactly, and any (t-1) reveal NO information about it at all
// (information-theoretic security, not merely computationally hard) —
// the "no single stored value can decrypt a sealed payload alone" property
// acceptance criterion 3 asks for, made "literally real" rather than an
// access-control convention layered on top of one key.
//
// This is a standard, well-specified algorithm (Shamir, 1979) — the same
// one HashiCorp Vault's `shamir` Go package and the classic `ssss` tool
// implement — not a novel or home-rolled cryptographic primitive. The
// only place actual confidentiality/integrity work happens in this system
// is AES-256-GCM (aes-gcm.ts, via Node's built-in `crypto`); this module
// only splits an already-securely-generated key, it never encrypts
// anything by itself. See docs/adr/0009-lockbox-crypto.md for the
// Shamir-vs-dual-KEK tradeoff record.
//
// Per-byte polynomial evaluation: for an n-byte secret, each byte position
// gets its OWN independent random polynomial of degree (t-1) over GF(256);
// a share is (x, [f_0(x), f_1(x), ..., f_{n-1}(x)]) — one shared
// x-coordinate (the share index) plus one y-value per secret byte.

import { randomBytes } from "node:crypto";
import { InsufficientSharesError } from "./errors.js";
import { gfAdd, gfDiv, gfMul } from "./gf256.js";

export interface ShamirShare {
  /** x-coordinate, 1..255. Never 0 — f(0) IS the secret, so a share at x=0 would leak it directly rather than being a genuine share. */
  index: number;
  /** y-values, one per secret byte, at this share's x-coordinate. */
  ys: Buffer;
}

/**
 * Splits `secret` into `n` shares, any `threshold` of which reconstruct it.
 *
 * `threshold` must be >= 2 — threshold 1 needs no polynomial (a degree-0
 * "polynomial" is just the secret itself) and provides none of the
 * secret-sharing security property this module exists for, so it is
 * rejected rather than silently accepted as a degenerate case. `n` must
 * be between `threshold` and 255 inclusive (x-coordinates are single
 * nonzero bytes).
 *
 * Coefficient randomness comes from `crypto.randomBytes` (a CSPRNG) —
 * NEVER `Math.random()`. This is the one place in the whole scheme where
 * weak randomness would be catastrophic: a predictable coefficient makes
 * the polynomial (and therefore the secret) recoverable from fewer than
 * `threshold` shares.
 */
export function splitSecret(secret: Buffer, threshold: number, n: number): ShamirShare[] {
  if (threshold < 2) {
    throw new RangeError(
      `splitSecret: threshold must be >= 2 (got ${threshold}) — threshold 1 provides no secret-sharing security property`,
    );
  }
  if (n < threshold) {
    throw new RangeError(`splitSecret: n (${n}) must be >= threshold (${threshold})`);
  }
  if (n > 255) {
    throw new RangeError(`splitSecret: n must be <= 255 (share x-coordinates are single nonzero bytes), got ${n}`);
  }
  if (secret.length === 0) {
    throw new RangeError("splitSecret: secret must be non-empty");
  }

  const shares: ShamirShare[] = [];
  for (let shareIdx = 1; shareIdx <= n; shareIdx++) {
    shares.push({ index: shareIdx, ys: Buffer.alloc(secret.length) });
  }

  // One independent random polynomial per secret byte position — f(x) =
  // secret_byte + a_1*x + a_2*x^2 + ... + a_{t-1}*x^{t-1}, all in GF(256).
  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const secretByte = secret[byteIdx]!;
    const coeffs = randomBytes(threshold - 1); // a_1 .. a_{t-1}; a_0 is secretByte itself, never separately randomized

    for (const share of shares) {
      let y = secretByte; // a_0 * x^0
      let xPow = 1;
      for (let c = 0; c < coeffs.length; c++) {
        xPow = gfMul(xPow, share.index);
        y = gfAdd(y, gfMul(coeffs[c]!, xPow));
      }
      share.ys[byteIdx] = y;
    }
  }

  return shares;
}

/**
 * Reconstructs the secret from >= 2 shares via Lagrange interpolation at
 * x=0: secret = sum_i y_i * L_i(0), where
 * L_i(0) = product_{j != i} x_j / (x_j - x_i), all in GF(256) (subtraction
 * = XOR = addition in this field, so `x_j - x_i` is computed as `gfAdd`).
 *
 * Throws InsufficientSharesError for structural input problems (fewer
 * than 2 shares, mismatched secret lengths, or duplicate x-coordinates —
 * the last of which would divide by zero in the denominator above) —
 * checked BEFORE any interpolation runs.
 *
 * Deliberately does NOT verify the result is "correct" beyond the math
 * itself: combining fewer than the true original threshold's worth of
 * shares (impossible to detect from the shares alone — see
 * gf256/shamir.test.ts's "single share is consistent with every possible
 * secret" test for why), or shares from a different split, produces a
 * WRONG but well-formed byte string, not a thrown error here. That is
 * intentional — envelope.ts always feeds this function's output straight
 * into AES-GCM decryption, whose auth-tag check is what actually detects
 * "wrong key" (see errors.ts's TamperOrWrongKeyError doc comment for why
 * collapsing "tampered ciphertext" and "wrong/insufficient-shares key"
 * into one fail-closed signal is the correct design, not a missed check).
 */
export function combineShares(shares: ShamirShare[]): Buffer {
  if (shares.length < 2) {
    throw new InsufficientSharesError(`combineShares: need at least 2 shares, got ${shares.length}`);
  }
  const secretLength = shares[0]!.ys.length;
  for (const s of shares) {
    if (s.ys.length !== secretLength) {
      throw new InsufficientSharesError("combineShares: all shares must encode the same secret length");
    }
    if (s.index === 0 || s.index > 255) {
      throw new InsufficientSharesError(`combineShares: share index out of range (1..255): ${s.index}`);
    }
  }
  const indexes = shares.map((s) => s.index);
  if (new Set(indexes).size !== indexes.length) {
    throw new InsufficientSharesError("combineShares: duplicate share index — cannot interpolate (division by zero)");
  }

  const secret = Buffer.alloc(secretLength);

  for (let byteIdx = 0; byteIdx < secretLength; byteIdx++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      const xi = shares[i]!.index;
      const yi = shares[i]!.ys[byteIdx]!;

      // L_i(0) = product_{j != i} x_j / (x_j XOR x_i)
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (j === i) continue;
        const xj = shares[j]!.index;
        num = gfMul(num, xj);
        den = gfMul(den, gfAdd(xj, xi));
      }
      const li0 = gfDiv(num, den);
      acc = gfAdd(acc, gfMul(yi, li0));
    }
    secret[byteIdx] = acc;
  }

  return secret;
}
