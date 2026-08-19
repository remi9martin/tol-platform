// packages/db/src/repositories/deal-condition.repository.ts
//
// the spec Condition object + p.22 Conditions surface.

import type { DealCondition, DealConditionState } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateDealConditionInput {
  dealRoomId: string;
  description: string;
  ownerOrgId: string;
  evidenceRef?: string | null;
  dueAt?: Date | null;
  blocking?: boolean;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export const dealConditionRepository = {
  async findById(db: DbClient, id: string): Promise<DealCondition | null> {
    return db.dealCondition.findUnique({ where: { id } });
  },

  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<DealCondition[]> {
    return db.dealCondition.findMany({ where: { dealRoomId }, orderBy: { createdAt: "asc" } });
  },

  async create(db: DbClient, input: CreateDealConditionInput): Promise<DealCondition> {
    return db.dealCondition.create({
      data: {
        id: newId(),
        dealRoomId: input.dealRoomId,
        description: input.description,
        ownerOrgId: input.ownerOrgId,
        evidenceRef: input.evidenceRef ?? null,
        dueAt: input.dueAt ?? null,
        state: "PENDING",
        blocking: input.blocking ?? true,
        privacyClass: "DEAL_ROOM",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },

  /** State-only transition — see @tol/domain's assertValidDealConditionTransition, which callers run BEFORE this. */
  async updateState(
    db: DbClient,
    id: string,
    state: DealConditionState,
    resolutionNote: string | null,
    updatedByUserId: string | null,
  ): Promise<DealCondition> {
    return db.dealCondition.update({
      where: { id },
      data: { state, resolutionNote, updatedByUserId, version: { increment: 1 } },
    });
  },
};
