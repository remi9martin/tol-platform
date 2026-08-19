// apps/api/src/shared/timeline.ts
//
// The earlier analog of shared/audit.ts, for @tol/db's DomainEvent table
// (distinct from AuditEvent — see that model's own schema comment).
// Services never call domainEventRepository.write() directly; every
// timeline-worthy mutation goes through here, the same way every
// restricted action goes through auditWriter() — so a rfqs/deals service
// function typically calls BOTH auditWriter(context).write(...) (who did
// this, for the security/compliance trail) AND timelineWriter(context).
// write(...) (what happened to the aggregate, for the p.22 "Timeline"
// UI surface). Takes a DbClient (not the global `prisma`) for the same
// reason auditWriter does — so the event commits/rolls back atomically
// with the mutation it records, inside the caller's own transaction.

import type { PersonaRole } from "@tol/authz";
import { domainEventRepository, type DomainEvent, type DbClient } from "@tol/db";
import type { RequestContext } from "./request-context.js";

export interface TimelineWriteInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown> | null;
  actorUserId: string | null;
  actorOrgId: string | null;
  actorRole: PersonaRole | null;
}

export interface TimelineWriter {
  write(db: DbClient, input: TimelineWriteInput): Promise<DomainEvent>;
}

export function timelineWriter(context: RequestContext): TimelineWriter {
  return {
    async write(db: DbClient, input: TimelineWriteInput): Promise<DomainEvent> {
      return domainEventRepository.write(db, {
        ...input,
        requestId: context.requestId,
        correlationId: context.correlationId,
      });
    },
  };
}
