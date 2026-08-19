// packages/db/src/repositories/claim-evidence.repository.ts
//
// the spec: "ClaimEvidence || claimId, evidenceId, evidenceType,
// assertedFact, verificationState". Fed to @tol/attribution's
// scoreClaim() by the claims service (this stage) as evidenceItems.

import type { ClaimEvidence, ClaimEvidenceType, EvidenceVerificationState } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateClaimEvidenceInput {
  id: string;
  claimId: string;
  evidenceType: ClaimEvidenceType;
  assertedFact: string;
  verificationState?: EvidenceVerificationState;
  evidenceRef?: string | null;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export const claimEvidenceRepository = {
  async findById(db: DbClient, id: string): Promise<ClaimEvidence | null> {
    return db.claimEvidence.findUnique({ where: { id } });
  },

  /** All evidence attached to one claim — insertion order (oldest first), matching @tol/attribution's ClaimEvidenceContribution.index convention (the scoring engine's own item order mirrors submission order). */
  async listByClaim(db: DbClient, claimId: string): Promise<ClaimEvidence[]> {
    return db.claimEvidence.findMany({ where: { claimId }, orderBy: { createdAt: "asc" } });
  },

  async create(db: DbClient, input: CreateClaimEvidenceInput): Promise<ClaimEvidence> {
    return db.claimEvidence.create({
      data: {
        id: input.id,
        claimId: input.claimId,
        evidenceType: input.evidenceType,
        assertedFact: input.assertedFact,
        verificationState: input.verificationState ?? "SELF_REPORTED",
        evidenceRef: input.evidenceRef ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },

  /** Bulk insert — a claim is typically filed with several evidence items at once. Matches lockboxKeyShareRepository.createMany's precedent (returns the inserted count, not the rows — Prisma's own createMany contract). */
  async createMany(db: DbClient, inputs: readonly CreateClaimEvidenceInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const result = await db.claimEvidence.createMany({
      data: inputs.map((input) => ({
        id: input.id,
        claimId: input.claimId,
        evidenceType: input.evidenceType,
        assertedFact: input.assertedFact,
        verificationState: input.verificationState ?? "SELF_REPORTED",
        evidenceRef: input.evidenceRef ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      })),
    });
    return result.count;
  },

  /** Upgrading an evidence item's verificationState (e.g. an operator confirms a SELF_REPORTED contract) — apps/api's this stage wires this as part of the reviewer-decision flow, not a standalone client-facing action this pass (same "thin but honest" scope discipline as the rest of this day). */
  async updateVerificationState(db: DbClient, id: string, verificationState: EvidenceVerificationState, updatedByUserId: string | null): Promise<ClaimEvidence> {
    return db.claimEvidence.update({
      where: { id },
      data: { verificationState, updatedByUserId, version: { increment: 1 } },
    });
  },
};

export function newClaimEvidenceId(): string {
  return newId();
}
