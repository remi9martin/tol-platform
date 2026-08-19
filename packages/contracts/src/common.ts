// packages/contracts/src/common.ts — shared primitives every other schema
// in this package builds on. Kept independent of @tol/db/@tol/authz (same
// "no runtime dependency on a sibling package" discipline as
// packages/authz — see its README) so this package's schemas can be
// validated against plain string literals without pulling in Prisma.

import { z } from "zod";

export const PERSONA_ROLE_VALUES = [
  "PLATFORM_OWNER",
  "MARKETPLACE_OPERATOR",
  "PARTNERSHIP_LEAD",
  "UNDERWRITING_ANALYST",
  "COMPLIANCE_REVIEWER",
  "FINANCE_OPERATOR",
  "CONTRIBUTOR_AGENT",
  "MERCHANT_PSP_USER",
  "ACQUIRER_PROVIDER_USER",
  "AUDITOR_READONLY",
] as const;

export const PersonaRoleSchema = z.enum(PERSONA_ROLE_VALUES);

export const DISCLOSURE_CLASS_VALUES = [
  "PUBLIC_MARKET",
  "MEMBER_MARKET",
  "MATCH_SUMMARY",
  "DEAL_ROOM",
  "RESTRICTED",
  "SECRET",
] as const;

export const DisclosureClassSchema = z.enum(DISCLOSURE_CLASS_VALUES);

export const MEMBERSHIP_STATUS_VALUES = ["INVITED", "ACTIVE", "SUSPENDED", "REVOKED"] as const;
export const MembershipStatusSchema = z.enum(MEMBERSHIP_STATUS_VALUES);

export const UuidSchema = z.string().uuid();

/**
 * RFC-style problem response (the spec: "Use RFC-style problem
 * responses: code, message, requestId, fieldErrors, retryable, and safe
 * details"). Mirrors apps/api/src/shared/errors.ts's ProblemError shape —
 * this is the wire contract; that file is the server-side construction.
 */
export const ProblemDetailsSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
