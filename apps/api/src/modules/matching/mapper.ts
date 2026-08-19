// apps/api/src/modules/matching/mapper.ts
//
// the spec/p.20. Same "mapper never queries, service decides access/
// scope" division of labor as every other mapper in this codebase.
// blockers/warnings are DERIVED here from the stored `results` array
// (never separately persisted — see schema.prisma's MatchResult model
// comment) — cheap, pure filtering, identical every time the same stored
// array is read, matching this package's own EligibilityResult shape
// exactly.

import type { MatchResult } from "@tol/db";
import type { MatchRankingBreakdownDTO, MatchResultDTO, RuleResultDTO } from "@tol/contracts";

export function toMatchResultDTO(row: MatchResult): MatchResultDTO {
  const results = row.eligibilityResults as unknown as RuleResultDTO[];
  const blockers = results.filter((r) => r.status !== "PASS" && r.blocking);
  const warnings = results.filter((r) => r.status !== "PASS" && !r.blocking);
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    capacityId: row.capacityId,
    eligible: row.eligible,
    results,
    blockers,
    warnings,
    ruleVersion: row.ruleVersion,
    rankingBreakdown: row.rankingBreakdown as unknown as MatchRankingBreakdownDTO | null,
    rank: row.rank,
    totalScore: row.totalScore,
    algorithmVersion: row.algorithmVersion,
    inputVersions: (row.inputVersions as string[] | null) ?? [],
    evaluatedAt: row.evaluatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
