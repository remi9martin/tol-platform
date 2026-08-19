// apps/api/src/modules/capacity/mapper.ts — see opportunities/mapper.ts's
// header for why this maps every field unconditionally rather than
// running redactFields() (no single narrowly-restricted field to gate;
// access is already fully decided at the can() layer). The full,
// non-owner-redacted CapacityProfileDTO here is DIFFERENT from the
// marketplace/mapper.ts, which produces a deliberately narrower,
// redacted MarketplaceCapacityCard for cross-org market browsing.
//
// earlier (P8): `freshnessClass` is now a CALLER-SUPPLIED, LIVE-COMPUTED
// value (@tol/evidence's classifyCapacityFreshness, run by the service
// against `now`), never read directly off `profile.freshnessClass` (the
// stored column, which is only a write-time cache — see
// capacity/service.ts's own comment on why freshness must be
// recomputed on every read, not just trusted from the DB).

import type { CapacityProfile, FreshnessClass } from "@tol/db";
import type { CapacityProfileDTO } from "@tol/contracts";

export function toCapacityProfileDTO(profile: CapacityProfile, liveFreshnessClass: FreshnessClass): CapacityProfileDTO {
  return {
    id: profile.id,
    providerOrgId: profile.providerOrgId,
    asOf: profile.asOf.toISOString(),
    freshnessClass: liveFreshnessClass,
    acceptingNewVolume: profile.acceptingNewVolume,
    jurisdictions: profile.jurisdictions as string[],
    mccsAccepted: profile.mccsAccepted as string[],
    mccsExcluded: profile.mccsExcluded as string[],
    currency: profile.currency,
    monthlyCapacityMinor: profile.monthlyCapacityMinor.toString(),
    minTicketMinor: profile.minTicketMinor,
    maxTicketMinor: profile.maxTicketMinor,
    maxChargebackBps: profile.maxChargebackBps,
    maxFraudBps: profile.maxFraudBps,
    maxRefundBps: profile.maxRefundBps,
    settlementRail: profile.settlementRail,
    settlementCadenceDays: profile.settlementCadenceDays,
    commercialTerms: (profile.commercialTerms as CapacityProfileDTO["commercialTerms"]) ?? null,
    privacyClass: profile.privacyClass,
  };
}
