// packages/db/src/repositories/match-result.repository.ts
//
// the spec/p.20 (@tol/matching's evaluateEligibility + scoreMatch/
// rankMatches) + p.12 ("record... inputVersion(s)... ruleVersion...
// algorithmVersion... computedAt... mandatory for match scores... so
// historical decisions can be reproduced"). APPEND-ONLY, one row per
// (opportunityId, capacityId) evaluation — see schema.prisma's
// MatchResult model comment for the full reasoning (same precedent as
// readiness-result.repository.ts). There is no `update` — a fresh
// evaluation always inserts a new row.

import type { DisclosureClass, MatchResult, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafeObjectArray, assertJsonSafePlainObject, assertStringArray } from "../json-guards.js";
import type { DbClient } from "./types.js";

export class MatchResultInputError extends TypeError {
  constructor(message: string) {
    super(`invalid MatchResult input: ${message}`);
    this.name = "MatchResultInputError";
  }
}

export interface CreateMatchResultInput {
  opportunityId: string;
  capacityId: string;
  eligible: boolean;
  /** @tol/matching's RuleResult[] — every rule family's finding, PASS or not. */
  eligibilityResults: readonly Record<string, unknown>[];
  ruleVersion: string;
  /** MUST be null/omitted when `eligible` is false, and MUST be present (together with rank/totalScore/algorithmVersion) when `eligible` is true — see `create()`'s own bidirectional guard below, enforcing the spec's "eligibility runs first" invariant at the repository boundary, not merely by service-layer convention. */
  rankingBreakdown?: Record<string, unknown> | null;
  rank?: number | null;
  totalScore?: number | null;
  algorithmVersion?: string | null;
  inputVersions: readonly string[];
  evaluatedAt: Date;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const matchResultRepository = {
  /**
   * The one query apps/api's matching module (this stage) and apps/web's
   * `/app/matches/[opportunityId]` (this stage, the spec/p.8) actually
   * want: "show me the CURRENT picture for this opportunity" — the most
   * recent evaluation per candidate capacity, eligible-first, ranked
   * ascending.
   *
   * Finds the latest `evaluatedAt` PER capacity via `groupBy`/`_max`
   * (aggregated in Postgres, not bounded by an arbitrary row cap), then
   * fetches the matching rows. A prior version of this function fetched
   * the N most-recent rows across the WHOLE opportunity and reduced to
   * "first occurrence per capacityId" in application code — real bug,
   * caught by review (review "review-
   * seed"): for a long-lived opportunity with many re-evaluation cycles,
   * a capacity re-evaluated infrequently could be pushed entirely out of
   * that fixed-size window by OTHER capacities being re-evaluated more
   * often, silently dropping it from the result instead of showing its
   * (still perfectly valid) most recent evaluation. `groupBy` scales
   * correctly regardless of total historical row count. Still no raw SQL
   * (`$queryRaw`) — matching this codebase's own convention (no
   * repository anywhere in this package uses it).
   */
  async listLatestByOpportunity(db: DbClient, opportunityId: string): Promise<MatchResult[]> {
    const latestTimestamps = await db.matchResult.groupBy({
      by: ["capacityId"],
      where: { opportunityId },
      _max: { evaluatedAt: true },
    });
    const withTimestamp = latestTimestamps.filter((t): t is typeof t & { _max: { evaluatedAt: Date } } => t._max.evaluatedAt !== null);
    if (withTimestamp.length === 0) return [];

    const rows = await db.matchResult.findMany({
      where: {
        opportunityId,
        OR: withTimestamp.map((t) => ({ capacityId: t.capacityId, evaluatedAt: t._max.evaluatedAt })),
      },
      // Stable order is load-bearing for the de-dup below: without an
      // explicit orderBy, Postgres makes NO guarantee about row order
      // (SQL standard + Postgres docs both call unordered-result order
      // "unspecified"; a sequential-vs-index scan plan flip, a VACUUM, or
      // a replica read can all change it run to run). `id` is a UUIDv7
      // (packages/db/src/ids.ts) — sortable, unique, and monotonic with
      // creation time — so `{ id: "asc" }` gives a fully deterministic
      // total order across every row, matching the tiebreak convention
      // this codebase already uses elsewhere (packages/matching's
      // rankMatches breaks score ties on ascending id/capacityId rather
      // than leaving them to insertion order).
      orderBy: [{ evaluatedAt: "desc" }, { id: "asc" }],
    });

    // Defensive de-dup: two rows for the SAME capacity could legitimately
    // share the exact same evaluatedAt millisecond (e.g. a batch
    // evaluation run sharing one `now` reference across every candidate
    // capacity it scores — this repository's own seed.ts caller does
    // exactly that) — keep the first occurrence per capacityId rather
    // than letting a genuine tie widen the result past one row per
    // candidate. The orderBy above makes "first occurrence" deterministic
    // (smallest id wins a tie) instead of depending on the DB's
    // unspecified row order.
    const latestByCapacity = new Map<string, MatchResult>();
    for (const row of rows) {
      if (!latestByCapacity.has(row.capacityId)) latestByCapacity.set(row.capacityId, row);
    }
    return [...latestByCapacity.values()].sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      const rankDelta = (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY);
      if (rankDelta !== 0) return rankDelta;
      return a.capacityId < b.capacityId ? -1 : a.capacityId > b.capacityId ? 1 : 0;
    });
  },

  /** Full evaluation history for one (opportunity, capacity) pair, newest first — the reproduce-a-historical-decision path the spec names, and the read path a determinism proof (two independent recomputes on unchanged inputs must be byte-identical) exercises through the real DB. */
  async listByPair(db: DbClient, opportunityId: string, capacityId: string, opts: { limit?: number } = {}): Promise<MatchResult[]> {
    return db.matchResult.findMany({
      where: { opportunityId, capacityId },
      orderBy: { evaluatedAt: "desc" },
      take: opts.limit ?? 50,
    });
  },

  async create(db: DbClient, input: CreateMatchResultInput): Promise<MatchResult> {
    assertJsonSafeObjectArray(input.eligibilityResults, "MatchResult.eligibilityResults");
    assertStringArray(input.inputVersions as unknown, "MatchResult.inputVersions");
    const hasRankingData = input.rankingBreakdown != null || input.rank != null || input.totalScore != null || input.algorithmVersion != null;
    const hasAllRankingData = input.rankingBreakdown != null && input.rank != null && input.totalScore != null && input.algorithmVersion != null;
    if (!input.eligible && hasRankingData) {
      throw new MatchResultInputError("ranking fields (rankingBreakdown/rank/totalScore/algorithmVersion) must be null/omitted when eligible is false — the spec's own 'eligibility runs first' invariant, enforced at the repository boundary");
    }
    // Bidirectional guard, added after review (review
    // "review") correctly noted the ORIGINAL
    // one-way check let `eligible: true` slip through with a null/
    // partial ranking payload — the ineligible-must-not-carry-ranking-
    // data direction was covered, but eligible-must-carry-COMPLETE-
    // ranking-data was not. An eligible MatchResult without a real
    // ranking breakdown would contradict the spec ("Every MatchResult
    // stores factor contributions...") and silently produce a row a
    // caller could NPE on (e.g. `row.totalScore.toFixed(1)`) — same
    // "fail loud, not silently partial" discipline as this file's other
    // direction.
    if (input.eligible && !hasAllRankingData) {
      throw new MatchResultInputError("rankingBreakdown/rank/totalScore/algorithmVersion must ALL be present when eligible is true — the spec's own invariant, enforced at the repository boundary, cuts both ways");
    }
    if (input.eligible && input.rankingBreakdown != null) {
      assertJsonSafePlainObject(input.rankingBreakdown, "MatchResult.rankingBreakdown");
    }
    return db.matchResult.create({
      data: {
        id: newId(),
        opportunityId: input.opportunityId,
        capacityId: input.capacityId,
        eligible: input.eligible,
        eligibilityResults: input.eligibilityResults as object,
        ruleVersion: input.ruleVersion,
        rankingBreakdown: (input.rankingBreakdown ?? undefined) as object | undefined,
        rank: input.rank ?? null,
        totalScore: input.totalScore ?? null,
        algorithmVersion: input.algorithmVersion ?? null,
        inputVersions: [...input.inputVersions],
        evaluatedAt: input.evaluatedAt,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },
};

export function newMatchResultId(): string {
  return newId();
}
