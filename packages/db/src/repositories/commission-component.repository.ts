// packages/db/src/repositories/commission-component.repository.ts
//
// the spec: "EconomicComponent || recipient, type, bps/percent/fixed,
// calculation basis, priority." Components are always created as a batch
// alongside their parent schedule (a schedule with zero components is
// meaningless — @tol/domain's computeCommissionSplits itself rejects an
// empty component list) — createMany() is the primary entry point;
// create() (singular) is exposed for completeness/tests.

import type { CommissionBasis, CommissionComponent, CommissionComponentType, CommissionRecipientType, DisclosureClass, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export class CommissionComponentInputError extends TypeError {
  constructor(message: string) {
    super(`invalid CommissionComponent input: ${message}`);
    this.name = "CommissionComponentInputError";
  }
}

export interface CreateCommissionComponentInput {
  scheduleId: string;
  recipientType: CommissionRecipientType;
  recipientOrgId: string;
  componentType: CommissionComponentType;
  /** Required (and only meaningful) when componentType is PERCENTAGE_BPS. */
  bps?: number | null;
  /** Required (and only meaningful) when componentType is FIXED_AMOUNT. */
  fixedAmountMinor?: bigint | null;
  /** null inherits the parent schedule's own `basis` — see @tol/domain's selectComponentsForBasis. */
  calculationBasis?: CommissionBasis | null;
  priority: number;
  claimId?: string | null;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

/**
 * Both directions checked (real fix, review-
 * repositories): the RELEVANT field must be present, AND the IRRELEVANT
 * field must be absent — a PERCENTAGE_BPS component silently carrying a
 * stray non-null `fixedAmountMinor` (or vice versa) would be dead data
 * that @tol/domain's computeCommissionSplits never reads (it branches on
 * `componentType`), but is exactly the kind of "looks configured, isn't
 * really" trap this repository's write boundary should reject rather
 * than silently accept. `bps`'s own 0-10000 range is enforced here too
 * (not just the engine's sum-to-10000-across-all-components check) —
 * belt and suspenders, same "validate at every layer, not just deep
 * inside the engine" discipline as @tol/domain/money.ts's own guards.
 */
function validateComponentTypeFields(input: CreateCommissionComponentInput): void {
  if (input.componentType === "PERCENTAGE_BPS") {
    if (input.bps === null || input.bps === undefined) {
      throw new CommissionComponentInputError("componentType PERCENTAGE_BPS requires bps");
    }
    if (!Number.isInteger(input.bps) || input.bps < 0 || input.bps > 10_000) {
      throw new CommissionComponentInputError(`bps must be an integer 0-10000, got ${input.bps}`);
    }
    if (input.fixedAmountMinor !== null && input.fixedAmountMinor !== undefined) {
      throw new CommissionComponentInputError("componentType PERCENTAGE_BPS must not carry a non-null fixedAmountMinor");
    }
  }
  if (input.componentType === "FIXED_AMOUNT") {
    if (input.fixedAmountMinor === null || input.fixedAmountMinor === undefined) {
      throw new CommissionComponentInputError("componentType FIXED_AMOUNT requires fixedAmountMinor");
    }
    if (input.fixedAmountMinor < 0n) {
      throw new CommissionComponentInputError(`fixedAmountMinor must not be negative, got ${input.fixedAmountMinor}`);
    }
    if (input.bps !== null && input.bps !== undefined) {
      throw new CommissionComponentInputError("componentType FIXED_AMOUNT must not carry a non-null bps");
    }
  }
}

export const commissionComponentRepository = {
  async findById(db: DbClient, id: string): Promise<CommissionComponent | null> {
    return db.commissionComponent.findUnique({ where: { id } });
  },

  async listBySchedule(db: DbClient, scheduleId: string): Promise<CommissionComponent[]> {
    return db.commissionComponent.findMany({ where: { scheduleId }, orderBy: { priority: "asc" } });
  },

  async listByRecipientOrg(db: DbClient, recipientOrgId: string): Promise<CommissionComponent[]> {
    return db.commissionComponent.findMany({ where: { recipientOrgId }, orderBy: { createdAt: "desc" } });
  },

  async create(db: DbClient, input: CreateCommissionComponentInput): Promise<CommissionComponent> {
    validateComponentTypeFields(input);
    return db.commissionComponent.create({
      data: {
        id: newId(),
        scheduleId: input.scheduleId,
        recipientType: input.recipientType,
        recipientOrgId: input.recipientOrgId,
        componentType: input.componentType,
        bps: input.bps ?? null,
        fixedAmountMinor: input.fixedAmountMinor ?? null,
        calculationBasis: input.calculationBasis ?? null,
        priority: input.priority,
        claimId: input.claimId ?? null,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },

  /**
   * Creates every component for a freshly-created schedule, in the order
   * given, preserving `priority`'s intended ordering.
   *
   * Same atomicity contract as `commissionAccrualRepository.createMany`
   * (see that function's own doc comment, added after the identical
   * review finding, review): this loop does NOT
   * open its own transaction — repositories stay single-statement and
   * thin per `./types.ts`'s own `DbClient` contract. Callers creating a
   * schedule's components as one atomic unit MUST pass an in-flight
   * `Prisma.TransactionClient`, never the bare `prisma` client.
   */
  async createMany(db: DbClient, inputs: readonly CreateCommissionComponentInput[]): Promise<CommissionComponent[]> {
    const rows: CommissionComponent[] = [];
    for (const input of inputs) {
      rows.push(await commissionComponentRepository.create(db, input));
    }
    return rows;
  },
};
