import { describe, expect, it } from "vitest";
import { ClaimRankingInputError, rankClaims, type RankableClaim } from "./ranking.js";

function claim(claimId: string, total: number, submittedAt: string): RankableClaim {
  return { claimId, score: { total }, submittedAt };
}

describe("rankClaims — basic ordering", () => {
  it("returns an empty array for no claims", () => {
    expect(rankClaims([])).toEqual([]);
  });

  it("a single claim ranks 1 with no ties", () => {
    const result = rankClaims([claim("a", 55, "2026-01-01T00:00:00.000Z")]);
    expect(result).toEqual([{ claimId: "a", rank: 1, total: 55, tiedWith: [] }]);
  });

  it("orders strictly by total, highest first", () => {
    const result = rankClaims([
      claim("low", 20, "2026-01-01T00:00:00.000Z"),
      claim("high", 90, "2026-01-01T00:00:00.000Z"),
      claim("mid", 50, "2026-01-01T00:00:00.000Z"),
    ]);
    expect(result.map((r) => r.claimId)).toEqual(["high", "mid", "low"]);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});

describe("rankClaims — tie-breaking (the spec: submission timing is the tie-breaker)", () => {
  it("breaks a total-score tie by earliest submittedAt", () => {
    const result = rankClaims([
      claim("later", 70, "2026-02-01T00:00:00.000Z"),
      claim("earlier", 70, "2026-01-01T00:00:00.000Z"),
    ]);
    expect(result.map((r) => r.claimId)).toEqual(["earlier", "later"]);
  });

  it("a genuine tie (same total AND same submittedAt) surfaces both claimIds in tiedWith, ordered by claimId as the final determinism key", () => {
    const result = rankClaims([
      claim("zzz", 60, "2026-01-01T00:00:00.000Z"),
      claim("aaa", 60, "2026-01-01T00:00:00.000Z"),
    ]);
    expect(result.map((r) => r.claimId)).toEqual(["aaa", "zzz"]);
    expect(result[0]!.tiedWith).toEqual(["zzz"]);
    expect(result[1]!.tiedWith).toEqual(["aaa"]);
  });

  it("a claim NOT part of any tie has an empty tiedWith even when other pairs in the same list are tied", () => {
    const result = rankClaims([
      claim("solo", 99, "2026-01-01T00:00:00.000Z"),
      claim("tie-a", 50, "2026-01-01T00:00:00.000Z"),
      claim("tie-b", 50, "2026-01-01T00:00:00.000Z"),
    ]);
    const solo = result.find((r) => r.claimId === "solo")!;
    expect(solo.tiedWith).toEqual([]);
  });

  it("three-way ties all list each other", () => {
    const result = rankClaims([
      claim("c", 40, "2026-01-01T00:00:00.000Z"),
      claim("a", 40, "2026-01-01T00:00:00.000Z"),
      claim("b", 40, "2026-01-01T00:00:00.000Z"),
    ]);
    for (const entry of result) {
      expect([...entry.tiedWith].sort()).toEqual(["a", "b", "c"].filter((id) => id !== entry.claimId));
    }
  });
});

describe("rankClaims — determinism / permutation invariance", () => {
  it("the same set of claims produces the same ranking regardless of input order", () => {
    const claims: RankableClaim[] = [
      claim("a", 30, "2026-01-03T00:00:00.000Z"),
      claim("b", 90, "2026-01-01T00:00:00.000Z"),
      claim("c", 90, "2026-01-02T00:00:00.000Z"),
      claim("d", 60, "2026-01-01T00:00:00.000Z"),
    ];
    const baseline = rankClaims(claims);

    const permutations = [
      [claims[3]!, claims[1]!, claims[0]!, claims[2]!],
      [claims[2]!, claims[0]!, claims[3]!, claims[1]!],
      [...claims].reverse(),
    ];
    for (const perm of permutations) {
      expect(rankClaims(perm)).toEqual(baseline);
    }
  });

  it("does not mutate the input array", () => {
    const claims: RankableClaim[] = [claim("b", 10, "2026-01-01T00:00:00.000Z"), claim("a", 90, "2026-01-01T00:00:00.000Z")];
    const copy = JSON.parse(JSON.stringify(claims));
    rankClaims(claims);
    expect(claims).toEqual(copy);
  });
});

describe("rankClaims — input validation (review: an unparseable submittedAt must never reach Date.parse inside the sort comparator, where a NaN comparator result would silently break ordering)", () => {
  it("throws ClaimRankingInputError, naming the offending claimId, when submittedAt cannot be parsed", () => {
    const claims: RankableClaim[] = [claim("good", 50, "2026-01-01T00:00:00.000Z"), claim("bad", 40, "not-a-real-date")];
    expect(() => rankClaims(claims)).toThrow(ClaimRankingInputError);
    expect(() => rankClaims(claims)).toThrow(/"bad"/);
  });

  it("throws before any sorting happens, even if the bad claim would have ranked last anyway", () => {
    const claims: RankableClaim[] = [claim("a", 99, "2026-01-01T00:00:00.000Z"), claim("bad", 1, "")];
    expect(() => rankClaims(claims)).toThrow(ClaimRankingInputError);
  });

  it("a valid empty-array call never throws", () => {
    expect(() => rankClaims([])).not.toThrow();
  });
});
