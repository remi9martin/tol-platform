// packages/db/src/repositories/claim-dispute.repository.ts
//
// the spec: "ClaimDispute || claimId, challenger, basis, evidence,
// state, resolution".

import type { ClaimDispute, ClaimDisputeResolution } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafeObjectArray } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateClaimDisputeInput {
  id: string;
  claimId: string;
  challengerOrgId: string;
  challengerUserId: string;
  basis: string;
  evidence?: readonly object[];
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export interface DecideClaimDisputeInput {
  resolution: ClaimDisputeResolution;
  updatedByUserId: string | null;
}

export const claimDisputeRepository = {
  async findById(db: DbClient, id: string): Promise<ClaimDispute | null> {
    return db.claimDispute.findUnique({ where: { id } });
  },

  async listByClaim(db: DbClient, claimId: string): Promise<ClaimDispute[]> {
    return db.claimDispute.findMany({ where: { claimId }, orderBy: { createdAt: "desc" } });
  },

  /** Whether this claim already has an OPEN dispute — apps/api's this stage service uses this to reject a second simultaneous dispute against the same claim with a clean 409 rather than silently allowing two open challenges to race. */
  async findOpenByClaim(db: DbClient, claimId: string): Promise<ClaimDispute | null> {
    return db.claimDispute.findFirst({ where: { claimId, status: "OPEN" } });
  },

  async create(db: DbClient, input: CreateClaimDisputeInput): Promise<ClaimDispute> {
    const evidence = input.evidence ?? [];
    assertJsonSafeObjectArray(evidence, "evidence");
    return db.claimDispute.create({
      data: {
        id: input.id,
        claimId: input.claimId,
        challengerOrgId: input.challengerOrgId,
        challengerUserId: input.challengerUserId,
        basis: input.basis,
        evidence: evidence as object[],
        status: "OPEN",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
      },
    });
  },

  /** OPEN -> DECIDED, with the resolution set in the same write. Callers run @tol/domain's assertValidClaimDisputeTransition first, and pair this call with claimDecisionRepository.create inside the same transaction (this row's `resolution` and the paired ClaimDecision's `decision` are a service-layer-enforced matched pair — see schema.prisma's ClaimDispute comment). */
  async markDecided(db: DbClient, id: string, input: DecideClaimDisputeInput): Promise<ClaimDispute> {
    return db.claimDispute.update({
      where: { id },
      data: {
        status: "DECIDED",
        resolution: input.resolution,
        updatedByUserId: input.updatedByUserId,
        version: { increment: 1 },
      },
    });
  },
};

export function newClaimDisputeId(): string {
  return newId();
}
