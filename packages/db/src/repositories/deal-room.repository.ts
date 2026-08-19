// packages/db/src/repositories/deal-room.repository.ts
//
// the spec/p.22. A DealRoom is created exactly once, atomically, inside
// apps/api's rfqs service (selectQuote) — there is no standalone
// "create" entry point called from a deals route, mirroring how a real
// deal room only ever comes into existence as the effect of a quote
// selection, never as an independent user action (ADR-0008).

import type { DealRoom, DealRoomStatus, DisclosureClass, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateDealRoomInput {
  opportunityId: string;
  rfqId: string;
  selectedQuoteId: string;
  merchantOrgId: string;
  providerOrgId: string;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const dealRoomRepository = {
  async findById(db: DbClient, id: string): Promise<DealRoom | null> {
    return db.dealRoom.findUnique({ where: { id } });
  },

  async findByRfqId(db: DbClient, rfqId: string): Promise<DealRoom | null> {
    return db.dealRoom.findUnique({ where: { rfqId } });
  },

  /** Both counterparties' "my deals" list — merchant sees theirs via ownerOrgId-equivalent (merchantOrgId), provider sees theirs via the isParticipant path; this single query covers either since both are real columns. */
  async listByOrg(db: DbClient, organizationId: string): Promise<DealRoom[]> {
    return db.dealRoom.findMany({
      where: { OR: [{ merchantOrgId: organizationId }, { providerOrgId: organizationId }] },
      orderBy: { createdAt: "desc" },
    });
  },

  /** Cross-org listing (operator/compliance/auditor). */
  async list(db: DbClient, opts: { limit?: number } = {}): Promise<DealRoom[]> {
    return db.dealRoom.findMany({ take: opts.limit ?? 100, orderBy: { createdAt: "desc" } });
  },

  async create(db: DbClient, input: CreateDealRoomInput): Promise<DealRoom> {
    return db.dealRoom.create({
      data: {
        id: newId(),
        opportunityId: input.opportunityId,
        rfqId: input.rfqId,
        selectedQuoteId: input.selectedQuoteId,
        merchantOrgId: input.merchantOrgId,
        providerOrgId: input.providerOrgId,
        status: "OPEN",
        privacyClass: input.privacyClass ?? "DEAL_ROOM",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /** Status-only transition — see @tol/domain's assertValidDealRoomTransition, which callers run BEFORE this. */
  async updateStatus(
    db: DbClient,
    id: string,
    status: DealRoomStatus,
    updatedByUserId: string | null,
  ): Promise<DealRoom> {
    return db.dealRoom.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },

  async updateNextAction(db: DbClient, id: string, nextAction: string | null, updatedByUserId: string | null): Promise<DealRoom> {
    return db.dealRoom.update({
      where: { id },
      data: { nextAction, updatedByUserId, version: { increment: 1 } },
    });
  },
};
