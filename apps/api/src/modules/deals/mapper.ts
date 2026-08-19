// apps/api/src/modules/deals/mapper.ts — the spec (P14 gate).

import type { DealCondition, DealDecision, DealRoom, DealRoomParticipant, DomainEvent, Organization } from "@tol/db";
import type {
  DealConditionDTO,
  DealDecisionDTO,
  DealRoomDTO,
  DealRoomParticipantDTO,
  TimelineEventDTO,
} from "@tol/contracts";

export function toDealRoomParticipantDTO(participant: DealRoomParticipant, org?: Organization): DealRoomParticipantDTO {
  return {
    id: participant.id,
    dealRoomId: participant.dealRoomId,
    organizationId: participant.organizationId,
    organizationDisplayName: org?.displayName,
    participantRole: participant.participantRole,
  };
}

export function toDealConditionDTO(condition: DealCondition): DealConditionDTO {
  return {
    id: condition.id,
    dealRoomId: condition.dealRoomId,
    description: condition.description,
    ownerOrgId: condition.ownerOrgId,
    evidenceRef: condition.evidenceRef,
    dueAt: condition.dueAt ? condition.dueAt.toISOString() : null,
    state: condition.state,
    blocking: condition.blocking,
    resolutionNote: condition.resolutionNote,
    updatedAt: condition.updatedAt.toISOString(),
  };
}

export function toDealDecisionDTO(decision: DealDecision): DealDecisionDTO {
  return {
    id: decision.id,
    dealRoomId: decision.dealRoomId,
    decisionType: decision.decisionType,
    reason: decision.reason,
    relatedQuoteId: decision.relatedQuoteId,
    actorOrgId: decision.actorOrgId,
    actorRole: decision.actorRole,
    decidedAt: decision.decidedAt.toISOString(),
  };
}

export function toTimelineEventDTO(event: DomainEvent): TimelineEventDTO {
  return {
    id: event.id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: (event.payload as Record<string, unknown> | null) ?? null,
    occurredAt: event.occurredAt.toISOString(),
    actorOrgId: event.actorOrgId,
    actorRole: event.actorRole,
  };
}

export function toDealRoomDTO(
  dealRoom: DealRoom,
  opts: {
    participants?: DealRoomParticipant[];
    conditions?: DealCondition[];
    decisions?: DealDecision[];
  },
): DealRoomDTO {
  return {
    id: dealRoom.id,
    opportunityId: dealRoom.opportunityId,
    rfqId: dealRoom.rfqId,
    selectedQuoteId: dealRoom.selectedQuoteId,
    merchantOrgId: dealRoom.merchantOrgId,
    providerOrgId: dealRoom.providerOrgId,
    status: dealRoom.status,
    nextAction: dealRoom.nextAction,
    participants: opts.participants ? opts.participants.map((p) => toDealRoomParticipantDTO(p)) : undefined,
    conditions: opts.conditions ? opts.conditions.map(toDealConditionDTO) : undefined,
    decisions: opts.decisions ? opts.decisions.map(toDealDecisionDTO) : undefined,
  };
}
