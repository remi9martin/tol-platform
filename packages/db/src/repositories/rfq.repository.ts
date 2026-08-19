// packages/db/src/repositories/rfq.repository.ts
//
// the spec. NOTE the Prisma client accessor for this model is
// `db.rFQ`, not `db.rfq` — Prisma's camelCase conversion only lowercases
// the FIRST character of a PascalCase model name, so an all-caps model
// name like `RFQ` becomes `rFQ` (verified directly against the generated
// .prisma/client/index.d.ts during this build, not assumed).

import type { DisclosureClass, RFQ, RfqStatus, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateRfqInput {
  opportunityId: string;
  status?: RfqStatus;
  dueAt: Date;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const rfqRepository = {
  async findById(db: DbClient, id: string): Promise<RFQ | null> {
    return db.rFQ.findUnique({ where: { id } });
  },

  async listByOpportunity(db: DbClient, opportunityId: string): Promise<RFQ[]> {
    return db.rFQ.findMany({ where: { opportunityId }, orderBy: { createdAt: "desc" } });
  },

  /** Cross-org listing (operator/compliance/auditor) — every RFQ, newest first. */
  async list(db: DbClient, opts: { limit?: number } = {}): Promise<RFQ[]> {
    return db.rFQ.findMany({ take: opts.limit ?? 100, orderBy: { createdAt: "desc" } });
  },

  /**
   * earlier: apps/worker's rfq-expiry sweep — DB-level filtered (dueAt in
   * the past, status still one of the four expirable ones per
   * @tol/domain's RFQ_TRANSITIONS: SENT/ACKNOWLEDGED/QUESTIONS/QUOTED all
   * have an edge to EXPIRED; DRAFT/EXPIRED/DECLINED/SELECTED don't), not
   * an in-memory filter over `list()`'s recent-100 window — a genuinely
   * overdue RFQ outside that window must never be silently skipped.
   * Oldest-`dueAt`-first so a bounded sweep (job data has no `rfqId`)
   * clears the longest-overdue backlog first if there's ever more work
   * than one pass can finish.
   */
  async listOverdue(db: DbClient, now: Date, opts: { limit?: number } = {}): Promise<RFQ[]> {
    return db.rFQ.findMany({
      where: { dueAt: { lt: now }, status: { in: ["SENT", "ACKNOWLEDGED", "QUESTIONS", "QUOTED"] } },
      take: opts.limit ?? 500,
      orderBy: { dueAt: "asc" },
    });
  },

  /** RFQs where `providerOrgId` has an RFQRecipient row — the provider-side "my invited RFQs" list (p.4: "view own RFQs" / "see only invited packets"). */
  async listByInvitedProvider(db: DbClient, providerOrgId: string): Promise<RFQ[]> {
    return db.rFQ.findMany({
      where: { recipients: { some: { providerOrgId } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async create(db: DbClient, input: CreateRfqInput): Promise<RFQ> {
    return db.rFQ.create({
      data: {
        id: newId(),
        opportunityId: input.opportunityId,
        status: input.status ?? "DRAFT",
        dueAt: input.dueAt,
        currentVersionNumber: 1,
        privacyClass: input.privacyClass ?? "DEAL_ROOM",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /** Status-only transition — see @tol/domain's assertValidRfqTransition, which callers run BEFORE this. */
  async updateStatus(db: DbClient, id: string, status: RfqStatus, updatedByUserId: string | null): Promise<RFQ> {
    return db.rFQ.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },

  /** Bumps currentVersionNumber when a new RFQVersion is created — kept as its own call so rfqVersionRepository.create and this stay two explicit statements inside one service-level transaction, never implicit. */
  async setCurrentVersionNumber(db: DbClient, id: string, versionNumber: number): Promise<RFQ> {
    return db.rFQ.update({ where: { id }, data: { currentVersionNumber: versionNumber } });
  },
};
