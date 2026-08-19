import { z } from "zod";
import { DisclosureClassSchema, UuidSchema } from "./common.js";

export const ORGANIZATION_TYPE_VALUES = ["PLATFORM", "MERCHANT", "PSP", "ACQUIRER", "PROVIDER", "PARTNER", "OTHER"] as const;
export const OrganizationTypeSchema = z.enum(ORGANIZATION_TYPE_VALUES);

export const VERIFICATION_STATUS_VALUES = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUS_VALUES);

/**
 * Response shape. Every field EXCEPT id/displayName/country/privacyClass
 * is genuinely OPTIONAL on the wire, not just in the DB — apps/api's
 * organization mapper omits a field entirely (rather than sending
 * `null`) whenever the viewer's fieldPolicy ceiling doesn't cover that
 * field's own DisclosureClass tier, so "field present" already carries
 * meaning. displayName/country are PUBLIC_MARKET-tier (visible to any
 * viewer, authenticated or not) and privacyClass is metadata about the
 * record itself, not gated content — those four are the only fields
 * guaranteed present. See apps/api/src/modules/organizations/mapper.ts.
 */
export const OrganizationDTOSchema = z.object({
  id: UuidSchema,
  legalName: z.string().optional(),
  displayName: z.string(),
  entityType: OrganizationTypeSchema.optional(),
  country: z.string().length(2),
  registrationId: z.string().optional(),
  website: z.string().optional(),
  verificationStatus: VerificationStatusSchema.optional(),
  privacyClass: DisclosureClassSchema,
});
export type OrganizationDTO = z.infer<typeof OrganizationDTOSchema>;

export const UpdateOrganizationRequestSchema = z
  .object({
    legalName: z.string().min(1).max(300),
    displayName: z.string().min(1).max(200),
    website: z.string().url().max(2048),
    registrationId: z.string().min(1).max(100),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>;

export const ListOrganizationsResponseSchema = z.object({
  organizations: z.array(OrganizationDTOSchema),
});
export type ListOrganizationsResponse = z.infer<typeof ListOrganizationsResponseSchema>;
