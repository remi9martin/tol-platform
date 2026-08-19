import type { IdempotencyKey } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateIdempotencyKeyInput {
  key: string;
  scope: string;
  requestHash: string;
  organizationId?: string | null;
  userId?: string | null;
  expiresAt: Date;
}

export const idempotencyRepository = {
  async find(db: DbClient, scope: string, key: string): Promise<IdempotencyKey | null> {
    return db.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
  },

  /**
   * Reserves the (scope, key) pair up front, before the handler runs, by
   * relying on the @@unique([scope, key]) constraint to throw on a
   * concurrent duplicate — the caller (shared/idempotency.ts in
   * apps/api) catches that unique-violation race and treats it the same
   * as "found an existing row on the read path", so two requests racing
   * on the same key can never both proceed to create a second record.
   */
  async reserve(db: DbClient, input: CreateIdempotencyKeyInput): Promise<IdempotencyKey> {
    return db.idempotencyKey.create({
      data: {
        id: newId(),
        key: input.key,
        scope: input.scope,
        requestHash: input.requestHash,
        organizationId: input.organizationId ?? null,
        userId: input.userId ?? null,
        expiresAt: input.expiresAt,
      },
    });
  },

  async complete(
    db: DbClient,
    id: string,
    result: { responseStatus: number; responseBody: unknown },
  ): Promise<IdempotencyKey> {
    return db.idempotencyKey.update({
      where: { id },
      data: {
        responseStatus: result.responseStatus,
        responseBody: result.responseBody as object,
      },
    });
  },
};
