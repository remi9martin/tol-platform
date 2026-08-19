import { Prisma } from "@prisma/client";
import type { AuditEvent, PersonaRole } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

/**
 * Maps a plain-JS "no value" (undefined = field omitted entirely, null =
 * explicitly store JSON null) onto Prisma's JSON input types, which
 * require the `Prisma.JsonNull` sentinel instead of a bare `null` for the
 * "explicitly null" case — passing raw `null` is a TS error against
 * `NullableJsonNullValueInput`.
 */
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === Prisma.JsonNull) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export interface WriteAuditEventInput {
  actorUserId?: string | null;
  actorOrgId?: string | null;
  actorRole?: PersonaRole | null;
  subjectOrgId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  requestId?: string | null;
  correlationId?: string | null;
  ipClass?: string | null;
  userAgentClass?: string | null;
  reason?: string | null;
  metadata?: unknown;
}

/**
 * Append-only by construction: this module exports ONLY `write` and the
 * two list queries below. There is no update/delete function anywhere in
 * this file, and none should ever be added — an audit trail that can be
 * edited after the fact is not an audit trail (the spec: "immutable
 * actor/action/resource/before-after references").
 */
export const auditRepository = {
  async write(db: DbClient, input: WriteAuditEventInput): Promise<AuditEvent> {
    return db.auditEvent.create({
      data: {
        id: newId(),
        actorUserId: input.actorUserId ?? null,
        actorOrgId: input.actorOrgId ?? null,
        actorRole: input.actorRole ?? null,
        subjectOrgId: input.subjectOrgId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        beforeValue: toJsonInput(input.beforeValue),
        afterValue: toJsonInput(input.afterValue),
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        ipClass: input.ipClass ?? null,
        userAgentClass: input.userAgentClass ?? null,
        reason: input.reason ?? null,
        metadata: toJsonInput(input.metadata),
      },
    });
  },

  async listBySubjectOrg(
    db: DbClient,
    subjectOrgId: string,
    opts: { limit?: number } = {},
  ): Promise<AuditEvent[]> {
    return db.auditEvent.findMany({
      where: { subjectOrgId },
      orderBy: { occurredAt: "desc" },
      take: opts.limit ?? 100,
    });
  },

  async listByActor(db: DbClient, actorUserId: string, opts: { limit?: number } = {}): Promise<AuditEvent[]> {
    return db.auditEvent.findMany({
      where: { actorUserId },
      orderBy: { occurredAt: "desc" },
      take: opts.limit ?? 100,
    });
  },
};
