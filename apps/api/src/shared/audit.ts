// apps/api/src/shared/audit.ts
//
// The earlier "audit base" block: every restricted action writes an audit
// event. This is the ONE place services call to do that — services never
// call auditRepository.write directly, so every audit write goes through
// the same requestId/correlationId/ipClass enrichment.
//
// SAFE-FIELD DISCIPLINE (carried over from the packages/db review
// triage, review "packages/db block" — AuditEvent.beforeValue/
// afterValue MAJOR finding): callers pass explicit, hand-picked
// before/after objects (an allowlist of safe fields), never a raw
// Prisma entity spread. writeAudit() cannot enforce that at the type
// level (the DB column is Json), so it's a discipline documented here
// and followed by every call site in modules/ — see each service's own
// audit write call for the actual field lists.
//
// Takes a DbClient (like every packages/db repository function) rather
// than reaching for the global `prisma` internally, so a service can pass
// its own in-flight `tx` — the audit row then commits or rolls back
// ATOMICALLY with the mutation it records, never orphaned either way.

import type { PersonaRole } from "@tol/authz";
import { auditRepository, type AuditEvent, type DbClient } from "@tol/db";
import type { RequestContext } from "./request-context.js";

export interface AuditWriteInput {
  actorUserId: string | null;
  actorOrgId: string | null;
  actorRole: PersonaRole | null;
  subjectOrgId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeValue?: Record<string, unknown> | null;
  afterValue?: Record<string, unknown> | null;
  reason?: string | null;
}

export interface AuditWriter {
  write(db: DbClient, input: AuditWriteInput): Promise<AuditEvent>;
}

export function auditWriter(context: RequestContext): AuditWriter {
  return {
    async write(db: DbClient, input: AuditWriteInput): Promise<AuditEvent> {
      return auditRepository.write(db, {
        ...input,
        requestId: context.requestId,
        correlationId: context.correlationId,
        ipClass: context.ipClass,
        userAgentClass: context.userAgentClass,
      });
    },
  };
}
