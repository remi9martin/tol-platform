// packages/db/src/repositories/commission-accrual.repository.ts
//
// THE TRACEABLE, APPEND-ONLY LEDGER this gate's exit condition names —
// see schema.prisma's CommissionAccrual comment for the full design
// (accrualRootId grouping, entryType discrimination). There is no
// update() — every economics fact this table ever needs to represent is
// a NEW row (ACCRUAL/ADJUSTMENT/PAYMENT/REVERSAL), same append-only
// precedent as MatchResult/ReadinessResult (D11/D12).

import type { CommissionAccrual, DisclosureClass, LedgerDirection, LedgerEntryType, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertStringArray } from "../json-guards.js";
import type { DbClient } from "./types.js";

export class CommissionAccrualInputError extends TypeError {
  constructor(message: string) {
    super(`invalid CommissionAccrual input: ${message}`);
    this.name = "CommissionAccrualInputError";
  }
}

export interface CreateCommissionAccrualInput {
  /** Omit (or null) for a fresh ACCRUAL row — its own generated id becomes its accrualRootId. Required for ADJUSTMENT/PAYMENT/REVERSAL rows (the original ACCRUAL row's id). */
  accrualRootId?: string | null;
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amountMinor: bigint;
  currency: string;
  dealRoomId: string;
  revenueEventId: string;
  scheduleId: string;
  scheduleVersion: number;
  componentId: string;
  recipientOrgId: string;
  claimId?: string | null;
  paymentId?: string | null;
  reason?: string | null;
  approverUserId?: string | null;
  approverOrgId?: string | null;
  calculationVersion: string;
  inputVersions: readonly string[];
  computedAt: Date;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const commissionAccrualRepository = {
  async findById(db: DbClient, id: string): Promise<CommissionAccrual | null> {
    return db.commissionAccrual.findUnique({ where: { id } });
  },

  /** Every row (ACCRUAL + every follow-on ADJUSTMENT/PAYMENT/REVERSAL) sharing one logical accrual — the full chain @tol/domain's computeAccrualBalance reduces to a current balance. Ordered oldest-first so a caller can also render it as a literal history/timeline. */
  async listByAccrualRoot(db: DbClient, accrualRootId: string): Promise<CommissionAccrual[]> {
    return db.commissionAccrual.findMany({ where: { accrualRootId }, orderBy: { createdAt: "asc" } });
  },

  /** Every ledger row for one RevenueEvent, across every recipient/component — the full slice @tol/domain's reconcileRevenueEvent needs for one period's reconciliation proof. */
  async listByRevenueEvent(db: DbClient, revenueEventId: string): Promise<CommissionAccrual[]> {
    return db.commissionAccrual.findMany({ where: { revenueEventId }, orderBy: { createdAt: "asc" } });
  },

  /** Full ledger for a deal — the finance/operator "read the whole ledger" view (packages/authz's ledger.read cross-org grant). */
  async listByDealRoom(db: DbClient, dealRoomId: string): Promise<CommissionAccrual[]> {
    return db.commissionAccrual.findMany({ where: { dealRoomId }, orderBy: { createdAt: "desc" } });
  },

  /** ONE recipient's own accrual entries across every deal it participates in — the "see own accruals" view packages/authz's participantActions mechanism authorizes (Contributor/Merchant/Provider). */
  async listByRecipientOrg(db: DbClient, recipientOrgId: string, opts: { limit?: number } = {}): Promise<CommissionAccrual[]> {
    return db.commissionAccrual.findMany({ where: { recipientOrgId }, orderBy: { createdAt: "desc" }, take: opts.limit ?? 200 });
  },

  /** Every distinct accrualRootId for a deal (i.e. every logical accrual ever created, one per original ACCRUAL row) — apps/api's mapper uses this to enumerate "which accruals exist" before fetching each one's full chain for a balance computation. */
  async listAccrualRootIdsByDealRoom(db: DbClient, dealRoomId: string): Promise<string[]> {
    const rows = await db.commissionAccrual.findMany({ where: { dealRoomId, entryType: "ACCRUAL" }, select: { accrualRootId: true }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => r.accrualRootId);
  },

  /**
   * Follow-up fix: SUM of every ACCRUAL-type (never ADJUSTMENT/
   * PAYMENT/REVERSAL) row's amountMinor for ONE schedule version — the
   * real, DB-computed "TOTAL distributable base this schedule version
   * ever computes against" schema.prisma's CommissionSchedule.capMinor/
   * floorMinor comment names. `scheduleId` alone (no separate
   * scheduleVersion filter) is sufficient: each CommissionSchedule row
   * already IS one specific version (previousVersionId/supersededBy
   * chain new versions as new rows, schema.prisma), so every
   * CommissionAccrual.scheduleId FK value already identifies exactly one
   * version. Feeds @tol/domain's evaluateScheduleCapFloor — apps/api's
   * economics service (listSchedules) is the caller; this repository
   * only runs the aggregate, never decides what a cap/floor breach means.
   */
  async sumAccrualAmountByScheduleId(db: DbClient, scheduleId: string): Promise<bigint> {
    const result = await db.commissionAccrual.aggregate({ where: { scheduleId, entryType: "ACCRUAL" }, _sum: { amountMinor: true } });
    return result._sum.amountMinor ?? 0n;
  },

  async create(db: DbClient, input: CreateCommissionAccrualInput): Promise<CommissionAccrual> {
    assertStringArray(input.inputVersions as unknown, "CommissionAccrual.inputVersions");
    // A traceable ledger row that names ZERO input versions is a
    // contradiction in terms for THIS gate specifically (P15's exit
    // condition is "traceable" above all else) — real, cheap check added
    // after review (review) correctly
    // flagged the gap. Every entry type, not just ACCRUAL: an
    // ADJUSTMENT/PAYMENT/REVERSAL still needs to name what it was
    // computed/authorized against.
    if (input.inputVersions.length === 0) {
      throw new CommissionAccrualInputError(`inputVersions must not be empty — a ${input.entryType} ledger entry with zero recorded input versions has no traceable provenance, contradicting this gate's own exit condition`);
    }

    if (input.entryType === "ACCRUAL") {
      if (input.paymentId || input.reason || input.approverUserId || input.approverOrgId) {
        throw new CommissionAccrualInputError("entryType ACCRUAL must not carry paymentId/reason/approverUserId/approverOrgId — those belong to ADJUSTMENT/PAYMENT/REVERSAL rows");
      }
      if (input.direction !== "CREDIT") {
        throw new CommissionAccrualInputError("entryType ACCRUAL must have direction CREDIT — a fresh accrual is always newly-owed money");
      }
    } else {
      if (!input.accrualRootId) {
        throw new CommissionAccrualInputError(`entryType ${input.entryType} requires accrualRootId — only a fresh ACCRUAL row may omit it`);
      }
      if (input.entryType === "PAYMENT" && !input.paymentId) {
        throw new CommissionAccrualInputError("entryType PAYMENT requires paymentId");
      }
      if (input.entryType === "PAYMENT" && input.direction !== "DEBIT") {
        throw new CommissionAccrualInputError("entryType PAYMENT must have direction DEBIT — a payment always reduces what's outstanding");
      }
      if (input.entryType === "REVERSAL" && input.direction !== "DEBIT") {
        throw new CommissionAccrualInputError("entryType REVERSAL must have direction DEBIT — a reversal always reduces what's outstanding");
      }
      if ((input.entryType === "ADJUSTMENT" || input.entryType === "REVERSAL") && !input.reason) {
        throw new CommissionAccrualInputError(`entryType ${input.entryType} requires a reason`);
      }
    }

    const id = newId();
    const accrualRootId = input.entryType === "ACCRUAL" ? id : (input.accrualRootId as string);

    return db.commissionAccrual.create({
      data: {
        id,
        accrualRootId,
        entryType: input.entryType,
        direction: input.direction,
        amountMinor: input.amountMinor,
        currency: input.currency,
        dealRoomId: input.dealRoomId,
        revenueEventId: input.revenueEventId,
        scheduleId: input.scheduleId,
        scheduleVersion: input.scheduleVersion,
        componentId: input.componentId,
        recipientOrgId: input.recipientOrgId,
        claimId: input.claimId ?? null,
        paymentId: input.paymentId ?? null,
        reason: input.reason ?? null,
        approverUserId: input.approverUserId ?? null,
        approverOrgId: input.approverOrgId ?? null,
        calculationVersion: input.calculationVersion,
        inputVersions: [...input.inputVersions],
        computedAt: input.computedAt,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /**
   * Persists a whole computeCommissionSplits() result (one ACCRUAL row
   * per component) in the given order.
   *
   * ATOMICITY IS THE CALLER'S RESPONSIBILITY, NOT THIS FUNCTION'S —
   * flagged explicitly here after review (review-
   * repositories) correctly noted a sequential loop with no transaction
   * risks a partial ledger if one insert fails mid-batch. This is a
   * deliberate consequence of `DbClient`'s own documented contract
   * (`./types.ts`: "repositories themselves stay single-statement and
   * minimal on purpose... Multi-step orchestration is a SERVICE-layer
   * concern") — the SAME contract every other repository in this package
   * already relies on (no repository anywhere in `packages/db` opens its
   * own transaction). The caller MUST pass an in-flight
   * `Prisma.TransactionClient` (via `withTransaction`, apps/api/src/
   * shared/transaction.ts), never the bare `prisma` client, when calling
   * this for a real mutation — apps/api's economics service (this stage)
   * does exactly that, mirroring `matchingService.evaluate`'s own
   * identical sequential-loop-inside-`withTransaction` pattern
   * (apps/api/src/modules/matching/service.ts) for persisting N
   * `MatchResult` rows atomically.
   */
  async createMany(db: DbClient, inputs: readonly CreateCommissionAccrualInput[]): Promise<CommissionAccrual[]> {
    const rows: CommissionAccrual[] = [];
    for (const input of inputs) {
      rows.push(await commissionAccrualRepository.create(db, input));
    }
    return rows;
  },
};
