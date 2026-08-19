// packages/db/src/repositories/lockbox-release-evidence.repository.ts
//
// the spec's ReleaseEvent record. Append-only, same discipline as
// lockbox-receipt.repository.ts.

import type { LockboxReleaseEvidence } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateLockboxReleaseEvidenceInput {
  lockboxId: string;
  recipientOrgId: string;
  releasedAt: Date;
  authorizedByUserId: string;
  authorizedRoles: string[];
  conditionRef: string;
  ciphertextHash: string;
  receiptId?: string | null;
}

export const lockboxReleaseEvidenceRepository = {
  async create(db: DbClient, input: CreateLockboxReleaseEvidenceInput): Promise<LockboxReleaseEvidence> {
    return db.lockboxReleaseEvidence.create({
      data: {
        id: newId(),
        lockboxId: input.lockboxId,
        recipientOrgId: input.recipientOrgId,
        releasedAt: input.releasedAt,
        authorizedByUserId: input.authorizedByUserId,
        authorizedRoles: input.authorizedRoles,
        conditionRef: input.conditionRef,
        ciphertextHash: input.ciphertextHash,
        receiptId: input.receiptId ?? null,
      },
    });
  },

  async listByLockbox(db: DbClient, lockboxId: string): Promise<LockboxReleaseEvidence[]> {
    return db.lockboxReleaseEvidence.findMany({ where: { lockboxId }, orderBy: { releasedAt: "asc" } });
  },
};
