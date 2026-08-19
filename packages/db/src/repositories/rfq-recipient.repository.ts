// packages/db/src/repositories/rfq-recipient.repository.ts
//
// the spec: RFQ's "inviteSet". This IS the mechanism apps/api's rfqs
// service uses to compute @tol/authz's `isParticipant` context for a
// provider org acting on an RFQ it doesn't own (ADR-0008). Client
// accessor is `db.rFQRecipient` (see rfq.repository.ts's header note).

import type { RFQRecipient, RfqRecipientState } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateRfqRecipientInput {
  rfqId: string;
  providerOrgId: string;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export const rfqRecipientRepository = {
  async findById(db: DbClient, id: string): Promise<RFQRecipient | null> {
    return db.rFQRecipient.findUnique({ where: { id } });
  },

  /**
   * THE participant check. apps/api's rfqs service calls this before
   * every provider-side action (decline/submit-quote/withdraw/read) to
   * compute `context.isParticipant` for @tol/authz's can() — a provider
   * org with no row here for this RFQ is NOT a participant, full stop.
   */
  async findByRfqAndProviderOrg(db: DbClient, rfqId: string, providerOrgId: string): Promise<RFQRecipient | null> {
    return db.rFQRecipient.findUnique({ where: { rfqId_providerOrgId: { rfqId, providerOrgId } } });
  },

  async listByRfq(db: DbClient, rfqId: string): Promise<RFQRecipient[]> {
    return db.rFQRecipient.findMany({ where: { rfqId }, orderBy: { createdAt: "asc" } });
  },

  async create(db: DbClient, input: CreateRfqRecipientInput): Promise<RFQRecipient> {
    return db.rFQRecipient.create({
      data: {
        id: newId(),
        rfqId: input.rfqId,
        providerOrgId: input.providerOrgId,
        state: "INVITED",
        privacyClass: "DEAL_ROOM",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },

  /** State-only transition — see @tol/domain's assertValidRfqRecipientTransition, which callers run BEFORE this. */
  async updateState(
    db: DbClient,
    id: string,
    state: RfqRecipientState,
    updatedByUserId: string | null,
    extra: { acknowledgedAt?: Date; declineReason?: string } = {},
  ): Promise<RFQRecipient> {
    return db.rFQRecipient.update({
      where: { id },
      data: {
        state,
        updatedByUserId,
        version: { increment: 1 },
        ...(extra.acknowledgedAt ? { acknowledgedAt: extra.acknowledgedAt } : {}),
        ...(extra.declineReason ? { declineReason: extra.declineReason } : {}),
      },
    });
  },
};
