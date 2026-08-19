// packages/contracts/src/matching.ts — the spec/p.20 (P11 Eligibility +
// P12 Ranking).
//
// EXPLAINABILITY DISCIPLINE (same as claim.ts's own header comment):
// every schema here mirrors @tol/matching's own return shapes field-for-
// field — the wire response carries the SAME full rule trace / per-factor
// breakdown the engine computed, never just a bare eligible boolean or a
// bare total score. `evaluatedAt` (echoed from @tol/matching's own
// injected `context.now`, never a live clock read) is the wire analog of
// `MatchResult.evaluatedAt`; there is no separate `computedAt` field
// anywhere, matching @tol/attribution/@tol/matching's own "the pure
// engine never reads a clock" precedent.

import { z } from "zod";
import { UuidSchema } from "./common.js";

export const ELIGIBILITY_RULE_FAMILY_VALUES = [
  "ROLE",
  "JURISDICTION",
  "MCC_PRODUCT",
  "VOLUME_TICKET",
  "EVIDENCE_LICENSE",
  "RISK",
  "SETTLEMENT",
  "TECHNICAL",
  "FRESHNESS",
  "COMPLIANCE_HOLD",
] as const;
export const EligibilityRuleFamilySchema = z.enum(ELIGIBILITY_RULE_FAMILY_VALUES);

export const RULE_RESULT_STATUS_VALUES = ["PASS", "INELIGIBLE", "BLOCKED", "REFRESH_REQUIRED", "UNKNOWN"] as const;
export const RuleResultStatusSchema = z.enum(RULE_RESULT_STATUS_VALUES);

/** Mirrors @tol/matching's RuleResult field-for-field. */
export const RuleResultDTOSchema = z.object({
  rule: EligibilityRuleFamilySchema,
  code: z.string(),
  status: RuleResultStatusSchema,
  blocking: z.boolean(),
  overridable: z.boolean(),
  message: z.string(),
});
export type RuleResultDTO = z.infer<typeof RuleResultDTOSchema>;

export const RANKING_FACTOR_VALUES = [
  "mccProductFit",
  "geographyLicensingFit",
  "volumeTicketFit",
  "riskHistoryFit",
  "settlementCurrencyFit",
  "commercialUtility",
  "technicalLaunchFit",
  "providerReliabilityFreshness",
  "outcomeCalibratedLikelihood",
] as const;
export const RankingFactorSchema = z.enum(RANKING_FACTOR_VALUES);

/** Mirrors @tol/matching's RankingFactorContribution field-for-field. */
export const RankingFactorContributionDTOSchema = z.object({
  factor: RankingFactorSchema,
  score: z.number(),
  weight: z.number(),
  contribution: z.number(),
  note: z.string(),
});

/** Mirrors @tol/matching's MatchRankingBreakdown field-for-field. */
export const MatchRankingBreakdownDTOSchema = z.object({
  factors: z.array(RankingFactorContributionDTOSchema),
  total: z.number(),
  algorithmVersion: z.string(),
  inputVersions: z.array(z.string()),
});
export type MatchRankingBreakdownDTO = z.infer<typeof MatchRankingBreakdownDTOSchema>;

/**
 * One persisted MatchResult row (the spec/p.20's own contract shape,
 * plus the base identifying fields). `results` is the FULL rule trace —
 * every one of the ten rule families' findings, PASS or not — with
 * `blockers`/`warnings` as convenience-derived subsets (computed by the
 * mapper from `results`, not separately stored — see schema.prisma's
 * MatchResult comment). `rankingBreakdown`/`rank`/`totalScore`/
 * `algorithmVersion` are all null together whenever `eligible` is false —
 * the spec's own "eligibility runs first" invariant, structural all the
 * way to the wire.
 */
export const MatchResultDTOSchema = z.object({
  id: UuidSchema,
  opportunityId: UuidSchema,
  capacityId: UuidSchema,
  eligible: z.boolean(),
  results: z.array(RuleResultDTOSchema),
  blockers: z.array(RuleResultDTOSchema),
  warnings: z.array(RuleResultDTOSchema),
  ruleVersion: z.string(),
  rankingBreakdown: MatchRankingBreakdownDTOSchema.nullable(),
  rank: z.number().int().positive().nullable(),
  totalScore: z.number().nullable(),
  algorithmVersion: z.string().nullable(),
  inputVersions: z.array(z.string()),
  evaluatedAt: z.string(),
  createdAt: z.string(),
});
export type MatchResultDTO = z.infer<typeof MatchResultDTOSchema>;

// ---- Requests ----

/**
 * Everything optional — a bare `POST` runs a full evaluation against
 * every active candidate capacity (scope's own "matching produces
 * eligible providers" framing, Journey B; no search/filter surface exists
 * yet, D11's own "What's explicitly NOT done" note). When supplied, both
 * fields flow into EVERY candidate's `MatchContext` this pass (Opportunity's
 * own schema carries neither field structurally — thin schema, D8 part 2 —
 * so this is the one place a caller can supply them for a specific
 * evaluation run): `averageTicketMinor` feeds the VOLUME_TICKET
 * ticket-size sub-check (and its ranking-side neutral-fallback
 * comparison); `requiredSettlementRail` feeds the SETTLEMENT rule's rail
 * check. Neither narrows the candidate POOL — every active capacity is
 * still evaluated; they only sharpen individual rule findings.
 */
export const EvaluateMatchesRequestSchema = z.object({
  averageTicketMinor: z.number().int().nonnegative().optional(),
  requiredSettlementRail: z.string().max(50).optional(),
});
export type EvaluateMatchesRequest = z.infer<typeof EvaluateMatchesRequestSchema>;

// ---- Responses ----

export const EvaluateMatchesResponseSchema = z.object({ matches: z.array(MatchResultDTOSchema) });
export type EvaluateMatchesResponse = z.infer<typeof EvaluateMatchesResponseSchema>;

export const ListMatchesResponseSchema = z.object({ matches: z.array(MatchResultDTOSchema) });
export type ListMatchesResponse = z.infer<typeof ListMatchesResponseSchema>;
