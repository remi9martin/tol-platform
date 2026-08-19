// packages/db/src/repositories/domain-event.repository.ts
//
// The p.22 "Timeline" surface's persistence — "immutable domain events
// rendered for users." Distinct from audit.repository.ts's AuditEvent
// (p.12: domain events are append-only FACTS; audit events capture WHO
// viewed/changed RESTRICTED values) — apps/api's rfqs/deals services
// write to BOTH on a timeline-worthy restricted action, for the two
// different reasons those two tables exist. Only `write`/list queries are
// exposed — like audit.repository.ts, there is no update/delete path
// anywhere in the application layer.

import { Prisma } from "@prisma/client";
import type { DomainEvent, PersonaRole } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

/** Same undefined/null -> Prisma JSON input mapping as audit.repository.ts's toJsonInput — kept as its own copy (not imported cross-file) so each repository file stays independently readable, matching this package's existing per-file-repeats-the-small-helper style. */
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === Prisma.JsonNull) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export interface DomainEventWriteInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload?: unknown;
  actorUserId: string | null;
  actorOrgId: string | null;
  actorRole: PersonaRole | null;
  requestId?: string | null;
  correlationId?: string | null;
}

export const domainEventRepository = {
  async write(db: DbClient, input: DomainEventWriteInput): Promise<DomainEvent> {
    return db.domainEvent.create({
      data: {
        id: newId(),
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: toJsonInput(input.payload),
        actorUserId: input.actorUserId,
        actorOrgId: input.actorOrgId,
        actorRole: input.actorRole,
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  },

  /** THE timeline read (p.22, P14's "timeline" exit-condition slice) — every DomainEvent for one aggregate instance, chronological. apps/api's deals service also merges the parent RFQ's own events (aggregateType "rfq", aggregateId = the RFQ that led to this deal) so the rendered timeline includes "RFQ sent" / "Quote submitted" entries from before the deal room existed, not just deal_room-typed events — see deals/service.ts's getTimeline. */
  async listByAggregate(db: DbClient, aggregateType: string, aggregateId: string): Promise<DomainEvent[]> {
    return db.domainEvent.findMany({
      where: { aggregateType, aggregateId },
      orderBy: { occurredAt: "asc" },
    });
  },

  /** Convenience for deals/service.ts's merged timeline — events across MULTIPLE (aggregateType, aggregateId) pairs, chronological. */
  async listByAggregates(db: DbClient, pairs: Array<{ aggregateType: string; aggregateId: string }>): Promise<DomainEvent[]> {
    if (pairs.length === 0) return [];
    return db.domainEvent.findMany({
      where: { OR: pairs.map((p) => ({ aggregateType: p.aggregateType, aggregateId: p.aggregateId })) },
      orderBy: { occurredAt: "asc" },
    });
  },
};
