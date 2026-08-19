// packages/contracts/src/capacity.ts — the spec.
// See opportunity.ts's file header for why large money fields are
// numeric strings on the wire, not bare JSON numbers.

import { z } from "zod";
import { DisclosureClassSchema, UuidSchema } from "./common.js";

export const FRESHNESS_CLASS_VALUES = ["FRESH", "AGING", "STALE", "UNKNOWN"] as const;
export const FreshnessClassSchema = z.enum(FRESHNESS_CLASS_VALUES);

const MinorUnitsStringSchema = z.string().regex(/^\d+$/, "must be a non-negative integer string");
const BpsSchema = z.number().int().min(0).max(1_000_000);

/** p.16 CommercialTermTemplate ("MDR/buy rate model, fixed fees, reserve, settlement, validity") — every amount integer bps/minor units, never a float (p.12). Validated here (wire boundary) AND defensively again inside @tol/db's json-guards.ts (persistence boundary) — deliberate belt-and-suspenders, not redundant by accident. */
export const CommercialTermsSchema = z.object({
  mdrBps: BpsSchema,
  fixedFeeMinor: z.number().int().nonnegative(),
  model: z.enum(["blended", "interchange_plus", "flat"]),
});
export type CommercialTerms = z.infer<typeof CommercialTermsSchema>;

export const CapacityProfileDTOSchema = z.object({
  id: UuidSchema,
  providerOrgId: UuidSchema,
  asOf: z.string(),
  freshnessClass: FreshnessClassSchema,
  acceptingNewVolume: z.boolean(),
  jurisdictions: z.array(z.string()),
  mccsAccepted: z.array(z.string()),
  mccsExcluded: z.array(z.string()),
  currency: z.string().length(3),
  monthlyCapacityMinor: MinorUnitsStringSchema,
  minTicketMinor: z.number().int().nonnegative(),
  maxTicketMinor: z.number().int().nonnegative(),
  maxChargebackBps: BpsSchema,
  maxFraudBps: BpsSchema,
  maxRefundBps: BpsSchema,
  settlementRail: z.string(),
  settlementCadenceDays: z.number().int().nonnegative(),
  commercialTerms: CommercialTermsSchema.nullable(),
  privacyClass: DisclosureClassSchema,
});
export type CapacityProfileDTO = z.infer<typeof CapacityProfileDTOSchema>;

/**
 * earlier (P8): `freshnessClass` is DELIBERATELY ABSENT from this request
 * schema — pre-earlier it was client-suppliable (defaulting to "FRESH"
 * when omitted), which is exactly the gap P8's exit condition exists to
 * close: freshness must be a DETERMINISTIC, SERVER-COMPUTED
 * classification (@tol/evidence's classifyCapacityFreshness), never
 * something a caller asserts about itself. apps/api's capacity service
 * computes it from `asOf`/`sourceType` on every create AND on every
 * read — see that service's own comment.
 */
export const CreateCapacityProfileRequestSchema = z.object({
  acceptingNewVolume: z.boolean().optional(),
  jurisdictions: z.array(z.string().min(2).max(8)).max(50).optional(),
  mccsAccepted: z.array(z.string().min(1).max(8)).max(50).optional(),
  mccsExcluded: z.array(z.string().min(1).max(8)).max(50).optional(),
  currency: z.string().length(3),
  monthlyCapacityMinor: MinorUnitsStringSchema.optional(),
  minTicketMinor: z.number().int().nonnegative().optional(),
  maxTicketMinor: z.number().int().nonnegative().optional(),
  maxChargebackBps: BpsSchema.optional(),
  maxFraudBps: BpsSchema.optional(),
  maxRefundBps: BpsSchema.optional(),
  settlementRail: z.string().min(1).max(50),
  settlementCadenceDays: z.number().int().nonnegative().optional(),
  commercialTerms: CommercialTermsSchema.optional(),
});
export type CreateCapacityProfileRequest = z.infer<typeof CreateCapacityProfileRequestSchema>;

export const ListCapacityProfilesResponseSchema = z.object({ capacityProfiles: z.array(CapacityProfileDTOSchema) });
export type ListCapacityProfilesResponse = z.infer<typeof ListCapacityProfilesResponseSchema>;
