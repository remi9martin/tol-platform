// packages/db/src/repositories/commission-schedule.repository.ts
//
// the spec: "EconomicSchedule || parties, scope, effective dates,
// basis, cap/floor, survival." See schema.prisma's CommissionSchedule
// comment for the version-chain (scheduleFamilyId/previousVersionId)
// design. Status-only transition mirrors opportunity.repository.ts's
// updateStatus — callers (apps/api's economics service) must call
// @tol/domain's assertValidCommissionScheduleTransition() BEFORE this.

import type { CommissionBasis, CommissionSchedule, CommissionScheduleStatus, DisclosureClass, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateCommissionScheduleInput {
  dealRoomId: string;
  basis: CommissionBasis;
  status?: CommissionScheduleStatus;
  capMinor?: bigint | null;
  floorMinor?: bigint | null;
  survivalMonths?: number | null;
  description?: string | null;
  /**
   * When set, this create() call is a NEW VERSION superseding an
   * existing schedule family (the spec: "Changing a schedule creates a
   * new effective-dated version") — ONLY the previous version's `id` is
   * accepted; `scheduleFamilyId`/`versionNumber` are derived by
   * RE-FETCHING that row from the database inside create() below, never
   * trusted as caller-supplied duplicate data (review, correctly flagged that trusting a
   * caller-passed `scheduleFamilyId` alongside an `id` could link a new
   * version into the wrong family if the two ever disagreed — re-reading
   * the real row removes that whole class of mistake, and
   * `findUniqueOrThrow` doubles as the "does this previous version
   * actually exist" check). Omit entirely for a genuinely new schedule
   * (its own id becomes its scheduleFamilyId, versionNumber 1).
   */
  previousVersionId?: string | null;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const commissionScheduleRepository = {
  async findById(db: DbClient, id: string): Promise<CommissionSchedule | null> {
    return db.commissionSchedule.findUnique({ where: { id } });
  },

  /**
   * Every version of every schedule ever created for one deal — the p.23
   * "already-earned periods are not silently recalculated" history view.
   * GROUPED by family first, newest version first WITHIN each group (two-
   * key `orderBy`, standard SQL multi-column sort semantics — this fully
   * partitions rows by `scheduleFamilyId` before ordering within each
   * partition; it never interleaves two families' rows, a misreading
   * caught in review. A deal with two concurrent schedule
   * families (e.g. one for GROSS_PROCESSING_VOLUME, one for SETUP_FEE)
   * gets each family's own version history rendered as a coherent block,
   * not merged by raw timestamp — the correct shape for a "pick a family,
   * see its versions newest-first" UI.
   */
  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<CommissionSchedule[]> {
    return db.commissionSchedule.findMany({ where: { dealRoomId }, orderBy: [{ scheduleFamilyId: "asc" }, { versionNumber: "desc" }] });
  },

  /** The CURRENTLY-ACTIVE schedule version(s) for a deal — usually one, but a deal may legitimately run more than one ACTIVE schedule at once if they cover different RevenueEvent bases (e.g. a recurring GROSS_PROCESSING_VOLUME schedule alongside a one-time SETUP_FEE schedule). Newest-activated first, matching every other list method's ordering convention in this file (review — this was `asc`, inconsistent with its siblings). */
  async listActiveByDealRoom(db: DbClient, dealRoomId: string): Promise<CommissionSchedule[]> {
    return db.commissionSchedule.findMany({ where: { dealRoomId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  },

  /** Every version sharing one scheduleFamilyId, newest first — the full history of "the same logical schedule" across DRAFT -> ACTIVE -> SUPERSEDED hops. */
  async listByFamily(db: DbClient, scheduleFamilyId: string): Promise<CommissionSchedule[]> {
    return db.commissionSchedule.findMany({ where: { scheduleFamilyId }, orderBy: { versionNumber: "desc" } });
  },

  async create(db: DbClient, input: CreateCommissionScheduleInput): Promise<CommissionSchedule> {
    const id = newId();
    let scheduleFamilyId = id;
    let versionNumber = 1;
    if (input.previousVersionId) {
      // Throws if the referenced row doesn't exist — real existence
      // validation as a side effect of the re-fetch, not a separate
      // check (review).
      const previous = await db.commissionSchedule.findUniqueOrThrow({ where: { id: input.previousVersionId } });
      scheduleFamilyId = previous.scheduleFamilyId;
      versionNumber = previous.versionNumber + 1;
    }
    return db.commissionSchedule.create({
      data: {
        id,
        dealRoomId: input.dealRoomId,
        scheduleFamilyId,
        versionNumber,
        previousVersionId: input.previousVersionId ?? null,
        basis: input.basis,
        status: input.status ?? "DRAFT",
        capMinor: input.capMinor ?? null,
        floorMinor: input.floorMinor ?? null,
        survivalMonths: input.survivalMonths ?? null,
        description: input.description ?? null,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /** Status-only transition — see @tol/domain's assertValidCommissionScheduleTransition, which callers must invoke first. */
  async updateStatus(db: DbClient, id: string, status: CommissionScheduleStatus, updatedByUserId: string | null): Promise<CommissionSchedule> {
    return db.commissionSchedule.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },
};
