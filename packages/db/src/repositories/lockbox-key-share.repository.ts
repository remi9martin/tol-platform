// packages/db/src/repositories/lockbox-key-share.repository.ts
//
// the spec's KeyEnvelope record — one row per Shamir threshold share
// (ADR-0001/ADR-0009). Never exposes a way to READ the wrapped bytes
// without going through @tol/crypto's unwrap — this repository returns
// the raw row (including `wrappedShare`/`shareIv`/`shareAuthTag`), and
// only apps/api's lockbox service, which holds the role KEKs, is allowed
// to call `releasePayload` on the result. No plaintext share value is
// ever a column on this or any table (acceptance criterion 2/9).

import type { LockboxKeyShare, LockboxShareRole } from "@prisma/client";
import { newId } from "../ids.js";
import { toBytesInput, type DbClient } from "./types.js";

export interface CreateLockboxKeyShareInput {
  lockboxId: string;
  holderRole: LockboxShareRole;
  shareIndex: number;
  threshold: number;
  totalShares: number;
  wrappedShare: Buffer;
  shareIv: Buffer;
  shareAuthTag: Buffer;
  keyVersion?: number;
}

export const lockboxKeyShareRepository = {
  /** Inserts all LOCKBOX_SHARE_TOTAL shares for one Lockbox in one call — always called inside the same transaction as `lockboxRepository.createSealed` (apps/api's seal service), never separately, so a Lockbox row can never exist with a partial share set. */
  async createMany(db: DbClient, inputs: CreateLockboxKeyShareInput[]): Promise<void> {
    await db.lockboxKeyShare.createMany({
      data: inputs.map((input) => ({
        id: newId(),
        lockboxId: input.lockboxId,
        holderRole: input.holderRole,
        shareIndex: input.shareIndex,
        threshold: input.threshold,
        totalShares: input.totalShares,
        wrappedShare: toBytesInput(input.wrappedShare),
        shareIv: toBytesInput(input.shareIv),
        shareAuthTag: toBytesInput(input.shareAuthTag),
        keyVersion: input.keyVersion ?? 1,
      })),
    });
  },

  async listByLockbox(db: DbClient, lockboxId: string): Promise<LockboxKeyShare[]> {
    return db.lockboxKeyShare.findMany({ where: { lockboxId }, orderBy: { shareIndex: "asc" } });
  },

  /** Fetches only the NAMED roles' shares, and only if not yet destroyed (a destroyed share's `wrappedShare` is null — see destroyAllByLockbox below) — the query itself filters `wrappedShare: { not: null }` so a withdrawn lockbox's release attempt naturally comes back with fewer than the threshold's worth of usable rows, failing the >=2-shares structural check in @tol/crypto's releasePayload before any KEK/crypto work runs, not just via a separate status check. */
  async findActiveByLockboxAndRoles(db: DbClient, lockboxId: string, roles: LockboxShareRole[]): Promise<LockboxKeyShare[]> {
    return db.lockboxKeyShare.findMany({
      where: { lockboxId, holderRole: { in: roles }, wrappedShare: { not: null } },
    });
  },

  /** Withdraw's destruction step (acceptance criterion 6): nulls the wrapped-share bytes for EVERY share tied to this lockbox (not just the sealer's own) and records why — the payload can never be released afterward because no query path can assemble >=2 usable shares again, not merely because a status flag says WITHDRAWN. Returns the count of rows destroyed (for a service-level sanity assertion that all LOCKBOX_SHARE_TOTAL rows were actually found and destroyed, not silently 0). */
  async destroyAllByLockbox(db: DbClient, lockboxId: string, destroyedAt: Date, destroyedReason: string): Promise<number> {
    const result = await db.lockboxKeyShare.updateMany({
      where: { lockboxId, wrappedShare: { not: null } },
      data: { wrappedShare: null, shareIv: null, shareAuthTag: null, destroyedAt, destroyedReason },
    });
    return result.count;
  },
};
