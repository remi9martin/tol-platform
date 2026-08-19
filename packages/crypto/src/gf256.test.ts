// packages/crypto/src/gf256.test.ts
//
// Exhaustively verifies the GF(256) field arithmetic Shamir Secret
// Sharing depends on for correctness. gfMul is cross-checked against an
// INDEPENDENTLY-implemented reference (peasant multiplication with
// explicit polynomial reduction) for all 65,536 byte pairs — deliberately
// not sharing any code with gf256.ts's own xtime()/table-build logic, so
// a bug in one implementation is very unlikely to be mirrored in the
// other.

import { describe, expect, it } from "vitest";
import { _debugTables, gfAdd, gfDiv, gfMul } from "./gf256.js";

/** Independent reference multiplication — schoolbook/peasant multiply-and-reduce, NOT log/exp tables. Test oracle only. */
function referenceMul(a: number, b: number): number {
  let result = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i++) {
    if ((y & 1) !== 0) result ^= x;
    const hiBitSet = (x & 0x80) !== 0;
    x = (x << 1) & 0xff;
    if (hiBitSet) x ^= 0x1b; // 0x11B's low byte — correct HERE because x is already known to be < 0x100 before the shift, so the shift's overflow is exactly what hiBitSet captured
    y >>= 1;
  }
  return result & 0xff;
}

describe("gf256", () => {
  it("gfAdd is XOR", () => {
    expect(gfAdd(0x53, 0xca)).toBe(0x53 ^ 0xca);
    expect(gfAdd(0, 0)).toBe(0);
    expect(gfAdd(0xff, 0xff)).toBe(0);
    expect(gfAdd(0x12, 0)).toBe(0x12);
  });

  it("gfAdd is its own inverse (a + a === 0, characteristic 2)", () => {
    for (let a = 0; a < 256; a++) {
      expect(gfAdd(a, a)).toBe(0);
    }
  });

  it("gfMul matches an independently-implemented reference multiplication for all 65,536 byte pairs", () => {
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        expect(gfMul(a, b)).toBe(referenceMul(a, b));
      }
    }
  });

  it("gfMul(a, 0) === 0 and gfMul(0, b) === 0 for all a, b", () => {
    for (let a = 0; a < 256; a++) {
      expect(gfMul(a, 0)).toBe(0);
      expect(gfMul(0, a)).toBe(0);
    }
  });

  it("gfMul(a, 1) === a for all nonzero a (multiplicative identity)", () => {
    for (let a = 1; a < 256; a++) {
      expect(gfMul(a, 1)).toBe(a);
    }
  });

  it("gfMul is commutative for a sample of pairs", () => {
    for (let a = 1; a < 256; a += 7) {
      for (let b = 1; b < 256; b += 11) {
        expect(gfMul(a, b)).toBe(gfMul(b, a));
      }
    }
  });

  it("gfDiv is the true inverse of gfMul: gfDiv(gfMul(a,b), b) === a for all nonzero a,b", () => {
    for (let a = 1; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        expect(gfDiv(gfMul(a, b), b)).toBe(a);
      }
    }
  });

  it("gfDiv(0, b) === 0 for all nonzero b", () => {
    for (let b = 1; b < 256; b++) {
      expect(gfDiv(0, b)).toBe(0);
    }
  });

  it("gfDiv throws RangeError on division by zero", () => {
    expect(() => gfDiv(5, 0)).toThrow(RangeError);
    expect(() => gfDiv(0, 0)).toThrow(RangeError);
  });

  it("EXP/LOG tables are true inverses and generator 3 is primitive (every nonzero byte appears exactly once in EXP[0..254])", () => {
    const { exp, log } = _debugTables();
    const seen = new Set<number>();
    for (let i = 0; i < 255; i++) {
      expect(seen.has(exp[i]!)).toBe(false); // no repeats before the full period
      seen.add(exp[i]!);
      expect(log[exp[i]!]).toBe(i); // LOG undoes EXP exactly
    }
    expect(seen.size).toBe(255); // all 255 nonzero elements visited
  });
});
