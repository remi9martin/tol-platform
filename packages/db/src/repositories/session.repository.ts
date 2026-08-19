import type { OrganizationMembership, Organization, Session, User } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  activeMembershipId?: string | null;
  expiresAt: Date;
  ipClass?: string | null;
  userAgentClass?: string | null;
}

export type SessionWithContext = Session & {
  user: User;
  activeMembership: (OrganizationMembership & { organization: Organization }) | null;
};

export const sessionRepository = {
  async create(db: DbClient, input: CreateSessionInput): Promise<Session> {
    return db.session.create({
      data: {
        id: newId(),
        userId: input.userId,
        tokenHash: input.tokenHash,
        activeMembershipId: input.activeMembershipId ?? null,
        expiresAt: input.expiresAt,
        ipClass: input.ipClass ?? null,
        userAgentClass: input.userAgentClass ?? null,
      },
    });
  },

  /**
   * Returns the session AND its user + active-membership/organization in
   * one round trip regardless of validity — callers (the auth plugin)
   * decide what "valid" means (not revoked, not expired) so that decision
   * lives in one place instead of being duplicated per query.
   */
  async findByTokenHash(db: DbClient, tokenHash: string): Promise<SessionWithContext | null> {
    return db.session.findUnique({
      where: { tokenHash },
      include: { user: true, activeMembership: { include: { organization: true } } },
    });
  },

  async touchLastSeen(db: DbClient, id: string): Promise<void> {
    await db.session.update({ where: { id }, data: { lastSeenAt: new Date() } });
  },

  async updateActiveMembership(db: DbClient, id: string, activeMembershipId: string): Promise<Session> {
    return db.session.update({ where: { id }, data: { activeMembershipId } });
  },

  async revoke(db: DbClient, id: string): Promise<Session> {
    return db.session.update({ where: { id }, data: { revokedAt: new Date() } });
  },

  /** Revoke every live session for a user — used on password change / forced logout, not exercised by earlier routes but kept real rather than stubbed since it's one line and directly useful. */
  async revokeAllForUser(db: DbClient, userId: string): Promise<number> {
    const result = await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  },
};
