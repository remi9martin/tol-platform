import type {
  MembershipStatus,
  Organization,
  OrganizationMembership,
  PersonaRole,
} from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateMembershipInput {
  organizationId: string;
  userId: string;
  role: PersonaRole;
  status?: MembershipStatus;
  invitationSource?: string | null;
  effectiveFrom?: Date;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

export type MembershipWithOrganization = OrganizationMembership & { organization: Organization };

export const membershipRepository = {
  async findById(db: DbClient, id: string): Promise<OrganizationMembership | null> {
    return db.organizationMembership.findUnique({ where: { id } });
  },

  /**
   * The single query the P4 tenant-isolation check turns on: does THIS
   * user have an ACTIVE, currently-in-effect membership in THIS org?
   * Filters effectiveTo as well as status — fixed after review
   * (packages/db block, 2026-08-18) flagged that a status=ACTIVE row past
   * its own effectiveTo date was previously still treated as active.
   */
  async findActiveByUserAndOrg(
    db: DbClient,
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMembership | null> {
    return db.organizationMembership.findFirst({
      where: {
        userId,
        organizationId,
        status: "ACTIVE",
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });
  },

  /** Any status, any org/user/role combination — used by the invite/re-invite flow to find a prior (possibly REVOKED) row before deciding whether to reactivate it or create a new one. */
  async findByUserOrgRole(
    db: DbClient,
    userId: string,
    organizationId: string,
    role: PersonaRole,
  ): Promise<OrganizationMembership | null> {
    return db.organizationMembership.findUnique({
      where: { organizationId_userId_role: { organizationId, userId, role } },
    });
  },

  async listByUser(db: DbClient, userId: string): Promise<MembershipWithOrganization[]> {
    return db.organizationMembership.findMany({
      where: { userId, status: { in: ["ACTIVE", "INVITED"] } },
      include: { organization: true },
      orderBy: { effectiveFrom: "asc" },
    });
  },

  async listByOrganization(db: DbClient, organizationId: string): Promise<OrganizationMembership[]> {
    return db.organizationMembership.findMany({
      where: { organizationId, status: { in: ["ACTIVE", "INVITED", "SUSPENDED"] } },
      orderBy: { effectiveFrom: "asc" },
    });
  },

  async create(db: DbClient, input: CreateMembershipInput): Promise<OrganizationMembership> {
    return db.organizationMembership.create({
      data: {
        id: newId(),
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
        status: input.status ?? "INVITED",
        invitationSource: input.invitationSource ?? null,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        privacyClass: "RESTRICTED",
      },
    });
  },

  /**
   * Transitions to REVOKED set effectiveTo/retiredAt ("closing out" the
   * row). Transitioning AWAY from REVOKED to any other status clears
   * both back to null — fixed after review (packages/db block,
   * 2026-08-18) flagged that reactivating a previously-revoked row left
   * stale close-out timestamps on an otherwise-active membership.
   */
  async updateStatus(
    db: DbClient,
    id: string,
    status: MembershipStatus,
    updatedByUserId: string | null,
  ): Promise<OrganizationMembership> {
    const closingOut = status === "REVOKED";
    return db.organizationMembership.update({
      where: { id },
      data: {
        status,
        updatedByUserId,
        version: { increment: 1 },
        effectiveTo: closingOut ? new Date() : null,
        retiredAt: closingOut ? new Date() : null,
      },
    });
  },

  /**
   * Reactivates a previously-REVOKED (org, user, role) row in place —
   * used by the invite/re-invite service flow instead of INSERTing a
   * second row, which the @@unique([organizationId, userId, role])
   * constraint would reject anyway. Preserves the row's identity/history
   * rather than creating a confusing duplicate for the same tuple.
   */
  async reactivate(
    db: DbClient,
    id: string,
    input: { status?: MembershipStatus; invitationSource?: string | null; updatedByUserId: string | null },
  ): Promise<OrganizationMembership> {
    return db.organizationMembership.update({
      where: { id },
      data: {
        status: input.status ?? "INVITED",
        invitationSource: input.invitationSource ?? null,
        effectiveFrom: new Date(),
        effectiveTo: null,
        retiredAt: null,
        updatedByUserId: input.updatedByUserId,
        version: { increment: 1 },
      },
    });
  },
};
