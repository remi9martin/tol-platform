// packages/db/src/repositories/claim-decision.repository.ts
//
// the spec: "ClaimDecision || claimId, decision, scoreBreakdown,
// reviewer, reason, effective/expiry". p.18 Rules: "Every resolution
// records rule version, score breakdown, reviewer, reason, effective
// date, expiry and appeal status." Append-only from this repository's own
// point of view — apps/api's claims service creates rows here, never
// updates one (a re-decision, e.g. after an appeal, is a NEW row, same
// "editing creates a new version" discipline as RFQVersion/Quote).

import type { ClaimDecision, ClaimDecisionOutcome } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafePlainObject } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateClaimDecisionInput {
  id: string;
  claimId: string;
  /** Set only when this decision resolves a ClaimDispute — see schema.prisma's ClaimDecision comment. */
  disputeId?: string | null;
  decision: ClaimDecisionOutcome;
  /** Snapshot of Claim.scoreBreakdown AT DECISION TIME — the caller passes the claim row's own current breakdown, not a freshly-recomputed one (see schema.prisma's comment on why this must be a copy, not a live read). */
  scoreBreakdown: object;
  algorithmVersion: string;
  ruleVersion?: string;
  reviewerUserId: string;
  reviewerOrgId: string;
  reason: string;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

export const claimDecisionRepository = {
  async findById(db: DbClient, id: string): Promise<ClaimDecision | null> {
    return db.claimDecision.findUnique({ where: { id } });
  },

  /** Full decision history for one claim (a claim can be decided more than once — an initial decision, then a later dispute-driven re-decision) — newest first, so "the current decision" is index 0. */
  async listByClaim(db: DbClient, claimId: string): Promise<ClaimDecision[]> {
    return db.claimDecision.findMany({ where: { claimId }, orderBy: { createdAt: "desc" } });
  },

  async create(db: DbClient, input: CreateClaimDecisionInput): Promise<ClaimDecision> {
    assertJsonSafePlainObject(input.scoreBreakdown, "scoreBreakdown");
    return db.claimDecision.create({
      data: {
        id: input.id,
        claimId: input.claimId,
        disputeId: input.disputeId ?? null,
        decision: input.decision,
        scoreBreakdown: input.scoreBreakdown as object,
        algorithmVersion: input.algorithmVersion,
        ruleVersion: input.ruleVersion ?? "attribution-rules-v1",
        reviewerUserId: input.reviewerUserId,
        reviewerOrgId: input.reviewerOrgId,
        reason: input.reason,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        effectiveTo: input.effectiveTo ?? null,
      },
    });
  },
};

/**
 * Helper for a caller that already has a Claim's decisions and wants "the
 * decision this claim is currently resting on" without a second query —
 * NOT a repository method itself (it takes an already-fetched list,
 * doesn't query). `listByClaim` above already returns newest-first, so
 * the common case is O(1) — but this function does NOT trust that
 * ordering (review, correctly noted the ordering assumption was real
 * though undocumented at the call site): it finds the genuine max by
 * `createdAt` regardless of the array's actual order, so a caller who
 * hands it decisions from a different source (a different sort, a
 * filtered/reordered subset) still gets the correct answer instead of a
 * silently-wrong one.
 */
export function latestClaimDecision(decisions: readonly ClaimDecision[]): ClaimDecision | null {
  if (decisions.length === 0) return null;
  return decisions.reduce((latest, d) => (d.createdAt.getTime() > latest.createdAt.getTime() ? d : latest));
}

export function newClaimDecisionId(): string {
  return newId();
}
