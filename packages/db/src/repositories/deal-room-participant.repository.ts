// packages/db/src/repositories/deal-room-participant.repository.ts
//
// the spec's deal-room "counterparties" made concrete. THE participant
// check for @tol/authz's isParticipant context on deal.* actions,
// symmetric to rfq-recipient.repository.ts's role for RFQ actions
// (ADR-0008).

import type { DealParticipantRole, DealRoomParticipant } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateDealRoomParticipantInput {
  dealRoomId: string;
  organizationId: string;
  participantRole: DealParticipantRole;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export const dealRoomParticipantRepository = {
  async findByDealRoomAndOrg(db: DbClient, dealRoomId: string, organizationId: string): Promise<DealRoomParticipant | null> {
    return db.dealRoomParticipant.findUnique({ where: { dealRoomId_organizationId: { dealRoomId, organizationId } } });
  },

  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<DealRoomParticipant[]> {
    return db.dealRoomParticipant.findMany({ where: { dealRoomId }, orderBy: { createdAt: "asc" } });
  },

  async create(db: DbClient, input: CreateDealRoomParticipantInput): Promise<DealRoomParticipant> {
    return db.dealRoomParticipant.create({
      data: {
        id: newId(),
        dealRoomId: input.dealRoomId,
        organizationId: input.organizationId,
        participantRole: input.participantRole,
        privacyClass: "DEAL_ROOM",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },
};
