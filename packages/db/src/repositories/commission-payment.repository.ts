// packages/db/src/repositories/commission-payment.repository.ts
//
// the spec: "CommissionPayment || accrualIds, paid amount, date,
// reference, evidence." The "accrualIds" (plural) relationship is the
// REVERSE side of CommissionAccrual.paymentId (schema.prisma) — see that
// field's own comment for why this is a real FK rather than a Json
// array.

import type { CommissionPayment, DisclosureClass, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateCommissionPaymentInput {
  dealRoomId: string;
  recipientOrgId: string;
  totalAmountMinor: bigint;
  currency: string;
  paidAt: Date;
  reference: string;
  evidenceRef?: string | null;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const commissionPaymentRepository = {
  async findById(db: DbClient, id: string): Promise<CommissionPayment | null> {
    return db.commissionPayment.findUnique({ where: { id } });
  },

  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<CommissionPayment[]> {
    return db.commissionPayment.findMany({ where: { dealRoomId }, orderBy: { paidAt: "desc" } });
  },

  async listByRecipientOrg(db: DbClient, recipientOrgId: string): Promise<CommissionPayment[]> {
    return db.commissionPayment.findMany({ where: { recipientOrgId }, orderBy: { paidAt: "desc" } });
  },

  async create(db: DbClient, input: CreateCommissionPaymentInput): Promise<CommissionPayment> {
    return db.commissionPayment.create({
      data: {
        id: newId(),
        dealRoomId: input.dealRoomId,
        recipientOrgId: input.recipientOrgId,
        totalAmountMinor: input.totalAmountMinor,
        currency: input.currency,
        paidAt: input.paidAt,
        reference: input.reference,
        evidenceRef: input.evidenceRef ?? null,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },
};
