// packages/contracts/src/economics.ts — the spec (Economics, Attribution
// Ledger & Commission Accounting) + P15 exit condition ("Traceable
// schedule/accrual ledger").
//
// MONEY STAYS A NUMERIC STRING ON THE WIRE for every minor-unit field —
// same "BigInt-backed fields are wire-encoded as strings" convention as
// opportunity.ts's own MinorUnitsStringSchema (D8 part 3), extended here
// per this day's own D13: economics keeps money BigInt end to end
// (schedule cap/floor, revenue, accruals, payments), so every one of
// those fields uses this same schema, never z.number().
//
// EXPLAINABILITY DISCIPLINE (same as matching.ts/claim.ts's own header
// comments): the ledger/reconciliation DTOs mirror @tol/domain's real
// engine output field-for-field (ComputedLedgerEntry, AccrualBalance,
// RevenueEventReconciliation) — never a bare total or a client-trusted
// figure. `netDistributableMinor` on a RevenueEvent is SERVER-COMPUTED
// (gross - deductions) — RecordRevenueEventRequestSchema deliberately
// does not accept it from the client at all.

import { z } from "zod";
import { UuidSchema } from "./common.js";

const MinorUnitsStringSchema = z.string().regex(/^\d+$/, "must be a non-negative integer string");

export const COMMISSION_BASIS_VALUES = ["GROSS_PROCESSING_VOLUME", "NET_PLATFORM_REVENUE", "RECEIVED_COMMISSION", "FIXED_FEE", "SETUP_FEE", "OTHER"] as const;
export const CommissionBasisSchema = z.enum(COMMISSION_BASIS_VALUES);
export type CommissionBasis = z.infer<typeof CommissionBasisSchema>;

export const COMMISSION_SCHEDULE_STATUS_VALUES = ["DRAFT", "ACTIVE", "SUPERSEDED", "RETIRED"] as const;
export const CommissionScheduleStatusSchema = z.enum(COMMISSION_SCHEDULE_STATUS_VALUES);
export type CommissionScheduleStatus = z.infer<typeof CommissionScheduleStatusSchema>;

export const COMMISSION_RECIPIENT_TYPE_VALUES = ["CONTRIBUTOR", "PLATFORM", "OTHER"] as const;
export const CommissionRecipientTypeSchema = z.enum(COMMISSION_RECIPIENT_TYPE_VALUES);
export type CommissionRecipientType = z.infer<typeof CommissionRecipientTypeSchema>;

export const COMMISSION_COMPONENT_TYPE_VALUES = ["PERCENTAGE_BPS", "FIXED_AMOUNT"] as const;
export const CommissionComponentTypeSchema = z.enum(COMMISSION_COMPONENT_TYPE_VALUES);
export type CommissionComponentType = z.infer<typeof CommissionComponentTypeSchema>;

export const LEDGER_ENTRY_TYPE_VALUES = ["ACCRUAL", "ADJUSTMENT", "PAYMENT", "REVERSAL"] as const;
export const LedgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPE_VALUES);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

export const LEDGER_DIRECTION_VALUES = ["CREDIT", "DEBIT"] as const;
export const LedgerDirectionSchema = z.enum(LEDGER_DIRECTION_VALUES);
export type LedgerDirection = z.infer<typeof LedgerDirectionSchema>;

export const ACCRUAL_DERIVED_STATUS_VALUES = ["ACCRUED", "ADJUSTED", "PARTIALLY_PAID", "PAID", "REVERSED"] as const;
export const AccrualDerivedStatusSchema = z.enum(ACCRUAL_DERIVED_STATUS_VALUES);
export type AccrualDerivedStatus = z.infer<typeof AccrualDerivedStatusSchema>;

// ---- CommissionComponent ----

export const CommissionComponentDTOSchema = z.object({
  id: UuidSchema,
  scheduleId: UuidSchema,
  recipientType: CommissionRecipientTypeSchema,
  recipientOrgId: UuidSchema,
  componentType: CommissionComponentTypeSchema,
  bps: z.number().int().nullable(),
  fixedAmountMinor: MinorUnitsStringSchema.nullable(),
  calculationBasis: CommissionBasisSchema.nullable(),
  priority: z.number().int(),
  claimId: UuidSchema.nullable(),
});
export type CommissionComponentDTO = z.infer<typeof CommissionComponentDTOSchema>;

/** One PERCENTAGE_BPS or one FIXED_AMOUNT component, as submitted when creating/superseding a schedule — mirrors @tol/domain's EconomicsComponentInput's caller-facing subset. */
export const CommissionComponentInputSchema = z
  .object({
    recipientType: CommissionRecipientTypeSchema,
    recipientOrgId: UuidSchema,
    componentType: CommissionComponentTypeSchema,
    bps: z.number().int().min(0).max(10_000).optional(),
    fixedAmountMinor: MinorUnitsStringSchema.optional(),
    calculationBasis: CommissionBasisSchema.optional(),
    priority: z.number().int().min(0),
    claimId: UuidSchema.optional(),
  })
  .refine((c) => (c.componentType === "PERCENTAGE_BPS" ? c.bps !== undefined && c.fixedAmountMinor === undefined : c.fixedAmountMinor !== undefined && c.bps === undefined), {
    message: "PERCENTAGE_BPS components require bps (and no fixedAmountMinor); FIXED_AMOUNT components require fixedAmountMinor (and no bps)",
  });
export type CommissionComponentInput = z.infer<typeof CommissionComponentInputSchema>;

// ---- CommissionSchedule ----

export const CommissionScheduleDTOSchema = z.object({
  id: UuidSchema,
  dealRoomId: UuidSchema,
  scheduleFamilyId: UuidSchema,
  versionNumber: z.number().int().positive(),
  previousVersionId: UuidSchema.nullable(),
  basis: CommissionBasisSchema,
  status: CommissionScheduleStatusSchema,
  capMinor: MinorUnitsStringSchema.nullable(),
  floorMinor: MinorUnitsStringSchema.nullable(),
  survivalMonths: z.number().int().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type CommissionScheduleDTO = z.infer<typeof CommissionScheduleDTOSchema>;

/**
 * Follow-up fix. Mirrors @tol/domain's ScheduleCapFloorStatus
 * field-for-field — the real, derived-at-read-time DISCLOSURE of
 * whether this schedule version's actual cumulative distributed total
 * (a real DB aggregate over its own CommissionAccrual rows, never
 * estimated) sits within its own capMinor/floorMinor. DISCLOSURE only —
 * nothing in this pass makes recordRevenueEvent reject or truncate a
 * split because of a cap; see economics-engine.ts's own evaluateScheduleCapFloor
 * doc comment for why enforcement is explicitly out of scope here. Null
 * whenever the schedule carries no cap/floor at all (nothing to
 * disclose) — same "field absent when not applicable" convention as
 * every other optional-feature DTO in this file.
 */
export const ScheduleCapFloorStatusDTOSchema = z.object({
  withinCap: z.boolean(),
  capExceededByMinor: MinorUnitsStringSchema.nullable(),
  withinFloor: z.boolean(),
  floorShortfallMinor: MinorUnitsStringSchema.nullable(),
});
export type ScheduleCapFloorStatusDTO = z.infer<typeof ScheduleCapFloorStatusDTOSchema>;

/** A schedule together with its components — the shape every read endpoint returns (a schedule with zero components is meaningless, same "always return the whole picture" discipline as ClaimDetailResponse). */
export const CommissionScheduleDetailDTOSchema = CommissionScheduleDTOSchema.extend({
  components: z.array(CommissionComponentDTOSchema),
  capFloorStatus: ScheduleCapFloorStatusDTOSchema.nullable(),
});
export type CommissionScheduleDetailDTO = z.infer<typeof CommissionScheduleDetailDTOSchema>;

// ---- RevenueEvent ----

export const RevenueEventDTOSchema = z.object({
  id: UuidSchema,
  dealRoomId: UuidSchema,
  scheduleId: UuidSchema,
  basis: CommissionBasisSchema,
  period: z.string(),
  source: z.string(),
  grossAmountMinor: MinorUnitsStringSchema,
  deductionsMinor: MinorUnitsStringSchema,
  netDistributableMinor: MinorUnitsStringSchema,
  currency: z.string().length(3),
  recognizedAt: z.string(),
  createdAt: z.string(),
});
export type RevenueEventDTO = z.infer<typeof RevenueEventDTOSchema>;

// ---- CommissionAccrual (one ledger row) ----

export const CommissionAccrualDTOSchema = z.object({
  id: UuidSchema,
  accrualRootId: UuidSchema,
  entryType: LedgerEntryTypeSchema,
  direction: LedgerDirectionSchema,
  amountMinor: MinorUnitsStringSchema,
  currency: z.string().length(3),
  dealRoomId: UuidSchema,
  revenueEventId: UuidSchema,
  scheduleId: UuidSchema,
  scheduleVersion: z.number().int(),
  componentId: UuidSchema,
  recipientOrgId: UuidSchema,
  claimId: UuidSchema.nullable(),
  paymentId: UuidSchema.nullable(),
  reason: z.string().nullable(),
  approverUserId: UuidSchema.nullable(),
  approverOrgId: UuidSchema.nullable(),
  calculationVersion: z.string(),
  inputVersions: z.array(z.string()),
  computedAt: z.string(),
  createdAt: z.string(),
});
export type CommissionAccrualDTO = z.infer<typeof CommissionAccrualDTOSchema>;

/** Mirrors @tol/domain's AccrualBalance field-for-field — the real, derived current state of one logical accrual, never a stored column (see schema.prisma's CommissionAccrual comment). */
export const AccrualBalanceDTOSchema = z.object({
  status: AccrualDerivedStatusSchema,
  originalAmountMinor: MinorUnitsStringSchema,
  netAmountMinor: MinorUnitsStringSchema,
  paidAmountMinor: MinorUnitsStringSchema,
  outstandingAmountMinor: MinorUnitsStringSchema,
});
export type AccrualBalanceDTO = z.infer<typeof AccrualBalanceDTOSchema>;

/** One logical accrual: its current balance plus the FULL append-only entry chain that produced it — the traceable ledger, rendered per-recipient. */
export const AccrualDTOSchema = z.object({
  accrualRootId: UuidSchema,
  dealRoomId: UuidSchema,
  revenueEventId: UuidSchema,
  scheduleId: UuidSchema,
  componentId: UuidSchema,
  recipientOrgId: UuidSchema,
  claimId: UuidSchema.nullable(),
  currency: z.string().length(3),
  balance: AccrualBalanceDTOSchema,
  entries: z.array(CommissionAccrualDTOSchema),
});
export type AccrualDTO = z.infer<typeof AccrualDTOSchema>;

// ---- CommissionPayment ----

export const CommissionPaymentDTOSchema = z.object({
  id: UuidSchema,
  dealRoomId: UuidSchema,
  recipientOrgId: UuidSchema,
  totalAmountMinor: MinorUnitsStringSchema,
  currency: z.string().length(3),
  paidAt: z.string(),
  reference: z.string(),
  evidenceRef: z.string().nullable(),
  createdAt: z.string(),
});
export type CommissionPaymentDTO = z.infer<typeof CommissionPaymentDTOSchema>;

// ---- Reconciliation ----

export const REVENUE_EVENT_MISMATCH_CODE_VALUES = ["basis_mismatch", "distribution_mismatch"] as const;
export const RevenueEventMismatchDTOSchema = z.object({
  code: z.enum(REVENUE_EVENT_MISMATCH_CODE_VALUES),
  message: z.string(),
});

/** Mirrors @tol/domain's RevenueEventReconciliation field-for-field — the spec's own verbatim RECONCILIATION requirement, computed by the real engine, never asserted. */
export const ReconciliationDTOSchema = z.object({
  reconciled: z.boolean(),
  distributedMinor: MinorUnitsStringSchema,
  paidMinor: MinorUnitsStringSchema,
  outstandingMinor: MinorUnitsStringSchema,
  mismatches: z.array(RevenueEventMismatchDTOSchema),
});
export type ReconciliationDTO = z.infer<typeof ReconciliationDTOSchema>;

// ================================================================
// Requests
// ================================================================

/**
 * Creates AND activates a schedule in one call (schedule.manage covers
 * both — see packages/authz/src/actions.ts's own comment on why there is
 * no separate schedule.create/schedule.activate). `supersedesScheduleId`
 * marks this as a NEW VERSION of an existing schedule family (scope
 * p.23: "changing a schedule creates a new effective-dated version") —
 * omit for a genuinely new schedule. `components` must be non-empty (the
 * engine itself rejects an empty list) and, for whichever basis they
 * collectively cover, PERCENTAGE_BPS components must sum to exactly
 * 10000 minus any FIXED_AMOUNT components' share — validated server-side
 * by @tol/domain's computeCommissionSplits at the FIRST revenue event
 * recorded against this schedule, not at creation time (a schedule with
 * zero RevenueEvents yet has nothing to split).
 */
export const CreateScheduleRequestSchema = z.object({
  basis: CommissionBasisSchema,
  capMinor: MinorUnitsStringSchema.optional(),
  floorMinor: MinorUnitsStringSchema.optional(),
  survivalMonths: z.number().int().positive().optional(),
  description: z.string().max(500).optional(),
  supersedesScheduleId: UuidSchema.optional(),
  components: z.array(CommissionComponentInputSchema).min(1),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

/**
 * `netDistributableMinor` is deliberately NOT a field here — the server
 * computes it as `grossAmountMinor - deductionsMinor`, never trusts a
 * client-supplied net figure (the spec's own "never calculate on an
 * ambiguous denominator" extended to "never trust a client-supplied
 * one" either).
 */
export const RecordRevenueEventRequestSchema = z.object({
  basis: CommissionBasisSchema,
  period: z.string().min(1).max(20),
  source: z.string().min(1).max(100),
  grossAmountMinor: MinorUnitsStringSchema,
  deductionsMinor: MinorUnitsStringSchema.optional(),
  currency: z.string().length(3),
  recognizedAt: z.string().optional(),
});
export type RecordRevenueEventRequest = z.infer<typeof RecordRevenueEventRequestSchema>;

/** One or more accruals paid in a single payment batch — the spec's own plural "accrualIds". Each `amountMinor` may be a FULL or PARTIAL settlement of that accrual's current outstanding balance; the service validates none exceeds it (real, server-side, per computeAccrualBalance — never client-trusted). */
export const RecordPaymentRequestSchema = z.object({
  payments: z
    .array(
      z.object({
        accrualRootId: UuidSchema,
        amountMinor: MinorUnitsStringSchema,
      }),
    )
    .min(1),
  reference: z.string().min(1).max(200),
  evidenceRef: z.string().max(500).optional(),
  paidAt: z.string().optional(),
});
export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequestSchema>;

/** the spec's Adjustment object ("reason, prior amount, delta, approver, audit") — `direction`+`amountMinor` together ARE the "delta"; "prior amount" is derivable from the accrual's balance at read time (never re-stored redundantly); "approver" is the authenticated actor (server-attributed, not client-supplied); "audit" is the AuditEvent/DomainEvent pair every mutation in this codebase already writes. REVERSAL (voiding an accrual entirely) is a named, deliberate, NOT-built extension this pass — ADR-0013. */
export const AdjustLedgerRequestSchema = z.object({
  direction: LedgerDirectionSchema,
  amountMinor: MinorUnitsStringSchema,
  reason: z.string().min(1).max(500),
});
export type AdjustLedgerRequest = z.infer<typeof AdjustLedgerRequestSchema>;

// ================================================================
// Responses
// ================================================================

export const ListSchedulesResponseSchema = z.object({ schedules: z.array(CommissionScheduleDetailDTOSchema) });
export type ListSchedulesResponse = z.infer<typeof ListSchedulesResponseSchema>;

export const ListRevenueEventsResponseSchema = z.object({ revenueEvents: z.array(RevenueEventDTOSchema) });
export type ListRevenueEventsResponse = z.infer<typeof ListRevenueEventsResponseSchema>;

/** The response to recording a RevenueEvent — the freshly-computed split AND its own reconciliation proof, in one round trip (never require a second GET to see whether it balanced). */
export const RecordRevenueEventResponseSchema = z.object({
  revenueEvent: RevenueEventDTOSchema,
  ledgerEntries: z.array(CommissionAccrualDTOSchema),
  reconciliation: ReconciliationDTOSchema,
});
export type RecordRevenueEventResponse = z.infer<typeof RecordRevenueEventResponseSchema>;

export const LedgerResponseSchema = z.object({ accruals: z.array(AccrualDTOSchema) });
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;

export const RecordPaymentResponseSchema = z.object({
  payment: CommissionPaymentDTOSchema,
  ledgerEntries: z.array(CommissionAccrualDTOSchema),
});
export type RecordPaymentResponse = z.infer<typeof RecordPaymentResponseSchema>;

export const AdjustLedgerResponseSchema = z.object({
  ledgerEntry: CommissionAccrualDTOSchema,
  balance: AccrualBalanceDTOSchema,
});
export type AdjustLedgerResponse = z.infer<typeof AdjustLedgerResponseSchema>;
