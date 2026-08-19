// packages/db/src/repositories/lockbox-receipt.repository.ts
//
// the spec's LockboxReceipt record. Append-only — only `create`/read
// paths are exposed, matching audit.repository.ts's/domain-event.
// repository.ts's precedent for infrastructure/evidence log tables (no
// update, no delete, anywhere in the application layer).

import type { LockboxReceipt } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateLockboxReceiptInput {
  lockboxId: string;
  version?: number;
  ciphertextHash: string;
  sealerOrgId: string;
  sealedAt: Date;
  signature: string;
  algorithm?: string;
}

export const lockboxReceiptRepository = {
  async create(db: DbClient, input: CreateLockboxReceiptInput): Promise<LockboxReceipt> {
    return db.lockboxReceipt.create({
      data: {
        id: newId(),
        lockboxId: input.lockboxId,
        version: input.version ?? 1,
        ciphertextHash: input.ciphertextHash,
        sealerOrgId: input.sealerOrgId,
        sealedAt: input.sealedAt,
        signature: input.signature,
        algorithm: input.algorithm ?? "HMAC-SHA256",
      },
    });
  },

  /** The proof-of-existence read (earlier brief: "reading a receipt is distinct from reading contents — release only"). Returns the LATEST version for this lockbox — the API only ever issues one receipt per lockbox (at seal time), so "latest" and "only" coincide today; written as a real ORDER BY + take:1 rather than assuming exactly one row, since a future re-seal/re-version flow (the spec's "editing creates a new version" TAMPER EVIDENCE rule) would add more rows without needing this query to change. */
  async findLatestByLockbox(db: DbClient, lockboxId: string): Promise<LockboxReceipt | null> {
    const rows = await db.lockboxReceipt.findMany({
      where: { lockboxId },
      orderBy: { version: "desc" },
      take: 1,
    });
    return rows[0] ?? null;
  },
};
