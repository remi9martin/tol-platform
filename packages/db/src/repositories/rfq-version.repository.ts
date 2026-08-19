// packages/db/src/repositories/rfq-version.repository.ts
//
// the spec: "Packet changes after send create a new version and
// visible change summary." The versioned-disclosure substrate the P13
// gate is named after. Client accessor is `db.rFQVersion` (see
// rfq.repository.ts's header note on Prisma's camelCase conversion).

import type { DisclosurePacketType, RFQVersion } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafePlainObject } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateRfqVersionInput {
  rfqId: string;
  versionNumber: number;
  packetType?: DisclosurePacketType;
  disclosureSnapshot: unknown;
  changeSummary?: string | null;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export const rfqVersionRepository = {
  async findById(db: DbClient, id: string): Promise<RFQVersion | null> {
    return db.rFQVersion.findUnique({ where: { id } });
  },

  async findByRfqAndVersion(db: DbClient, rfqId: string, versionNumber: number): Promise<RFQVersion | null> {
    return db.rFQVersion.findUnique({ where: { rfqId_versionNumber: { rfqId, versionNumber } } });
  },

  async listByRfq(db: DbClient, rfqId: string): Promise<RFQVersion[]> {
    return db.rFQVersion.findMany({ where: { rfqId }, orderBy: { versionNumber: "asc" } });
  },

  async latestByRfq(db: DbClient, rfqId: string): Promise<RFQVersion | null> {
    return db.rFQVersion.findFirst({ where: { rfqId }, orderBy: { versionNumber: "desc" } });
  },

  async create(db: DbClient, input: CreateRfqVersionInput): Promise<RFQVersion> {
    // BLOCKER fix (review,
    // 2026-08-18) — see opportunity.repository.ts's identical comment.
    assertJsonSafePlainObject(input.disclosureSnapshot, "RFQVersion.disclosureSnapshot");

    return db.rFQVersion.create({
      data: {
        id: newId(),
        rfqId: input.rfqId,
        versionNumber: input.versionNumber,
        packetType: input.packetType ?? "QUALIFIED_RFQ",
        disclosureSnapshot: input.disclosureSnapshot as object,
        changeSummary: input.changeSummary ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },
};
