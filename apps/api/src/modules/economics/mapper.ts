// apps/api/src/modules/economics/mapper.ts
//
// the spec/P15. Same "mapper never queries, service decides access/
// scope" division of labor as every other mapper in this codebase.
// Every BigInt money field is stringified here — the ONE place a minor-
// units value crosses from bigint to the wire's numeric-string
// convention (packages/contracts/src/economics.ts's own MinorUnitsStringSchema).

import type { CommissionAccrual, CommissionComponent, CommissionPayment, RevenueEvent } from "@tol/db";
import type { AccrualBalance, RevenueEventReconciliation, ScheduleCapFloorStatus } from "@tol/domain";
import type {
  AccrualBalanceDTO,
  AccrualDTO,
  CommissionAccrualDTO,
  CommissionComponentDTO,
  CommissionPaymentDTO,
  CommissionScheduleDetailDTO,
  ReconciliationDTO,
  RevenueEventDTO,
  ScheduleCapFloorStatusDTO,
} from "@tol/contracts";
import type { AccrualWithBalance, ScheduleDetail } from "./service.js";

export function toCommissionComponentDTO(row: CommissionComponent): CommissionComponentDTO {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    recipientType: row.recipientType,
    recipientOrgId: row.recipientOrgId,
    componentType: row.componentType,
    bps: row.bps,
    fixedAmountMinor: row.fixedAmountMinor === null ? null : row.fixedAmountMinor.toString(),
    calculationBasis: row.calculationBasis,
    priority: row.priority,
    claimId: row.claimId,
  };
}

/** Follow-up fix: mirrors @tol/domain's ScheduleCapFloorStatus field-for-field, stringifying its two BigInt|null fields for the wire — same convention as every other money field this mapper touches. */
export function toScheduleCapFloorStatusDTO(status: ScheduleCapFloorStatus): ScheduleCapFloorStatusDTO {
  return {
    withinCap: status.withinCap,
    capExceededByMinor: status.capExceededByMinor === null ? null : status.capExceededByMinor.toString(),
    withinFloor: status.withinFloor,
    floorShortfallMinor: status.floorShortfallMinor === null ? null : status.floorShortfallMinor.toString(),
  };
}

export function toCommissionScheduleDetailDTO(detail: ScheduleDetail): CommissionScheduleDetailDTO {
  const { schedule } = detail;
  return {
    id: schedule.id,
    dealRoomId: schedule.dealRoomId,
    scheduleFamilyId: schedule.scheduleFamilyId,
    versionNumber: schedule.versionNumber,
    previousVersionId: schedule.previousVersionId,
    basis: schedule.basis,
    status: schedule.status,
    capMinor: schedule.capMinor === null ? null : schedule.capMinor.toString(),
    floorMinor: schedule.floorMinor === null ? null : schedule.floorMinor.toString(),
    survivalMonths: schedule.survivalMonths,
    description: schedule.description,
    createdAt: schedule.createdAt.toISOString(),
    components: detail.components.map(toCommissionComponentDTO),
    capFloorStatus: detail.capFloorStatus === null ? null : toScheduleCapFloorStatusDTO(detail.capFloorStatus),
  };
}

export function toRevenueEventDTO(row: RevenueEvent): RevenueEventDTO {
  return {
    id: row.id,
    dealRoomId: row.dealRoomId,
    scheduleId: row.scheduleId,
    basis: row.basis,
    period: row.period,
    source: row.source,
    grossAmountMinor: row.grossAmountMinor.toString(),
    deductionsMinor: row.deductionsMinor.toString(),
    netDistributableMinor: row.netDistributableMinor.toString(),
    currency: row.currency,
    recognizedAt: row.recognizedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCommissionAccrualDTO(row: CommissionAccrual): CommissionAccrualDTO {
  return {
    id: row.id,
    accrualRootId: row.accrualRootId,
    entryType: row.entryType,
    direction: row.direction,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    dealRoomId: row.dealRoomId,
    revenueEventId: row.revenueEventId,
    scheduleId: row.scheduleId,
    scheduleVersion: row.scheduleVersion,
    componentId: row.componentId,
    recipientOrgId: row.recipientOrgId,
    claimId: row.claimId,
    paymentId: row.paymentId,
    reason: row.reason,
    approverUserId: row.approverUserId,
    approverOrgId: row.approverOrgId,
    calculationVersion: row.calculationVersion,
    inputVersions: (row.inputVersions as string[] | null) ?? [],
    computedAt: row.computedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAccrualBalanceDTO(balance: AccrualBalance): AccrualBalanceDTO {
  return {
    status: balance.status,
    originalAmountMinor: balance.originalAmountMinor.toString(),
    netAmountMinor: balance.netAmountMinor.toString(),
    paidAmountMinor: balance.paidAmountMinor.toString(),
    outstandingAmountMinor: balance.outstandingAmountMinor.toString(),
  };
}

/** Mirrors @tol/domain's reconcileRevenueEvent output field-for-field — the wire response carries the SAME real reconciliation proof the engine computed, never a client-recomputed or bare boolean. */
export function toReconciliationDTO(reconciliation: RevenueEventReconciliation): ReconciliationDTO {
  return {
    reconciled: reconciliation.reconciled,
    distributedMinor: reconciliation.distributedMinor.toString(),
    paidMinor: reconciliation.paidMinor.toString(),
    outstandingMinor: reconciliation.outstandingMinor.toString(),
    mismatches: reconciliation.mismatches.map((m) => ({ code: m.code, message: m.message })),
  };
}

export function toAccrualDTO(row: AccrualWithBalance): AccrualDTO {
  return {
    accrualRootId: row.accrualRootId,
    dealRoomId: row.dealRoomId,
    revenueEventId: row.revenueEventId,
    scheduleId: row.scheduleId,
    componentId: row.componentId,
    recipientOrgId: row.recipientOrgId,
    claimId: row.claimId,
    currency: row.currency,
    balance: toAccrualBalanceDTO(row.balance),
    entries: row.entries.map(toCommissionAccrualDTO),
  };
}

export function toCommissionPaymentDTO(row: CommissionPayment): CommissionPaymentDTO {
  return {
    id: row.id,
    dealRoomId: row.dealRoomId,
    recipientOrgId: row.recipientOrgId,
    totalAmountMinor: row.totalAmountMinor.toString(),
    currency: row.currency,
    paidAt: row.paidAt.toISOString(),
    reference: row.reference,
    evidenceRef: row.evidenceRef,
    createdAt: row.createdAt.toISOString(),
  };
}
