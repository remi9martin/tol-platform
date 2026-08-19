import type { User, UserStatus } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  status?: UserStatus;
  mfaEnabled?: boolean;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
}

/**
 * Canonicalizes an email for storage/lookup: trimmed, lowercased. Applied
 * on every write AND every read so the DB-level `@unique` constraint on
 * User.email (which Postgres enforces case-SENSITIVELY by default)
 * actually behaves case-insensitively end to end — storing raw mixed-case
 * input while only querying case-insensitively would let
 * "alice@x.com" and "Alice@X.com" both be inserted as distinct rows
 * despite looking identical to a caller. Fixed after review
 * (packages/db block, 2026-08-18) flagged the original `mode:
 * "insensitive"`-only approach as a real case-collision gap.
 */
function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const userRepository = {
  async findById(db: DbClient, id: string): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  },

  async findByEmail(db: DbClient, email: string): Promise<User | null> {
    return db.user.findUnique({ where: { email: canonicalEmail(email) } });
  },

  async create(db: DbClient, input: CreateUserInput): Promise<User> {
    return db.user.create({
      data: {
        id: newId(),
        email: canonicalEmail(input.email),
        passwordHash: input.passwordHash,
        status: input.status ?? "ACTIVE",
        mfaEnabled: input.mfaEnabled ?? false,
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        privacyClass: "RESTRICTED",
      },
    });
  },

  async recordLogin(db: DbClient, id: string): Promise<User> {
    return db.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  },

  async updateStatus(db: DbClient, id: string, status: UserStatus, updatedByUserId: string | null): Promise<User> {
    return db.user.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },
};
