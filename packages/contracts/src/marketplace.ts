// packages/contracts/src/marketplace.ts — the spec/p.6 (P5 Marketplace
// gate): "Members can see market depth, categories of capacity and
// anonymized opportunity inventory. Named contacts, exact appetite,
// private rates, underwriting evidence and contributor economics remain
// permissioned." p.22's disclosure-tier table names MATCH_SUMMARY as
// "Anonymized jurisdiction, volume band, MCC class, readiness" — this
// file's two card DTOs ARE that tier, made concrete for Opportunity and
// CapacityProfile.
//
// STRUCTURAL REDACTION, NOT JUST RUNTIME REDACTION: these schemas
// deliberately do NOT declare a `providerOrgId`/`ownerOrgId`,
// `commercialTerms`, or any exact risk/volume figure field AT ALL — the
// TYPE itself has no slot for that data, so a future maintainer adding a
// field to the mapper without updating this schema gets a Zod validation
// failure, not a silent leak. This is the wire-contract half of the P5
// server-side-redaction proof; apps/api's marketplace mapper (the other
// half) is what actually calls @tol/authz's redactFields() to PRODUCE a
// value shaped like this from a full CapacityProfile/Opportunity row.

import { z } from "zod";
import { UuidSchema } from "./common.js";
// Re-uses capacity.ts's own FRESHNESS_CLASS_VALUES export (identical
// vocabulary, not re-declared here) to avoid a duplicate-export
// collision at this package's index.ts barrel.
import { FRESHNESS_CLASS_VALUES as MARKET_FRESHNESS_CLASS_VALUES } from "./capacity.js";

/**
 * A coarse, non-reversible bucket over an exact minor-units figure —
 * the spec's own "volume band" language, made concrete. Deliberately
 * WIDE bands (not e.g. $100K increments) so a market browser cannot
 * narrow down a competitor's exact volume by bisecting across many
 * requests. Computed by apps/api's marketplace mapper (bandVolume()),
 * never stored — the exact figure never leaves the mapper function that
 * produces this label.
 */
export const VOLUME_BAND_VALUES = ["UNDER_100K", "100K_1M", "1M_5M", "5M_20M", "20M_PLUS"] as const;
export const VolumeBandSchema = z.enum(VOLUME_BAND_VALUES);
export type VolumeBand = z.infer<typeof VolumeBandSchema>;

export const RISK_TIER_VALUES = ["LOW", "MODERATE", "ELEVATED"] as const;
export const RiskTierSchema = z.enum(RISK_TIER_VALUES);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const MarketFreshnessClassSchema = z.enum(MARKET_FRESHNESS_CLASS_VALUES);

/**
 * the spec route table: "/app/market || Visible Marketplace ||
 * Anonymized supply/demand inventory." Every field here is safe at
 * MEMBER_MARKET tier or below — no provider identity, no exact figures,
 * no commercial terms. `cardId` is the underlying CapacityProfile's own
 * id (safe on its own — an opaque UUIDv7, not a resolvable identity,
 * per the spec's "never expose sequential DB IDs" ID convention).
 */
export const MarketplaceCapacityCardSchema = z
  .object({
    cardId: UuidSchema,
    freshnessClass: MarketFreshnessClassSchema,
    acceptingNewVolume: z.boolean(),
    jurisdictions: z.array(z.string()),
    mccsAccepted: z.array(z.string()),
    currency: z.string().length(3),
    monthlyCapacityBand: VolumeBandSchema,
    riskTier: RiskTierSchema,
  })
  .strict();
export type MarketplaceCapacityCard = z.infer<typeof MarketplaceCapacityCardSchema>;

export const MarketplaceOpportunityCardSchema = z
  .object({
    cardId: UuidSchema,
    opportunityType: z.enum(["ACQUIRING", "PSP_ROUTING", "BACKUP_PROCESSING"]),
    status: z.string(),
    currency: z.string().length(3),
    jurisdictions: z.array(z.string()),
    mccs: z.array(z.string()),
    offeredVolumeBand: VolumeBandSchema,
  })
  .strict();
export type MarketplaceOpportunityCard = z.infer<typeof MarketplaceOpportunityCardSchema>;

export const ListMarketplaceCapacityResponseSchema = z.object({ cards: z.array(MarketplaceCapacityCardSchema) });
export type ListMarketplaceCapacityResponse = z.infer<typeof ListMarketplaceCapacityResponseSchema>;

export const ListMarketplaceOpportunitiesResponseSchema = z.object({ cards: z.array(MarketplaceOpportunityCardSchema) });
export type ListMarketplaceOpportunitiesResponse = z.infer<typeof ListMarketplaceOpportunitiesResponseSchema>;
