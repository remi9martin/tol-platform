// packages/db/src/repositories/passport.repository.ts
//
// the spec (P6 Passport). 1:1 with Organization (schema.prisma's
// Passport.organizationId is @unique) — the natural lookup key for the
// UI route `/app/passport/[orgId]` (the spec) is the organization id,
// not the passport's own id, so `findByOrganizationId` is the primary
// read path; `findById` exists for symmetry with every other repository
// in this codebase.

import type { DisclosureClass, Passport, PassportStatus, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreatePassportInput {
  organizationId: string;
  status?: PassportStatus;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const passportRepository = {
  async findById(db: DbClient, id: string): Promise<Passport | null> {
    return db.passport.findUnique({ where: { id } });
  },

  async findByOrganizationId(db: DbClient, organizationId: string): Promise<Passport | null> {
    return db.passport.findUnique({ where: { organizationId } });
  },

  /** Cross-org listing for roles with passport.list-style cross-org authority (operator/analyst/compliance/auditor). */
  async list(db: DbClient, opts: { limit?: number } = {}): Promise<Passport[]> {
    return db.passport.findMany({ take: opts.limit ?? 100, orderBy: { createdAt: "desc" } });
  },

  async create(db: DbClient, input: CreatePassportInput): Promise<Passport> {
    return db.passport.create({
      data: {
        id: newId(),
        organizationId: input.organizationId,
        status: input.status ?? "DRAFT",
        privacyClass: input.privacyClass ?? "MEMBER_MARKET",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /**
   * Status-only transition — the ONLY way a Passport's status ever
   * changes (p.5 STATE RULE: "never arbitrary UI field edits"). Callers
   * (apps/api services) must call @tol/domain's
   * assertValidPassportTransition() BEFORE this, matching
   * opportunityRepository.updateStatus's exact precedent.
   */
  async updateStatus(db: DbClient, id: string, status: PassportStatus, updatedByUserId: string | null): Promise<Passport> {
    return db.passport.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },
};

/** Id helper re-exported so apps/api's service can generate the id up front, matching newClaimId()/newLockboxId()'s precedent. */
export function newPassportId(): string {
  return newId();
}
