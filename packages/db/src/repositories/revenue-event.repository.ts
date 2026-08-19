// packages/db/src/repositories/revenue-event.repository.ts
//
// the spec: "RevenueEvent || period, source, gross amount, deductions,
// net distributable." Append-only (no update() — a correction to a
// misrecorded RevenueEvent is a new period/source row plus an
// ADJUSTMENT ledger entry against the affected accruals, never an edit
// to the original revenue fact, same "changed my mind = a new row"
// precedent as DealDecision/Claim/MatchResult).

import type { CommissionBasis, DisclosureClass, RevenueEvent, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export class RevenueEventInputError extends TypeError {
  constructor(message: string) {
    super(`invalid RevenueEvent input: ${message}`);
    this.name = "RevenueEventInputError";
  }
}

export interface CreateRevenueEventInput {
  dealRoomId: string;
  scheduleId: string;
  basis: CommissionBasis;
  period: string;
  source: string;
  grossAmountMinor: bigint;
  deductionsMinor?: bigint;
  netDistributableMinor: bigint;
  currency: string;
  recognizedAt: Date;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const revenueEventRepository = {
  async findById(db: DbClient, id: string): Promise<RevenueEvent | null> {
    return db.revenueEvent.findUnique({ where: { id } });
  },

  /** the spec's own `@@unique([dealRoomId, period, source])` business key — the idempotent "has this period already been recorded under this source label" check apps/api's economics service uses before inserting. */
  async findByDealPeriodSource(db: DbClient, dealRoomId: string, period: string, source: string): Promise<RevenueEvent | null> {
    return db.revenueEvent.findUnique({ where: { dealRoomId_period_source: { dealRoomId, period, source } } });
  },

  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<RevenueEvent[]> {
    return db.revenueEvent.findMany({ where: { dealRoomId }, orderBy: { recognizedAt: "desc" } });
  },

  async create(db: DbClient, input: CreateRevenueEventInput): Promise<RevenueEvent> {
    // Real, cheap non-negative guards added after review
    // (review) correctly noted `deductionsMinor`
    // had no such check — extended to all three money fields for the
    // same reason (belt-and-suspenders, matching @tol/domain/money.ts's
    // own "validate at every layer" discipline). This is NOT the
    // gross - deductions = net arithmetic-identity check (that's
    // @tol/domain's reconcileRevenueEvent, a SERVICE-layer concern,
    // deliberately not duplicated at the repository boundary) — only the
    // narrower "money must never be negative" invariant every other
    // money field in this codebase enforces.
    const deductionsMinor = input.deductionsMinor ?? 0n;
    if (input.grossAmountMinor < 0n) throw new RevenueEventInputError(`grossAmountMinor must not be negative, got ${input.grossAmountMinor}`);
    if (deductionsMinor < 0n) throw new RevenueEventInputError(`deductionsMinor must not be negative, got ${deductionsMinor}`);
    if (input.netDistributableMinor < 0n) throw new RevenueEventInputError(`netDistributableMinor must not be negative, got ${input.netDistributableMinor}`);

    return db.revenueEvent.create({
      data: {
        id: newId(),
        dealRoomId: input.dealRoomId,
        scheduleId: input.scheduleId,
        basis: input.basis,
        period: input.period,
        source: input.source,
        grossAmountMinor: input.grossAmountMinor,
        deductionsMinor,
        netDistributableMinor: input.netDistributableMinor,
        currency: input.currency,
        recognizedAt: input.recognizedAt,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },
};
