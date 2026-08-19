import { z } from "zod";
import { MembershipStatusSchema, PersonaRoleSchema, UuidSchema } from "./common.js";

export const MembershipDTOSchema = z.object({
  id: UuidSchema,
  organizationId: UuidSchema,
  userId: UuidSchema,
  role: PersonaRoleSchema,
  status: MembershipStatusSchema,
  invitationSource: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
});
export type MembershipDTO = z.infer<typeof MembershipDTOSchema>;

export const CreateMembershipRequestSchema = z.object({
  userId: UuidSchema,
  role: PersonaRoleSchema,
  invitationSource: z.string().max(200).optional(),
});
export type CreateMembershipRequest = z.infer<typeof CreateMembershipRequestSchema>;

export const UpdateMembershipStatusRequestSchema = z.object({
  status: MembershipStatusSchema,
});
export type UpdateMembershipStatusRequest = z.infer<typeof UpdateMembershipStatusRequestSchema>;

export const UpdateMembershipRoleRequestSchema = z.object({
  role: PersonaRoleSchema,
});
export type UpdateMembershipRoleRequest = z.infer<typeof UpdateMembershipRoleRequestSchema>;

export const ListMembershipsResponseSchema = z.object({
  memberships: z.array(MembershipDTOSchema),
});
export type ListMembershipsResponse = z.infer<typeof ListMembershipsResponseSchema>;
