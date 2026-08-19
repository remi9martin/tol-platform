// packages/crypto/src/shamir.test.ts
//
// Proves the Shamir threshold property directly (acceptance criterion 3):
// any `threshold` shares reconstruct the exact original secret; fewer
// than `threshold` either throw (structural guard) or, when combined
// anyway via a lower-threshold split for comparison, produce a WRONG
// result — never the real secret. Also proves the information-theoretic
// "a single share alone determines nothing" property constructively for
// the threshold-2 case, not just by assertion.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InsufficientSharesError } from "./errors.js";
import { gfAdd, gfDiv, gfMul } from "./gf256.js";
import { combineShares, splitSecret, type ShamirShare } from "./shamir.js";

function pick(shares: ShamirShare[], indices: number[]): ShamirShare[] {
  return indices.map((i) => shares[i]!);
}

describe("shamir secret sharing", () => {
  it("round-trips a 32-byte secret with exactly threshold shares (2-of-3)", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 2, 3);
    expect(shares).toHaveLength(3);
    const reconstructed = combineShares(pick(shares, [0, 1]));
    expect(reconstructed.equals(secret)).toBe(true);
  });

  it("EVERY pairwise subset of 2-of-3 shares reconstructs the identical original secret", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 2, 3);
    for (const pair of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const reconstructed = combineShares(pick(shares, pair));
      expect(reconstructed.equals(secret)).toBe(true);
    }
  });

  it("reconstruction is independent of share ORDER in the input array (Lagrange interpolation is a commutative sum — a review claimed ordering matters; it provably doesn't)", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 2, 3);
    const [a, b] = pick(shares, [0, 1]);
    const forward = combineShares([a!, b!]);
    const reversed = combineShares([b!, a!]);
    expect(forward.equals(secret)).toBe(true);
    expect(reversed.equals(secret)).toBe(true);
    expect(forward.equals(reversed)).toBe(true);
    // Also check the 3-share case in every permutation.
    const [x, y, z] = shares;
    const perms = [
      [x!, y!, z!],
      [x!, z!, y!],
      [y!, x!, z!],
      [y!, z!, x!],
      [z!, x!, y!],
      [z!, y!, x!],
    ];
    for (const perm of perms) {
      expect(combineShares(perm).equals(secret)).toBe(true);
    }
  });

  it("all 3 shares together also reconstruct correctly (more than threshold is fine)", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 2, 3);
    expect(combineShares(shares).equals(secret)).toBe(true);
  });

  it("combineShares rejects a single share outright (below the 2-share structural minimum)", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 2, 3);
    expect(() => combineShares([shares[0]!])).toThrow(InsufficientSharesError);
  });

  it("a single share is consistent with EVERY possible secret byte value — perfect secrecy, t=2 case, proven constructively", () => {
    // For threshold 2, a share is (x, y) where y = secretByte XOR
    // gfMul(a1, x) for some (to a holder of only this one share, unknown)
    // coefficient a1. This test proves that for a FIXED (x, y) pair,
    // every one of the 256 possible secret-byte values has SOME a1 that
    // reproduces exactly that (x, y) pair — i.e. the share alone is
    // mathematically consistent with all 256 possible secrets, not just
    // the real one. That is the perfect-secrecy property Shamir's scheme
    // provides for any set of shares below threshold.
    const secret = randomBytes(1);
    const shares = splitSecret(secret, 2, 3);
    const { index: x, ys } = shares[0]!;
    const y = ys[0]!;

    for (let candidate = 0; candidate < 256; candidate++) {
      // solve: candidate XOR gfMul(a1, x) = y  =>  a1 = (y XOR candidate) / x
      const a1 = gfDiv(gfAdd(y, candidate), x);
      const reproduced = gfAdd(candidate, gfMul(a1, x));
      expect(reproduced).toBe(y); // every candidate secret byte is achievable — the share alone determines nothing
    }
  });

  it("reconstructing with fewer than the TRUE threshold (3-of-5 scheme, only 2 shares combined) produces WRONG output, not the original secret", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 3, 5);
    const under = pick(shares, [0, 1]); // 2 shares, below this split's threshold of 3
    const wrong = combineShares(under);
    expect(wrong.equals(secret)).toBe(false);
  });

  it("a 3-of-5 scheme correctly reconstructs once the true threshold (3) is met", () => {
    const secret = randomBytes(32);
    const shares = splitSecret(secret, 3, 5);
    expect(combineShares(pick(shares, [0, 1, 2])).equals(secret)).toBe(true);
    expect(combineShares(pick(shares, [1, 3, 4])).equals(secret)).toBe(true);
  });

  it("mixing shares from TWO DIFFERENT splits of same-length secrets reconstructs garbage, not either original secret", () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const sharesA = splitSecret(secretA, 2, 3);
    const sharesB = splitSecret(secretB, 2, 3);
    const mixed = [sharesA[0]!, sharesB[1]!];
    const result = combineShares(mixed);
    expect(result.equals(secretA)).toBe(false);
    expect(result.equals(secretB)).toBe(false);
  });

  it("rejects threshold < 2", () => {
    expect(() => splitSecret(randomBytes(16), 1, 3)).toThrow(RangeError);
    expect(() => splitSecret(randomBytes(16), 0, 3)).toThrow(RangeError);
  });

  it("rejects n < threshold", () => {
    expect(() => splitSecret(randomBytes(16), 3, 2)).toThrow(RangeError);
  });

  it("rejects n > 255", () => {
    expect(() => splitSecret(randomBytes(16), 2, 256)).toThrow(RangeError);
  });

  it("rejects an empty secret", () => {
    expect(() => splitSecret(Buffer.alloc(0), 2, 3)).toThrow(RangeError);
  });

  it("combineShares rejects duplicate share indices (would divide by zero in Lagrange interpolation)", () => {
    const secret = randomBytes(16);
    const shares = splitSecret(secret, 2, 3);
    const dup = [shares[0]!, { index: shares[0]!.index, ys: shares[1]!.ys }];
    expect(() => combineShares(dup)).toThrow(InsufficientSharesError);
  });

  it("combineShares rejects shares with mismatched ys length", () => {
    const shareA: ShamirShare = { index: 1, ys: Buffer.alloc(4) };
    const shareB: ShamirShare = { index: 2, ys: Buffer.alloc(8) };
    expect(() => combineShares([shareA, shareB])).toThrow(InsufficientSharesError);
  });

  it("two independent splits of the SAME secret produce DIFFERENT shares (fresh CSPRNG coefficients every call, not deterministic)", () => {
    const secret = randomBytes(32);
    const sharesRun1 = splitSecret(secret, 2, 3);
    const sharesRun2 = splitSecret(secret, 2, 3);
    expect(sharesRun1[0]!.ys.equals(sharesRun2[0]!.ys)).toBe(false);
  });

  it("round-trips across many random secrets and share subsets (stress/regression)", () => {
    for (let trial = 0; trial < 200; trial++) {
      const secret = randomBytes(32);
      const shares = splitSecret(secret, 2, 3);
      const subset = trial % 2 === 0 ? [0, 1] : [1, 2];
      const reconstructed = combineShares(pick(shares, subset));
      expect(reconstructed.equals(secret)).toBe(true);
    }
  });

  it("handles a 1-byte secret and a large (4096-byte) secret, not just the 32-byte DEK case", () => {
    const tiny = randomBytes(1);
    const tinyShares = splitSecret(tiny, 2, 3);
    expect(combineShares(pick(tinyShares, [0, 2])).equals(tiny)).toBe(true);

    const large = randomBytes(4096);
    const largeShares = splitSecret(large, 2, 3);
    expect(combineShares(pick(largeShares, [1, 2])).equals(large)).toBe(true);
  });
});
