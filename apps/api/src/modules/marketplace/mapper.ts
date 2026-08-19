// apps/api/src/modules/marketplace/mapper.ts
//
// the spec/p.6 (P5 gate). THIS FILE IS THE SECURITY-CRITICAL MECHANISM
// this whole day's build exists to prove real: "A market-level browser
// must be physically unable to retrieve deal-private fields via the
// API — redaction happens on the server before the response is
// serialized, NOT by the client hiding them." Every card this file
// produces goes through @tol/authz's REAL redactFields() — the same
// mechanism organizations/mapper.ts established earlier — never a
// client-side filter, never a hand-picked subset assembled without
// going through the policy engine.
//
// UNIFORM CATALOG, NOT A PER-VIEWER DASHBOARD: `ownerOrgId: null` is
// passed to redactFields() BELOW deliberately, for every caller
// including the actual owner — the /market listing is a single, uniform
// "what's discoverable" catalog, the same shape for everyone who
// browses it, never personalized by real ownership. An owner (or a role
// with genuine capacity.read/opportunity.read cross-org authority) who
// wants the FULL record uses the separate, dedicated
// /capacity-profiles/:id or /opportunities/:id endpoint instead, which
// already grants full access through the existing (unchanged)
// ownership/cross-org path. This keeps the market response schema
// FIXED (packages/contracts' MarketplaceCapacityCardSchema/
// MarketplaceOpportunityCardSchema are `.strict()` — no optional/
// extra fields depending on who's asking) and makes the security
// property simple to state and simple to test: no viewer, ever, gets a
// private field through this specific response shape.
//
// STRUCTURAL PROOF, NOT JUST A RUNTIME ONE: every field this mapper
// ever reads off the raw CapacityProfile/Opportunity row is either (a)
// tagged in FIELD_CLASSES and passed through redactFields(), or (b) a
// DERIVED, already-safe value (a volume BAND or risk TIER, computed
// from the exact figure but never itself exposing it) built BEFORE
// redaction and tagged MEMBER_MARKET. The raw exact figures
// (monthlyCapacityMinor, maxChargebackBps, etc.) and the raw identity
// field (providerOrgId/ownerOrgId) are NEVER assigned to any field on
// the returned card type — `MarketplaceCapacityCardSchema`/
// `MarketplaceOpportunityCardSchema` have no slot for them at all (see
// packages/contracts/src/marketplace.ts's own header comment).

import { redactFields, type Actor, type Resource } from "@tol/authz";
import type { CapacityProfile, Opportunity } from "@tol/db";
import type { MarketplaceCapacityCard, MarketplaceOpportunityCard, RiskTier, VolumeBand } from "@tol/contracts";

/**
 * A coarse, non-reversible bucket over an exact minor-units figure —
 * the spec's "volume band" language made concrete. Deliberately WIDE
 * bands so a market browser cannot narrow down an exact figure by
 * bisecting across many requests (see packages/contracts/src/
 * marketplace.ts's own comment on this same point).
 */
export function bandVolume(amountMinor: bigint): VolumeBand {
  if (amountMinor < 100_000_00n) return "UNDER_100K";
  if (amountMinor < 1_000_000_00n) return "100K_1M";
  if (amountMinor < 5_000_000_00n) return "1M_5M";
  if (amountMinor < 20_000_000_00n) return "5M_20M";
  return "20M_PLUS";
}

/**
 * the spec: "Member-visible marketplace cards show safe ranges/
 * categories only" — a coarse risk-posture category over the three exact
 * bps ceilings, never the ceilings themselves. Not scope-specified
 * numerically — documented inference, same "reasonable inferred
 * threshold, revisitable" discipline as every other numeric band this
 * codebase infers (@tol/attribution/src/config.ts's own bands).
 */
export function bandRiskTier(maxChargebackBps: number, maxFraudBps: number, maxRefundBps: number): RiskTier {
  const total = maxChargebackBps + maxFraudBps + maxRefundBps;
  if (total <= 300) return "LOW";
  if (total <= 700) return "MODERATE";
  return "ELEVATED";
}

/**
 * the spec: "Pricing is private... A provider's commercial floor is
 * never exposed to a merchant or competing provider" (SECRET-tier) /
 * "safe ranges/categories only" for everything else the card shows
 * (MEMBER_MARKET-tier). `providerOrgId` is RESTRICTED — anonymized per
 * p.1's "Members can see... anonymized opportunity inventory" (the same
 * DisclosureGrant-tier reasoning p.22's own table applies: identity is
 * a QUALIFIED_RFQ-or-higher disclosure, never a bare market-tier one).
 */
const CAPACITY_MARKET_FIELD_CLASSES = {
  providerOrgId: "RESTRICTED",
  freshnessClass: "MEMBER_MARKET",
  acceptingNewVolume: "MEMBER_MARKET",
  jurisdictions: "MEMBER_MARKET",
  mccsAccepted: "MEMBER_MARKET",
  currency: "MEMBER_MARKET",
  monthlyCapacityBand: "MEMBER_MARKET",
  riskTier: "MEMBER_MARKET",
  monthlyCapacityMinor: "SECRET",
  minTicketMinor: "RESTRICTED",
  maxTicketMinor: "RESTRICTED",
  maxChargebackBps: "RESTRICTED",
  maxFraudBps: "RESTRICTED",
  maxRefundBps: "RESTRICTED",
  settlementRail: "RESTRICTED",
  settlementCadenceDays: "RESTRICTED",
  commercialTerms: "SECRET",
} as const;

export function toMarketplaceCapacityCard(actor: Actor, profile: CapacityProfile, liveFreshnessClass: CapacityProfile["freshnessClass"]): MarketplaceCapacityCard | null {
  // Deliberately null — see this file's header comment ("UNIFORM
  // CATALOG, NOT A PER-VIEWER DASHBOARD"): isOwnerView is always false
  // for this specific redaction call, for every actor.
  const resource: Resource = { type: "capacity_profile", id: profile.id, ownerOrgId: null };

  const visible = redactFields(
    actor,
    resource,
    {
      providerOrgId: profile.providerOrgId,
      freshnessClass: liveFreshnessClass,
      acceptingNewVolume: profile.acceptingNewVolume,
      jurisdictions: profile.jurisdictions as string[],
      mccsAccepted: profile.mccsAccepted as string[],
      currency: profile.currency,
      monthlyCapacityBand: bandVolume(profile.monthlyCapacityMinor),
      riskTier: bandRiskTier(profile.maxChargebackBps, profile.maxFraudBps, profile.maxRefundBps),
      monthlyCapacityMinor: profile.monthlyCapacityMinor.toString(),
      minTicketMinor: profile.minTicketMinor,
      maxTicketMinor: profile.maxTicketMinor,
      maxChargebackBps: profile.maxChargebackBps,
      maxFraudBps: profile.maxFraudBps,
      maxRefundBps: profile.maxRefundBps,
      settlementRail: profile.settlementRail,
      settlementCadenceDays: profile.settlementCadenceDays,
      commercialTerms: profile.commercialTerms,
    },
    CAPACITY_MARKET_FIELD_CLASSES,
    // Explicit SECRET fallback (not the generic MEMBER_MARKET default) —
    // any field added to the object above WITHOUT an explicit
    // FIELD_CLASSES tag fails CLOSED (hidden) rather than silently
    // inheriting a permissive default.
    "SECRET",
  );

  // acceptingNewVolume/freshnessClass/jurisdictions/mccsAccepted/
  // currency/monthlyCapacityBand/riskTier are ALL tagged MEMBER_MARKET
  // above and MEMBER_MARKET is the default cross-org ceiling for every
  // authenticated actor (packages/authz/src/field-policy.ts's
  // CROSS_ORG_CEILING) — so for any actor who legitimately reached this
  // function at all (already passed can(actor, "capacity.browse_market",
  // ...) one layer up), these 7 fields are ALWAYS present. A null
  // return only happens for the structurally-impossible case of a
  // role-less actor (can() would already have denied capacity.browse_market
  // before this function is ever called).
  if (
    visible.freshnessClass === undefined ||
    visible.acceptingNewVolume === undefined ||
    visible.jurisdictions === undefined ||
    visible.mccsAccepted === undefined ||
    visible.currency === undefined ||
    visible.monthlyCapacityBand === undefined ||
    visible.riskTier === undefined
  ) {
    return null;
  }

  return {
    cardId: profile.id,
    freshnessClass: visible.freshnessClass,
    acceptingNewVolume: visible.acceptingNewVolume,
    jurisdictions: visible.jurisdictions,
    mccsAccepted: visible.mccsAccepted,
    currency: visible.currency,
    monthlyCapacityBand: visible.monthlyCapacityBand,
    riskTier: visible.riskTier,
  };
}

const OPPORTUNITY_MARKET_FIELD_CLASSES = {
  ownerOrgId: "RESTRICTED",
  opportunityType: "MEMBER_MARKET",
  status: "MEMBER_MARKET",
  currency: "MEMBER_MARKET",
  jurisdictions: "MEMBER_MARKET",
  mccs: "MEMBER_MARKET",
  offeredVolumeBand: "MEMBER_MARKET",
  totalPaymentVolumeMinor: "SECRET",
  totalCardGpvMinor: "SECRET",
  eligibleCardGpvMinor: "SECRET",
  offeredCardGpvMinor: "SECRET",
  movableNowMinor: "RESTRICTED",
  movable30dMinor: "RESTRICTED",
  movable90dMinor: "RESTRICTED",
} as const;

export function toMarketplaceOpportunityCard(actor: Actor, opportunity: Opportunity): MarketplaceOpportunityCard | null {
  const resource: Resource = { type: "opportunity", id: opportunity.id, ownerOrgId: null };

  const visible = redactFields(
    actor,
    resource,
    {
      ownerOrgId: opportunity.ownerOrgId,
      opportunityType: opportunity.opportunityType,
      status: opportunity.status,
      currency: opportunity.currency,
      jurisdictions: opportunity.jurisdictions as string[],
      mccs: opportunity.mccs as string[],
      offeredVolumeBand: bandVolume(opportunity.offeredCardGpvMinor),
      totalPaymentVolumeMinor: opportunity.totalPaymentVolumeMinor.toString(),
      totalCardGpvMinor: opportunity.totalCardGpvMinor.toString(),
      eligibleCardGpvMinor: opportunity.eligibleCardGpvMinor.toString(),
      offeredCardGpvMinor: opportunity.offeredCardGpvMinor.toString(),
      movableNowMinor: opportunity.movableNowMinor.toString(),
      movable30dMinor: opportunity.movable30dMinor.toString(),
      movable90dMinor: opportunity.movable90dMinor.toString(),
    },
    OPPORTUNITY_MARKET_FIELD_CLASSES,
    "SECRET",
  );

  if (
    visible.opportunityType === undefined ||
    visible.status === undefined ||
    visible.currency === undefined ||
    visible.jurisdictions === undefined ||
    visible.mccs === undefined ||
    visible.offeredVolumeBand === undefined
  ) {
    return null;
  }

  return {
    cardId: opportunity.id,
    opportunityType: visible.opportunityType,
    status: visible.status,
    currency: visible.currency,
    jurisdictions: visible.jurisdictions,
    mccs: visible.mccs,
    offeredVolumeBand: visible.offeredVolumeBand,
  };
}
