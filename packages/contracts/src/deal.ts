// packages/contracts/src/deal.ts — the spec. P14's "conditions +
// decisions + timeline" gate exit condition, wire-contracted.

import { z } from "zod";
import { UuidSchema } from "./common.js";

export const DEAL_ROOM_STATUS_VALUES = ["OPEN", "CONDITIONS", "APPROVED", "DECLINED", "ACTIVATION", "LIVE", "ARCHIVED"] as const;
export const DealRoomStatusSchema = z.enum(DEAL_ROOM_STATUS_VALUES);

export const DEAL_PARTICIPANT_ROLE_VALUES = ["MERCHANT", "PROVIDER", "OPERATOR"] as const;
export const DealParticipantRoleSchema = z.enum(DEAL_PARTICIPANT_ROLE_VALUES);

export const DEAL_CONDITION_STATE_VALUES = ["PENDING", "SATISFIED", "WAIVED", "REJECTED"] as const;
export const DealConditionStateSchema = z.enum(DEAL_CONDITION_STATE_VALUES);

export const DEAL_DECISION_TYPE_VALUES = ["QUOTE_SELECTED", "APPROVAL", "DECLINE", "EXCEPTION"] as const;
export const DealDecisionTypeSchema = z.enum(DEAL_DECISION_TYPE_VALUES);

export const DealRoomParticipantDTOSchema = z.object({
  id: UuidSchema,
  dealRoomId: UuidSchema,
  organizationId: UuidSchema,
  organizationDisplayName: z.string().optional(),
  participantRole: DealParticipantRoleSchema,
});
export type DealRoomParticipantDTO = z.infer<typeof DealRoomParticipantDTOSchema>;

export const DealConditionDTOSchema = z.object({
  id: UuidSchema,
  dealRoomId: UuidSchema,
  description: z.string(),
  ownerOrgId: UuidSchema,
  evidenceRef: z.string().nullable(),
  dueAt: z.string().nullable(),
  state: DealConditionStateSchema,
  blocking: z.boolean(),
  resolutionNote: z.string().nullable(),
  updatedAt: z.string(),
});
export type DealConditionDTO = z.infer<typeof DealConditionDTOSchema>;

export const DealDecisionDTOSchema = z.object({
  id: UuidSchema,
  dealRoomId: UuidSchema,
  decisionType: DealDecisionTypeSchema,
  reason: z.string(),
  relatedQuoteId: UuidSchema.nullable(),
  actorOrgId: UuidSchema.nullable(),
  actorRole: z.string().nullable(),
  decidedAt: z.string(),
});
export type DealDecisionDTO = z.infer<typeof DealDecisionDTOSchema>;

export const DealRoomDTOSchema = z.object({
  id: UuidSchema,
  opportunityId: UuidSchema,
  rfqId: UuidSchema,
  selectedQuoteId: UuidSchema,
  merchantOrgId: UuidSchema,
  providerOrgId: UuidSchema,
  status: DealRoomStatusSchema,
  nextAction: z.string().nullable(),
  participants: z.array(DealRoomParticipantDTOSchema).optional(),
  conditions: z.array(DealConditionDTOSchema).optional(),
  decisions: z.array(DealDecisionDTOSchema).optional(),
});
export type DealRoomDTO = z.infer<typeof DealRoomDTOSchema>;

/** The p.22 "Timeline" surface — a rendered DomainEvent. `payload` stays loosely typed here (a display-only projection of whichever @tol/events payload shape produced it); apps/web renders it generically, it does not need per-type narrowing to show a timeline row. */
export const TimelineEventDTOSchema = z.object({
  id: UuidSchema,
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  occurredAt: z.string(),
  actorOrgId: UuidSchema.nullable(),
  actorRole: z.string().nullable(),
});
export type TimelineEventDTO = z.infer<typeof TimelineEventDTOSchema>;

export const TimelineResponseSchema = z.object({ events: z.array(TimelineEventDTOSchema) });
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;

// ---- Requests ----

export const PostConditionRequestSchema = z.object({
  description: z.string().min(1).max(1000),
  ownerOrgId: UuidSchema,
  evidenceRef: z.string().max(500).optional(),
  dueAt: z.string().datetime().optional(),
  blocking: z.boolean().optional(),
});
export type PostConditionRequest = z.infer<typeof PostConditionRequestSchema>;

export const ResolveConditionRequestSchema = z.object({
  state: z.enum(["SATISFIED", "WAIVED", "REJECTED"]),
  resolutionNote: z.string().max(1000).optional(),
});
export type ResolveConditionRequest = z.infer<typeof ResolveConditionRequestSchema>;

export const RecordDecisionRequestSchema = z.object({
  decisionType: z.enum(["APPROVAL", "DECLINE", "EXCEPTION"]), // QUOTE_SELECTED is system-recorded only (rfq.select_quote), never a direct client request — see deals/service.ts.
  reason: z.string().min(1).max(1000),
});
export type RecordDecisionRequest = z.infer<typeof RecordDecisionRequestSchema>;

export const ListDealRoomsResponseSchema = z.object({ deals: z.array(DealRoomDTOSchema) });
export type ListDealRoomsResponse = z.infer<typeof ListDealRoomsResponseSchema>;
