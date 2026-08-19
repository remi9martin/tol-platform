// packages/db/src/repositories/quote.repository.ts
//
// the spec: "Quote amendments never overwrite prior versions" — create()
// always inserts a NEW row (quoteVersion incremented by the caller, see
// nextQuoteVersion below); there is no updateTerms()/patch() here on
// purpose. status IS updatable (submitted -> selected/rejected/expired/
// withdrawn) since that's a real in-place transition on the SAME row,
// distinct from amending the commercial terms themselves.

import type { DisclosureClass, Quote, QuoteStatus, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafePlainObject } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateQuoteInput {
  rfqId: string;
  rfqRecipientId: string;
  providerOrgId: string;
  quoteVersion: number;
  currency: string;
  validUntil: Date;
  terms: unknown;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const quoteRepository = {
  async findById(db: DbClient, id: string): Promise<Quote | null> {
    return db.quote.findUnique({ where: { id } });
  },

  async listByRfq(db: DbClient, rfqId: string): Promise<Quote[]> {
    return db.quote.findMany({ where: { rfqId }, orderBy: [{ providerOrgId: "asc" }, { quoteVersion: "asc" }] });
  },

  /** Every quote a specific provider org has ever submitted against this RFQ (all its own amendments) — used to redact competing providers' quotes at the mapper layer, and to compute nextQuoteVersion below. */
  async listByRfqAndProviderOrg(db: DbClient, rfqId: string, providerOrgId: string): Promise<Quote[]> {
    return db.quote.findMany({ where: { rfqId, providerOrgId }, orderBy: { quoteVersion: "asc" } });
  },

  /**
   * NOT atomic with the create() a caller performs afterward — read-then-
   * caller-writes, same shape of race the idempotency.repository.ts
   * reserve() docstring already documents. Two concurrent submissions for
   * the same rfqRecipientId could both read the same "next" number; the
   * `@@unique([rfqRecipientId, quoteVersion])` constraint (schema.prisma)
   * guarantees only one of them can actually persist — the LOSING
   * request's create() throws Prisma P2002. Flagged as a real BLOCKER by
   * review ("review", 2026-08-18); the fix is
   * the SAME pattern as membershipsService's runUniqueConstraintSafe
   * (apps/api/src/modules/memberships/service.ts) — a must-satisfy
   * requirement for apps/api's rfqs service (this stage), not asserted done
   * here. This function's contract is documented, not silently unsafe.
   */
  async nextQuoteVersion(db: DbClient, rfqRecipientId: string): Promise<number> {
    const latest = await db.quote.findFirst({ where: { rfqRecipientId }, orderBy: { quoteVersion: "desc" } });
    return (latest?.quoteVersion ?? 0) + 1;
  },

  async create(db: DbClient, input: CreateQuoteInput): Promise<Quote> {
    // BLOCKER fix (review,
    // 2026-08-18) — see opportunity.repository.ts's identical comment.
    assertJsonSafePlainObject(input.terms, "Quote.terms");

    return db.quote.create({
      data: {
        id: newId(),
        rfqId: input.rfqId,
        rfqRecipientId: input.rfqRecipientId,
        providerOrgId: input.providerOrgId,
        quoteVersion: input.quoteVersion,
        currency: input.currency,
        status: "SUBMITTED",
        validUntil: input.validUntil,
        terms: input.terms as object,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /** Status-only transition — see @tol/domain's assertValidQuoteTransition, which callers run BEFORE this. */
  async updateStatus(db: DbClient, id: string, status: QuoteStatus, updatedByUserId: string | null): Promise<Quote> {
    return db.quote.update({
      where: { id },
      data: { status, updatedByUserId, version: { increment: 1 } },
    });
  },
};
