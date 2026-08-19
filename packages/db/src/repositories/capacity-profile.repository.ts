// packages/db/src/repositories/capacity-profile.repository.ts
//
// the spec. See schema.prisma's earlier section header + ADR-0008
// for why this stays thin relative to p.16's full JurisdictionCapability/
// ProductCapability/etc. richness (P8 scope, later day).

import type { DisclosureClass, CapacityProfile, FreshnessClass, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafePlainObject, assertStringArray } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateCapacityProfileInput {
  providerOrgId: string;
  asOf: Date;
  freshnessClass?: FreshnessClass;
  acceptingNewVolume?: boolean;
  jurisdictions?: unknown[];
  mccsAccepted?: unknown[];
  mccsExcluded?: unknown[];
  currency: string;
  monthlyCapacityMinor?: bigint;
  minTicketMinor?: number;
  maxTicketMinor?: number;
  maxChargebackBps?: number;
  maxFraudBps?: number;
  maxRefundBps?: number;
  settlementRail: string;
  settlementCadenceDays?: number;
  commercialTerms?: unknown;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const capacityProfileRepository = {
  async findById(db: DbClient, id: string): Promise<CapacityProfile | null> {
    return db.capacityProfile.findUnique({ where: { id } });
  },

  async listByProviderOrg(db: DbClient, providerOrgId: string): Promise<CapacityProfile[]> {
    return db.capacityProfile.findMany({
      where: { providerOrgId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  },

  /** Cross-org listing for roles with capacity.list cross-org authority, and for operator/merchant RFQ-invite-set picking (any active, non-stale profile). */
  async list(db: DbClient, opts: { limit?: number } = {}): Promise<CapacityProfile[]> {
    return db.capacityProfile.findMany({
      where: { status: "ACTIVE" },
      take: opts.limit ?? 100,
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * earlier: status-only update, added for apps/worker's capacity-freshness
   * job — mirrors rfqRepository.updateStatus's exact shape. NOT a
   * replacement for apps/capacity's own live-computed
   * `CapacityProfileWithLiveFreshness` (that service's header comment is
   * explicit: the stored `freshnessClass` column is "only a write-time
   * cache," never trusted as the correctness source for a live read).
   * This method exists so a background sweep can keep that cache
   * reasonably current for AT-SCALE filtering/listing use cases (D11's
   * own stated boundary: proactive reclassification of records nobody is
   * actively viewing, on top of — never instead of — live-on-read
   * correctness).
   */
  async updateFreshnessClass(db: DbClient, id: string, freshnessClass: FreshnessClass, updatedByUserId: string | null): Promise<CapacityProfile> {
    return db.capacityProfile.update({
      where: { id },
      data: { freshnessClass, updatedByUserId, version: { increment: 1 } },
    });
  },

  async create(db: DbClient, input: CreateCapacityProfileInput): Promise<CapacityProfile> {
    // BLOCKER fix (review,
    // 2026-08-18) — see opportunity.repository.ts's identical comment.
    const jurisdictions = input.jurisdictions ?? [];
    const mccsAccepted = input.mccsAccepted ?? [];
    const mccsExcluded = input.mccsExcluded ?? [];
    assertStringArray(jurisdictions, "CapacityProfile.jurisdictions");
    assertStringArray(mccsAccepted, "CapacityProfile.mccsAccepted");
    assertStringArray(mccsExcluded, "CapacityProfile.mccsExcluded");
    if (input.commercialTerms !== undefined) {
      assertJsonSafePlainObject(input.commercialTerms, "CapacityProfile.commercialTerms");
    }

    return db.capacityProfile.create({
      data: {
        id: newId(),
        providerOrgId: input.providerOrgId,
        asOf: input.asOf,
        freshnessClass: input.freshnessClass ?? "UNKNOWN",
        acceptingNewVolume: input.acceptingNewVolume ?? true,
        jurisdictions: jurisdictions as object,
        mccsAccepted: mccsAccepted as object,
        mccsExcluded: mccsExcluded as object,
        currency: input.currency,
        monthlyCapacityMinor: input.monthlyCapacityMinor ?? 0n,
        minTicketMinor: input.minTicketMinor ?? 0,
        maxTicketMinor: input.maxTicketMinor ?? 0,
        maxChargebackBps: input.maxChargebackBps ?? 0,
        maxFraudBps: input.maxFraudBps ?? 0,
        maxRefundBps: input.maxRefundBps ?? 0,
        settlementRail: input.settlementRail,
        settlementCadenceDays: input.settlementCadenceDays ?? 1,
        commercialTerms: input.commercialTerms === undefined ? undefined : (input.commercialTerms as object),
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },
};
