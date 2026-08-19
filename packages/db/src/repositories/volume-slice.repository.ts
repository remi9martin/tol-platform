// packages/db/src/repositories/volume-slice.repository.ts
//
// the spec VolumeSlice + "Mandatory reconciliation" (P7 gate). Each
// row is the finest-grain (jurisdiction x mcc x cardOrigin x channel x
// period) cell — see schema.prisma's VolumeSlice model comment and
// @tol/domain/src/volume-reconciliation.ts for why the DB-level
// `@@unique` constraint this repository relies on (surfaced here as a
// clean 409-worthy conflict, not a raw Postgres error) is what makes the
// scope's three separate SUM(...) formulas collapse to one real check.

import { Prisma, type DisclosureClass, type SourceType, type VolumeSlice } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateVolumeSliceInput {
  opportunityId: string;
  jurisdiction: string;
  mcc: string;
  cardOrigin: string;
  channel: string;
  currency: string;
  amountMinor: bigint;
  period: string;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

/** Thrown when a caller attempts to insert a slice whose (opportunityId, jurisdiction, mcc, cardOrigin, channel, period) cell already exists — the DB-level guard behind @tol/domain's own duplicate_cell check, surfaced as a typed error apps/api can map to a clean 409 instead of a raw Prisma unique-constraint error leaking through. */
export class DuplicateVolumeSliceCellError extends Error {
  constructor(input: Pick<CreateVolumeSliceInput, "jurisdiction" | "mcc" | "cardOrigin" | "channel" | "period">) {
    super(
      `a volume slice already exists for (jurisdiction=${input.jurisdiction}, mcc=${input.mcc}, cardOrigin=${input.cardOrigin}, channel=${input.channel}, period=${input.period})`,
    );
    this.name = "DuplicateVolumeSliceCellError";
  }
}

/**
 * Checked via `instanceof Prisma.PrismaClientKnownRequestError` first
 * (not just a loose `"code" in err` duck-type check) — tightened after
 * review (review)
 * flagged the original looser check; the stricter form matches this
 * codebase's own established precedent for the identical pattern
 * (`apps/api/src/shared/idempotency.ts` and the RFQ/membership services'
 * own unique-constraint-race handling both narrow the SAME way before
 * reading `.code`). `P2002` is Prisma's own documented, stable error
 * code for "Unique constraint failed" — not a fragile inference.
 */
function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError & { code: "P2002" } {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export const volumeSliceRepository = {
  async listByOpportunity(db: DbClient, opportunityId: string): Promise<VolumeSlice[]> {
    return db.volumeSlice.findMany({ where: { opportunityId }, orderBy: [{ jurisdiction: "asc" }, { mcc: "asc" }, { period: "asc" }] });
  },

  async create(db: DbClient, input: CreateVolumeSliceInput): Promise<VolumeSlice> {
    try {
      return await db.volumeSlice.create({
        data: {
          id: newId(),
          opportunityId: input.opportunityId,
          jurisdiction: input.jurisdiction,
          mcc: input.mcc,
          cardOrigin: input.cardOrigin,
          channel: input.channel,
          currency: input.currency,
          amountMinor: input.amountMinor,
          period: input.period,
          privacyClass: input.privacyClass ?? "RESTRICTED",
          createdByUserId: input.createdByUserId ?? null,
          createdByOrgId: input.createdByOrgId ?? null,
          sourceType: input.sourceType ?? "PLATFORM",
          sourceReference: input.sourceReference ?? null,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new DuplicateVolumeSliceCellError(input);
      }
      throw err;
    }
  },

  /** Deletes every slice for an Opportunity — used when a merchant replaces a full breakdown wholesale rather than patching individual cells (apps/api's opportunities service wraps this + a fresh set of `create` calls in one transaction). */
  async deleteAllByOpportunity(db: DbClient, opportunityId: string): Promise<Prisma.BatchPayload> {
    return db.volumeSlice.deleteMany({ where: { opportunityId } });
  },
};

export function newVolumeSliceId(): string {
  return newId();
}
