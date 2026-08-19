// packages/db/src/repositories/deal-decision.repository.ts
//
// the spec: "Decisions: quote selection, approvals, declines,
// exceptions and rationale." Create-only — see schema.prisma's
// DealDecision comment for why there is no update()/transition here.

import type { DealDecision, DealDecisionType, PersonaRole } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafePlainObject } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateDealDecisionInput {
  dealRoomId: string;
  decisionType: DealDecisionType;
  reason: string;
  relatedQuoteId?: string | null;
  comparisonSnapshot?: unknown;
  actorUserId: string | null;
  actorOrgId: string | null;
  actorRole: PersonaRole | null;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export const dealDecisionRepository = {
  async findById(db: DbClient, id: string): Promise<DealDecision | null> {
    return db.dealDecision.findUnique({ where: { id } });
  },

  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<DealDecision[]> {
    return db.dealDecision.findMany({ where: { dealRoomId }, orderBy: { decidedAt: "asc" } });
  },

  async create(db: DbClient, input: CreateDealDecisionInput): Promise<DealDecision> {
    // BLOCKER fix (review,
    // 2026-08-18) — see opportunity.repository.ts's identical comment.
    if (input.comparisonSnapshot !== undefined) {
      assertJsonSafePlainObject(input.comparisonSnapshot, "DealDecision.comparisonSnapshot");
    }

    return db.dealDecision.create({
      data: {
        id: newId(),
        dealRoomId: input.dealRoomId,
        decisionType: input.decisionType,
        reason: input.reason,
        relatedQuoteId: input.relatedQuoteId ?? null,
        comparisonSnapshot: input.comparisonSnapshot === undefined ? undefined : (input.comparisonSnapshot as object),
        actorUserId: input.actorUserId,
        actorOrgId: input.actorOrgId,
        actorRole: input.actorRole,
        privacyClass: "DEAL_ROOM",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },
};
