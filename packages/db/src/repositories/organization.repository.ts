import type {
  DisclosureClass,
  Organization,
  OrganizationType,
  SourceType,
  VerificationStatus,
} from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateOrganizationInput {
  legalName: string;
  displayName: string;
  entityType: OrganizationType;
  country: string;
  registrationId?: string | null;
  website?: string | null;
  verificationStatus?: VerificationStatus;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export interface UpdateOrganizationInput {
  legalName?: string;
  displayName?: string;
  entityType?: OrganizationType;
  country?: string;
  registrationId?: string | null;
  website?: string | null;
  verificationStatus?: VerificationStatus;
  privacyClass?: DisclosureClass;
}

export const organizationRepository = {
  async findById(db: DbClient, id: string): Promise<Organization | null> {
    return db.organization.findUnique({ where: { id } });
  },

  async findManyByIds(db: DbClient, ids: string[]): Promise<Organization[]> {
    if (ids.length === 0) return [];
    return db.organization.findMany({ where: { id: { in: ids } } });
  },

  /** Active, non-retired organizations only — retired records never surface through the normal list path. */
  async list(db: DbClient, opts: { limit?: number; cursor?: string } = {}): Promise<Organization[]> {
    const limit = opts.limit ?? 50;
    return db.organization.findMany({
      take: limit,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
  },

  async create(db: DbClient, input: CreateOrganizationInput): Promise<Organization> {
    return db.organization.create({
      data: {
        id: newId(),
        legalName: input.legalName,
        displayName: input.displayName,
        entityType: input.entityType,
        country: input.country,
        registrationId: input.registrationId ?? null,
        website: input.website ?? null,
        verificationStatus: input.verificationStatus ?? "UNVERIFIED",
        privacyClass: input.privacyClass ?? "MEMBER_MARKET",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  async update(
    db: DbClient,
    id: string,
    patch: UpdateOrganizationInput,
    updatedByUserId: string | null,
  ): Promise<Organization> {
    return db.organization.update({
      where: { id },
      data: {
        ...patch,
        updatedByUserId,
        version: { increment: 1 },
      },
    });
  },

  /** Soft-delete only (p.12: "hard delete only under retention/privacy policy") — never a real DELETE. */
  async retire(db: DbClient, id: string, updatedByUserId: string | null): Promise<Organization> {
    return db.organization.update({
      where: { id },
      data: {
        status: "RETIRED",
        retiredAt: new Date(),
        updatedByUserId,
        version: { increment: 1 },
      },
    });
  },
};
