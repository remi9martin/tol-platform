// packages/attribution/src/ranking.ts
//
// the spec: "Scoring ranks competing claims for operator review; it
// does not automatically rewrite pre-existing legal rights." This file
// produces the RANK, never a decision — apps/api's claims module (Block
// 4) surfaces this ranking to a human reviewer, who records the actual
// outcome as a ClaimDecision (@tol/domain's claim-states.ts, this stage);
// nothing in this package ever writes VERIFIED/PARTIAL/REJECTED onto a
// claim, and nothing here mutates anything (rankClaims takes plain data
// in, returns plain data out).

import type { ClaimScoreBreakdown } from "./types.js";

export class ClaimRankingInputError extends TypeError {
  constructor(message: string) {
    super(`invalid claim ranking input: ${message}`);
    this.name = "ClaimRankingInputError";
  }
}

export interface RankableClaim {
  claimId: string;
  score: Pick<ClaimScoreBreakdown, "total">;
  /** ISO-8601 timestamp — the spec's own tie-breaker ("Submission timing... Timestamp of qualifying claim"). */
  submittedAt: string;
}

export interface ClaimRankEntry {
  claimId: string;
  rank: number;
  total: number;
  /**
   * Other claimIds sharing this EXACT rank (identical total score AND
   * identical submittedAt instant) — empty when this entry is uniquely
   * ranked. Surfacing true ties explicitly, rather than silently picking
   * an arbitrary "winner", is what lets a reviewer apply the spec's
   * "shared attribution is allowed when evidence shows a real
   * introduction chain; do not force a false single winner" rule instead
   * of this function quietly deciding it for them.
   */
  tiedWith: readonly string[];
}

/**
 * Ranks competing claims highest-total-first. Ties on `total` are broken
 * by EARLIEST `submittedAt` (the spec's own tie-breaker — being first
 * to submit a QUALIFYING claim, not first to type a name, is what
 * "submission timing" rewards). Any REMAINING tie (identical total AND
 * identical submittedAt down to the millisecond) is broken by ascending
 * `claimId`, purely so this function is a total order and never depends
 * on `Array.prototype.sort`'s behavior for genuinely-equal elements — a
 * real different-claimIds tie surviving both tie-breakers is exactly what
 * `tiedWith` surfaces for the reviewer; this final ordering key is a
 * determinism guarantee, not a claim that claimId order carries any
 * business meaning.
 *
 * Deterministic: the same set of claims produces the same output
 * regardless of the ORDER they're passed in — ranking.test.ts proves this
 * by feeding identical claims in several different starting permutations
 * and asserting identical results every time.
 *
 * Throws ClaimRankingInputError up front if any `submittedAt` fails to
 * parse as a real date — review correctly caught that an unvalidated
 * `Date.parse(...)` returning `NaN` would make the sort comparator
 * return `NaN` instead of a number, which is not a well-defined
 * comparator result and would silently break the determinism this
 * function exists to guarantee. Validating every claim BEFORE sorting
 * (rather than inside the comparator) also means a bad claim is reported
 * once with its own id, not re-discovered on every pairwise comparison.
 */
export function rankClaims(claims: readonly RankableClaim[]): ClaimRankEntry[] {
  for (const claim of claims) {
    if (Number.isNaN(Date.parse(claim.submittedAt))) {
      throw new ClaimRankingInputError(`claim "${claim.claimId}" has an unparseable submittedAt: "${claim.submittedAt}"`);
    }
  }

  const sorted = [...claims].sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const submittedDelta = Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
    if (submittedDelta !== 0) return submittedDelta;
    return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
  });

  return sorted.map((claim, i) => {
    // Compare by PARSED INSTANT (Date.parse), not raw string equality —
    // the sort comparator above already breaks ties on `submittedDelta`
    // (also a parsed-instant compare), so two claims it treats as tied
    // must be recognized as tied here too. Two ISO-8601 strings can
    // represent the identical instant with different text (e.g. a "Z"
    // suffix vs. an equivalent "+00:00" offset) — this codebase's own
    // caller (apps/api's claims/service.ts) always stamps via
    // `Date.toISOString()`, so that specific divergence isn't reachable
    // in production today, but this function is @tol/attribution's
    // public surface (any future/test caller could pass a differently-
    // formatted-but-equal-instant string) and a determinism/tie-surfacing
    // helper should never silently under-report a real tie the sort
    // itself already found. Every submittedAt was already validated
    // parseable above, so Date.parse here cannot produce NaN.
    const tiedWith = sorted
      .filter((other) => other.claimId !== claim.claimId && other.score.total === claim.score.total && Date.parse(other.submittedAt) === Date.parse(claim.submittedAt))
      .map((other) => other.claimId);
    return { claimId: claim.claimId, rank: i + 1, total: claim.score.total, tiedWith };
  });
}
