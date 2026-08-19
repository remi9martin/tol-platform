// packages/db/src/repositories/opportunity.repository.ts
//
// the spec. See schema.prisma's earlier section header for the full
// grounding + ADR-0008 for why this stays thin relative to p.15's
// full VolumeSlice/reconciliation richness (P7 scope, later day).

import type { DisclosureClass, Opportunity, OpportunityStatus, OpportunityType, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertStringArray } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateOpportunityInput {
  ownerOrgId: string;
  opportunityType: OpportunityType;
  requestedService: string;
  status?: OpportunityStatus;
  currency: string;
  totalPaymentVolumeMinor?: bigint;
  totalCardGpvMinor?: bigint;
  eligibleCardGpvMinor?: bigint;
  offeredCardGpvMinor?: bigint;
  movableNowMinor?: bigint;
  movable30dMinor?: bigint;
  movable90dMinor?: bigint;
  jurisdictions?: unknown[];
  mccs?: unknown[];
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const opportunityRepository = {
  async findById(db: DbClient, id: string): Promise<Opportunity | null> {
    return db.opportunity.findUnique({ where: { id } });
  },

  async listByOwnerOrg(db: DbClient, ownerOrgId: string): Promise<Opportunity[]> {
    return db.opportunity.findMany({
      where: { ownerOrgId, status: { not: "CLOSED" } },
      orderBy: { createdAt: "desc" },
    });
  },

  /** Cross-org listing for roles with opportunity.list cross-org authority (matrix.ts). */
  async list(db: DbClient, opts: { limit?: number } = {}): Promise<Opportunity[]> {
    return db.opportunity.findMany({ take: opts.limit ?? 100, orderBy: { createdAt: "desc" } });
  },

  async create(db: DbClient, input: CreateOpportunityInput): Promise<Opportunity> {
    // BLOCKER fix (review,
    // 2026-08-18): casting unknown[] straight to `object` for a Json
    // column bypassed validation entirely. Fails loudly here, before the
    // Prisma call, instead of either a confusing serialization error or
    // a silently-malformed persisted value.
    const jurisdictions = input.jurisdictions ?? [];
    const mccs = input.mccs ?? [];
    assertStringArray(jurisdictions, "Opportunity.jurisdictions");
    assertStringArray(mccs, "Opportunity.mccs");

    return db.opportunity.create({
      data: {
        id: newId(),
        ownerOrgId: input.ownerOrgId,
        opportunityType: input.opportunityType,
        requestedService: input.requestedService,
        status: input.status ?? "DRAFT",
        currency: input.currency,
        totalPaymentVolumeMinor: input.totalPaymentVolumeMinor ?? 0n,
        totalCardGpvMinor: input.totalCardGpvMinor ?? 0n,
        eligibleCardGpvMinor: input.eligibleCardGpvMinor ?? 0n,
        offeredCardGpvMinor: input.offeredCardGpvMinor ?? 0n,
        movableNowMinor: input.movableNowMinor ?? 0n,
        movable30dMinor: input.movable30dMinor ?? 0n,
        movable90dMinor: input.movable90dMinor ?? 0n,
        jurisdictions: jurisdictions as object,
        mccs: mccs as object,
        privacyClass: input.privacyClass ?? "MEMBER_MARKET",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /**
   * Status-only transition — the ONLY way an Opportunity's status ever
   * changes (p.5 STATE RULE: "never arbitrary UI field edits"). Callers
   * (apps/api services) must call @tol/domain's
   * assertValidOpportunityTransition() BEFORE this, not after — this
   * function trusts its caller the same way membershipRepository.
   * updateStatus does in earlier.
   */
  async updateStatus(
    db: DbClient,
    id: string,
    status: OpportunityStatus,
    updatedByUserId: string | null,
  ): Promise<Opportunity> {
    return db.opportunity.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },
};
