import { z } from "zod";
import { PersonaRoleSchema, UuidSchema } from "./common.js";

export const AuditEventDTOSchema = z.object({
  id: UuidSchema,
  occurredAt: z.string(),
  actorUserId: UuidSchema.nullable(),
  actorOrgId: UuidSchema.nullable(),
  actorRole: PersonaRoleSchema.nullable(),
  subjectOrgId: UuidSchema.nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AuditEventDTO = z.infer<typeof AuditEventDTOSchema>;

export const ListAuditEventsResponseSchema = z.object({
  events: z.array(AuditEventDTOSchema),
});
export type ListAuditEventsResponse = z.infer<typeof ListAuditEventsResponseSchema>;
