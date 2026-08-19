// apps/api/src/modules/opportunities/mapper.ts
//
// Opportunity has no single narrowly-RESTRICTED field the way
// Organization.registrationId does (the organizations/mapper.ts) —
// access is already fully gated at the can() level (own-org, or a
// role's explicit cross-org grant), so this mapper maps every field
// unconditionally rather than running @tol/authz's redactFields()
// machinery for a case where every field is equally visible to any
// viewer who passed the can() check at all.

import type { Opportunity, VolumeSlice } from "@tol/db";
import type { OpportunityDTO, VolumeSliceDTO } from "@tol/contracts";
import type { VolumeReconciliationResult } from "@tol/domain";

export function toOpportunityDTO(org: Opportunity): OpportunityDTO {
  return {
    id: org.id,
    ownerOrgId: org.ownerOrgId,
    opportunityType: org.opportunityType,
    requestedService: org.requestedService,
    status: org.status,
    currency: org.currency,
    totalPaymentVolumeMinor: org.totalPaymentVolumeMinor.toString(),
    totalCardGpvMinor: org.totalCardGpvMinor.toString(),
    eligibleCardGpvMinor: org.eligibleCardGpvMinor.toString(),
    offeredCardGpvMinor: org.offeredCardGpvMinor.toString(),
    movableNowMinor: org.movableNowMinor.toString(),
    movable30dMinor: org.movable30dMinor.toString(),
    movable90dMinor: org.movable90dMinor.toString(),
    jurisdictions: org.jurisdictions as string[],
    mccs: org.mccs as string[],
    privacyClass: org.privacyClass,
  };
}

// ---- earlier: P7 VolumeSlice ----

export function toVolumeSliceDTO(slice: VolumeSlice): VolumeSliceDTO {
  return {
    id: slice.id,
    opportunityId: slice.opportunityId,
    jurisdiction: slice.jurisdiction,
    mcc: slice.mcc,
    cardOrigin: slice.cardOrigin,
    channel: slice.channel,
    currency: slice.currency,
    amountMinor: slice.amountMinor.toString(),
    period: slice.period,
  };
}

/** Mirrors @tol/domain's VolumeReconciliationResult field-for-field — see that module's own doc comment for the reconciliation math. */
export function toVolumeReconciliationDTO(result: VolumeReconciliationResult) {
  return {
    reconciled: result.reconciled,
    sliceTotalMinor: result.sliceTotalMinor.toString(),
    offeredCardGpvMinor: result.offeredCardGpvMinor.toString(),
    mismatches: result.mismatches,
  };
}
