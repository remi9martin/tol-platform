// packages/contracts/src/opportunity.ts — the spec.
//
// Money fields (totalPaymentVolumeMinor etc.) are Prisma BigInt columns
// (packages/db/prisma/schema.prisma's earlier header explains the Int-vs-
// BigInt split) — represented on the WIRE as numeric strings, never a
// bare JSON number, so large volume figures never round-trip through
// JS's Number precision ceiling (2^53) on either side. Request-side
// accepts the same numeric-string shape and apps/api's mapper converts
// to/from bigint at the boundary (packages/contracts never imports
// @tol/db, so it cannot use the `bigint` TS type meaningfully here
// anyway — a validated numeric string is the correct wire contract
// regardless of which language reads it).

import { z } from "zod";
import { DisclosureClassSchema, UuidSchema } from "./common.js";

export const OPPORTUNITY_TYPE_VALUES = ["ACQUIRING", "PSP_ROUTING", "BACKUP_PROCESSING"] as const;
export const OpportunityTypeSchema = z.enum(OPPORTUNITY_TYPE_VALUES);

export const OPPORTUNITY_STATUS_VALUES = [
  "DRAFT",
  "READINESS_BLOCKED",
  "MATCH_READY",
  "INVITED",
  "QUOTED",
  "SELECTED",
  "ACTIVATING",
  "LIVE",
  "CLOSED",
] as const;
export const OpportunityStatusSchema = z.enum(OPPORTUNITY_STATUS_VALUES);

/** Non-negative integer, wire-encoded as a string (see file header). */
const MinorUnitsStringSchema = z.string().regex(/^\d+$/, "must be a non-negative integer string");

export const OpportunityDTOSchema = z.object({
  id: UuidSchema,
  ownerOrgId: UuidSchema,
  opportunityType: OpportunityTypeSchema,
  requestedService: z.string(),
  status: OpportunityStatusSchema,
  currency: z.string().length(3),
  totalPaymentVolumeMinor: MinorUnitsStringSchema,
  totalCardGpvMinor: MinorUnitsStringSchema,
  eligibleCardGpvMinor: MinorUnitsStringSchema,
  offeredCardGpvMinor: MinorUnitsStringSchema,
  movableNowMinor: MinorUnitsStringSchema,
  movable30dMinor: MinorUnitsStringSchema,
  movable90dMinor: MinorUnitsStringSchema,
  jurisdictions: z.array(z.string()),
  mccs: z.array(z.string()),
  privacyClass: DisclosureClassSchema,
});
export type OpportunityDTO = z.infer<typeof OpportunityDTOSchema>;

export const CreateOpportunityRequestSchema = z.object({
  opportunityType: OpportunityTypeSchema,
  requestedService: z.string().min(1).max(300),
  currency: z.string().length(3),
  totalPaymentVolumeMinor: MinorUnitsStringSchema.optional(),
  totalCardGpvMinor: MinorUnitsStringSchema.optional(),
  eligibleCardGpvMinor: MinorUnitsStringSchema.optional(),
  offeredCardGpvMinor: MinorUnitsStringSchema.optional(),
  movableNowMinor: MinorUnitsStringSchema.optional(),
  movable30dMinor: MinorUnitsStringSchema.optional(),
  movable90dMinor: MinorUnitsStringSchema.optional(),
  jurisdictions: z.array(z.string().min(2).max(8)).max(50).optional(),
  mccs: z.array(z.string().min(1).max(8)).max(50).optional(),
});
export type CreateOpportunityRequest = z.infer<typeof CreateOpportunityRequestSchema>;

export const ListOpportunitiesResponseSchema = z.object({ opportunities: z.array(OpportunityDTOSchema) });
export type ListOpportunitiesResponse = z.infer<typeof ListOpportunitiesResponseSchema>;

// =================================================================
// earlier: P7 VolumeSlice + volume reconciliation.
// See @tol/domain/src/volume-reconciliation.ts for the reconciliation
// math this DTO set exists to surface over the wire.
// =================================================================

export const VolumeSliceDTOSchema = z.object({
  id: UuidSchema,
  opportunityId: UuidSchema,
  jurisdiction: z.string().length(2),
  mcc: z.string(),
  cardOrigin: z.string(),
  channel: z.string(),
  currency: z.string().length(3),
  amountMinor: MinorUnitsStringSchema,
  period: z.string(),
});
export type VolumeSliceDTO = z.infer<typeof VolumeSliceDTOSchema>;

const VolumeSliceInputSchema = z.object({
  jurisdiction: z.string().length(2),
  mcc: z.string().min(1).max(8),
  cardOrigin: z.enum(["DOMESTIC", "INTERNATIONAL"]),
  channel: z.enum(["ECOMMERCE", "CARD_PRESENT", "MOTO"]),
  amountMinor: MinorUnitsStringSchema,
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
});

/**
 * Replaces the Opportunity's ENTIRE volume-slice breakdown in one call
 * (apps/api's service wraps a delete-all + recreate in one transaction,
 * @tol/db's volumeSliceRepository.deleteAllByOpportunity + create) —
 * matches p.15's own framing of the breakdown as ONE reconcilable whole,
 * not a set of independently-patchable cells that could drift out of
 * sync with each other mid-edit.
 */
export const ReplaceVolumeSlicesRequestSchema = z.object({
  slices: z.array(VolumeSliceInputSchema).max(2000),
});
export type ReplaceVolumeSlicesRequest = z.infer<typeof ReplaceVolumeSlicesRequestSchema>;

export const VolumeMismatchDTOSchema = z.object({
  code: z.enum(["duplicate_cell", "sum_mismatch", "movability_order", "currency_mismatch"]),
  message: z.string(),
});

/** Mirrors @tol/domain's VolumeReconciliationResult field-for-field — the wire response carries the SAME real check the domain engine computed, never just a bare boolean (same explainability discipline as ClaimScoreBreakdown, ADR-0004). */
export const VolumeReconciliationDTOSchema = z.object({
  reconciled: z.boolean(),
  sliceTotalMinor: MinorUnitsStringSchema,
  offeredCardGpvMinor: MinorUnitsStringSchema,
  mismatches: z.array(VolumeMismatchDTOSchema),
});
export type VolumeReconciliationDTO = z.infer<typeof VolumeReconciliationDTOSchema>;

export const VolumeSlicesResponseSchema = z.object({
  slices: z.array(VolumeSliceDTOSchema),
  reconciliation: VolumeReconciliationDTOSchema,
});
export type VolumeSlicesResponse = z.infer<typeof VolumeSlicesResponseSchema>;
