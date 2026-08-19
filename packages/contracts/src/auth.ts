import { z } from "zod";
import { PersonaRoleSchema, UuidSchema } from "./common.js";

export const LoginRequestSchema = z.object({
  email: z.string().email().max(320),
  // bcrypt (packages/db/src/password.ts) silently truncates its input at
  // 72 BYTES — a password longer than that hashes identically to its
  // first-72-bytes prefix, so two genuinely different long passwords
  // could collide. Capping at 72 here (ASCII-safe: 72 chars <= 72 bytes)
  // makes that limit an explicit, honest 400 instead of a silent
  // security footgun. Fixed after review (apps-api-core block,
  // 2026-08-18).
  password: z.string().min(1).max(72),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SwitchOrgRequestSchema = z.object({
  organizationId: UuidSchema,
});
export type SwitchOrgRequest = z.infer<typeof SwitchOrgRequestSchema>;

export const MembershipSummarySchema = z.object({
  membershipId: UuidSchema,
  organizationId: UuidSchema,
  organizationDisplayName: z.string(),
  role: PersonaRoleSchema,
  status: z.string(),
});
export type MembershipSummary = z.infer<typeof MembershipSummarySchema>;

/** Returned by both POST /auth/login and GET /auth/session — the "who am I, acting as what" shape apps/web's layout gates on. */
export const SessionResponseSchema = z.object({
  user: z.object({
    id: UuidSchema,
    email: z.string(),
  }),
  activeMembershipId: UuidSchema.nullable(),
  activeOrganizationId: UuidSchema.nullable(),
  activeRole: PersonaRoleSchema.nullable(),
  memberships: z.array(MembershipSummarySchema),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
