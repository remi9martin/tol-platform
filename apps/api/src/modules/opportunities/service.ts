// apps/api/src/modules/opportunities/service.ts

import { can, type Actor } from "@tol/authz";
import { opportunityRepository, prisma, volumeSliceRepository, type Opportunity, type VolumeSlice } from "@tol/db";
import { parseBigIntMinorUnits, reconcileOpportunityVolume, type VolumeReconciliationResult } from "@tol/domain";
import type { CreateOpportunityRequest, ReplaceVolumeSlicesRequest } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

const CROSS_ORG_READ_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "UNDERWRITING_ANALYST", "AUDITOR_READONLY"]);

export const opportunitiesService = {
  async getById(actor: Actor, id: string): Promise<Opportunity> {
    const opportunity = await opportunityRepository.findById(prisma, id);
    if (!opportunity) throw ProblemError.notFound("Opportunity not found.");

    const decision = can(actor, "opportunity.read", { type: "opportunity", id, ownerOrgId: opportunity.ownerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return opportunity;
  },

  /** Cross-org for operator/compliance/underwriting/auditor roles (matrix.ts); own-org otherwise — same collection-scoping pattern as the organizationsService.list. */
  async list(actor: Actor): Promise<Opportunity[]> {
    const decision = can(actor, "opportunity.list", { type: "opportunity", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (actor.role !== null && CROSS_ORG_READ_ROLES.has(actor.role)) {
      return opportunityRepository.list(prisma);
    }
    return actor.organizationId ? opportunityRepository.listByOwnerOrg(prisma, actor.organizationId) : [];
  },

  async create(actor: Actor, input: CreateOpportunityRequest, context: RequestContext): Promise<Opportunity> {
    if (!actor.organizationId) throw ProblemError.forbidden("Actor has no active organization membership.");

    const decision = can(actor, "opportunity.create", { type: "opportunity", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return withTransaction(async (tx) => {
      const created = await opportunityRepository.create(tx, {
        ownerOrgId: actor.organizationId!,
        opportunityType: input.opportunityType,
        requestedService: input.requestedService,
        currency: input.currency,
        totalPaymentVolumeMinor: parseBigIntMinorUnits(input.totalPaymentVolumeMinor, "totalPaymentVolumeMinor"),
        totalCardGpvMinor: parseBigIntMinorUnits(input.totalCardGpvMinor, "totalCardGpvMinor"),
        eligibleCardGpvMinor: parseBigIntMinorUnits(input.eligibleCardGpvMinor, "eligibleCardGpvMinor"),
        offeredCardGpvMinor: parseBigIntMinorUnits(input.offeredCardGpvMinor, "offeredCardGpvMinor"),
        movableNowMinor: parseBigIntMinorUnits(input.movableNowMinor, "movableNowMinor"),
        movable30dMinor: parseBigIntMinorUnits(input.movable30dMinor, "movable30dMinor"),
        movable90dMinor: parseBigIntMinorUnits(input.movable90dMinor, "movable90dMinor"),
        jurisdictions: input.jurisdictions ?? [],
        mccs: input.mccs ?? [],
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      // AuditEvent only, no DomainEvent/timeline write — this repo's
      // DomainEvent aggregateType space is scoped to "rfq"/"deal_room"
      // per @tol/events' this stage catalog (the p.22 "Timeline" surface is
      // specifically the Deal Room's, and by extension its originating
      // RFQ's, not a generic activity feed for every entity type).
      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: actor.organizationId,
        action: "opportunity.created",
        resourceType: "opportunity",
        resourceId: created.id,
        afterValue: { opportunityType: created.opportunityType, requestedService: created.requestedService, status: created.status },
      });

      return created;
    });
  },

  // ================================================================
  // earlier: P7 VolumeSlice + volume reconciliation. Authorized through
  // "opportunity.update" (the earlier addendum action — see
  // packages/authz/src/actions.ts's own comment on why VolumeSlice is a
  // sub-resource of Opportunity, not an independent resource type).
  // ================================================================

  async getVolumeSlices(actor: Actor, opportunityId: string): Promise<{ slices: VolumeSlice[]; reconciliation: VolumeReconciliationResult }> {
    const opportunity = await opportunityRepository.findById(prisma, opportunityId);
    if (!opportunity) throw ProblemError.notFound("Opportunity not found.");

    const decision = can(actor, "opportunity.read", { type: "opportunity", id: opportunity.id, ownerOrgId: opportunity.ownerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const slices = await volumeSliceRepository.listByOpportunity(prisma, opportunityId);
    const reconciliation = reconcileVolume(opportunity, slices);
    return { slices, reconciliation };
  },

  /**
   * Replaces the Opportunity's ENTIRE volume-slice breakdown in one
   * transaction (delete-all + recreate) — see @tol/contracts'
   * ReplaceVolumeSlicesRequestSchema's own comment for why this is a
   * wholesale replace, not a per-cell patch. Runs the REAL
   * reconcileOpportunityVolume() check (@tol/domain) against the
   * CALLER'S RAW SUBMITTED input, before any DB write (see the inline
   * comment below for why this ordering is load-bearing, not
   * cosmetic) — "fails loudly on mismatch" is satisfied by SURFACING
   * the mismatch in the response, not by rejecting the write itself
   * (p.15: "If totals do not reconcile, readiness is BLOCKED" —
   * blocking READINESS is a Passport/Opportunity-status concern the
   * caller acts on, not a reason to refuse persisting the merchant's
   * own honestly-reported breakdown).
   */
  async replaceVolumeSlices(
    actor: Actor,
    opportunityId: string,
    input: ReplaceVolumeSlicesRequest,
    context: RequestContext,
  ): Promise<{ slices: VolumeSlice[]; reconciliation: VolumeReconciliationResult }> {
    const opportunity = await opportunityRepository.findById(prisma, opportunityId);
    if (!opportunity) throw ProblemError.notFound("Opportunity not found.");

    const decision = can(actor, "opportunity.update", { type: "opportunity", id: opportunity.id, ownerOrgId: opportunity.ownerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // Reconciliation is computed against the RAW SUBMITTED input FIRST,
    // before any DB write — this is what makes a duplicate cell within
    // the same submission a REPORTED mismatch (p.15: "fails loudly on
    // mismatch") rather than an unhandled 500. Without this pre-check,
    // two slices sharing one (jurisdiction, mcc, cardOrigin, channel,
    // period) cell would reach the DB's own `@@unique` constraint on the
    // SECOND insert and throw a raw DuplicateVolumeSliceCellError that
    // apps/api's central error handler has no ProblemError mapping for
    // — a genuine bug this file's own integration test caught (real
    // test execution, not review) before this fix.
    const inputForReconciliation = input.slices.map((s) => ({
      jurisdiction: s.jurisdiction,
      mcc: s.mcc,
      cardOrigin: s.cardOrigin,
      channel: s.channel,
      period: s.period,
      currency: opportunity.currency,
      amountMinor: parseBigIntMinorUnits(s.amountMinor, "amountMinor"),
    }));
    const reconciliation = reconcileOpportunityVolume(inputForReconciliation, {
      currency: opportunity.currency,
      offeredCardGpvMinor: opportunity.offeredCardGpvMinor,
      movableNowMinor: opportunity.movableNowMinor,
      movable30dMinor: opportunity.movable30dMinor,
      movable90dMinor: opportunity.movable90dMinor,
    });

    // Only the FIRST occurrence of each (jurisdiction, mcc, cardOrigin,
    // channel, period) cell is actually PERSISTED — a duplicate is
    // already fully captured in `reconciliation.mismatches` above
    // (which reflects the caller's REAL submission, duplicates
    // included); re-attempting to insert the exact same cell twice
    // would only ever hit the DB constraint pointlessly, never
    // legitimately succeed.
    const seenCellKeys = new Set<string>();
    const toInsert = inputForReconciliation.filter((s) => {
      const key = `${s.jurisdiction}|${s.mcc}|${s.cardOrigin}|${s.channel}|${s.period}`;
      if (seenCellKeys.has(key)) return false;
      seenCellKeys.add(key);
      return true;
    });

    const created = await withTransaction(async (tx) => {
      await volumeSliceRepository.deleteAllByOpportunity(tx, opportunityId);
      const rows: VolumeSlice[] = [];
      for (const s of toInsert) {
        rows.push(
          await volumeSliceRepository.create(tx, {
            opportunityId,
            jurisdiction: s.jurisdiction,
            mcc: s.mcc,
            cardOrigin: s.cardOrigin,
            channel: s.channel,
            currency: s.currency,
            amountMinor: s.amountMinor,
            period: s.period,
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          }),
        );
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: opportunity.ownerOrgId,
        action: "opportunity.volume_slices_replaced",
        resourceType: "opportunity",
        resourceId: opportunityId,
        afterValue: { sliceCount: rows.length, reconciled: reconciliation.reconciled, mismatchCount: reconciliation.mismatches.length },
      });

      return rows;
    });

    return { slices: created, reconciliation };
  },
};

function reconcileVolume(opportunity: Opportunity, slices: readonly VolumeSlice[]): VolumeReconciliationResult {
  return reconcileOpportunityVolume(
    slices.map((s) => ({ jurisdiction: s.jurisdiction, mcc: s.mcc, cardOrigin: s.cardOrigin, channel: s.channel, period: s.period, currency: s.currency, amountMinor: s.amountMinor })),
    {
      currency: opportunity.currency,
      offeredCardGpvMinor: opportunity.offeredCardGpvMinor,
      movableNowMinor: opportunity.movableNowMinor,
      movable30dMinor: opportunity.movable30dMinor,
      movable90dMinor: opportunity.movable90dMinor,
    },
  );
}
