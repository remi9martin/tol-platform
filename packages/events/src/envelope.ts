// packages/events/src/envelope.ts
//
// the spec: "Domain events are append-only [facts]." Distinct from
// AuditEvent (p.12: "audit events capture who viewed or changed
// restricted values") — @tol/db's DomainEvent table (packages/db/prisma/
// schema.prisma) is this envelope's persisted form; that model's own
// comment explains why it follows AuditEvent's earlier shape rather than
// the full base-audit-column set (it's the same "append-only infra log"
// category). This package stays persistence-agnostic on purpose (same
// "zero runtime dependencies" discipline as @tol/authz/@tol/domain — see
// their READMEs/file headers) — apps/api's services build a
// DomainEventEnvelope using the typed catalog in rfq-events.ts/
// deal-events.ts, then hand it to @tol/db's domainEventRepository.write().

/**
 * `actorRole` is a plain string, not @tol/authz's PersonaRole type — this
 * package has no dependency on @tol/authz (a domain-event ENVELOPE is a
 * generic concept; the specific role vocabulary is authz's business, not
 * this package's). Callers (apps/api) pass `actor.role` directly; the
 * string values happen to line up because both packages are ultimately
 * grounded in the same the spec persona list, not because of a type
 * dependency between them.
 */
export interface DomainEventEnvelope<TType extends string = string, TPayload = Record<string, unknown>> {
  eventType: TType;
  /** What kind of aggregate this event is about — "rfq" | "deal_room" | "quote" today; a plain string (not a closed union) so a later day's new aggregate type doesn't require an envelope-shape change. */
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  actorUserId: string | null;
  actorOrgId: string | null;
  actorRole: string | null;
  requestId?: string | null;
  correlationId?: string | null;
}

/**
 * Convenience constructor — mostly exists so call sites read as "build an
 * envelope" rather than a bare object literal, and so a future field
 * addition to DomainEventEnvelope has exactly one call-site shape to
 * update per event-construction site instead of many ad hoc literals.
 * Does NOT stamp `id`/`occurredAt` — those are @tol/db's
 * domainEventRepository.write()'s job (id via newId(), occurredAt via
 * the column default), keeping this package free of any ID-generation
 * or clock dependency.
 *
 * Returns a frozen (shallow) copy rather than the input reference
 * directly — review (review,
 * 2026-08-18) correctly noted a plain pass-through lets a caller mutate
 * the object after building it, before it reaches
 * domainEventRepository.write(). A full deep-freeze/deep-copy would be
 * overkill for a per-request, single-consumer object every real call
 * site (apps/api's rfqs/deals services) constructs fresh and hands off
 * immediately — this is cheap insurance against exactly the "held onto
 * and mutated later" class of bug, not a general immutable-data-
 * structure guarantee.
 */
export function buildDomainEvent<TType extends string, TPayload extends Record<string, unknown>>(
  input: DomainEventEnvelope<TType, TPayload>,
): Readonly<DomainEventEnvelope<TType, TPayload>> {
  return Object.freeze({ ...input });
}
