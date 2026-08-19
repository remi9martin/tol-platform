# ADR-0008: RFQ/Deal Room structural choices — two-sided authorization, scoping, money split, event shape

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** Product, within the bounds of the build's
own instructions (extend the conventions — repository layer, `can()` on every
mutation, problem+json, idempotency, base audit columns, UUIDv7 app-side IDs — rather
than inventing a new architecture).

## Context

The build established a single-sided authorization model: every resource has exactly one owning
organization (`ownerOrgId`), and `can(actor, action, resource)` grants access either
because the actor's org matches `ownerOrgId`, or because the actor's persona holds the
action in a small fixed `crossOrgActions` set (platform-wide roles like
`PLATFORM_OWNER`/`MARKETPLACE_OPERATOR`). This models the actual resources correctly
— an `Organization`, a `Person`, a `User` all really do have exactly one owning side.

P13 (RFQ) and P14 (Deal Room) are different in kind: an RFQ has a merchant owner (the
Opportunity's `ownerOrgId`) AND one or more invited provider organizations who are not
the owner but who legitimately need real, first-class access — read the disclosure
packet, submit/withdraw a quote, decline, and (once a DealRoom opens) post/resolve
conditions and record decisions. Neither of the two grant paths fits: the provider
isn't the owner, and granting `rfq.read`/`deal.post_condition`/etc. as blanket
`crossOrgActions` to `ACQUIRER_PROVIDER_USER` would let ANY acquirer read or act on EVERY
RFQ platform-wide, not just the ones they were actually invited to — a real
confidentiality break (the spec: "One provider receives one versioned packet" implies
the others must NOT see it).

Alongside solving that core problem, six smaller, coupled design questions came up
along the way and are recorded together here since they were decided in the same
sitting and reference each other. (This ADR was written after the fact, after the code
comments already promised its contents by name — `schema.prisma`'s
own section header in particular pre-lists five of these seven points; this document
fulfills that promise rather than introducing anything the code doesn't already assume.)

## Decision

### 1. `AuthContext.isParticipant` + `RoleGrant.participantActions`

`can()` gains a third grant path, checked after `crossOrgActions` and before the
owner-match fallback:

```
if (context.isParticipant && grant.participantActions.has(action)) return allow(...);
```

- `context.isParticipant` is a boolean the SERVICE layer computes per-request from a
  real, freshly-queried database row (`RFQRecipient.providerOrgId === actor.organizationId`
  or `DealRoomParticipant` existing for that org) — never trusted from client input,
  never cached across requests.
- `RoleGrant.participantActions: ReadonlySet<Action>` is a new required field on every
  persona's matrix entry (deny-by-default preserved: an empty set, which is what 9 of
  10 personas have, means "this persona never gets participant-scoped access, only the
  ordinary owner/cross-org paths").
- Only `ACQUIRER_PROVIDER_USER` has a non-empty set (10 actions: `rfq.read`, `rfq.list`,
  `rfq.decline`, `rfq.submit_quote`, `rfq.withdraw_quote`, `deal.read`, `deal.list`,
  `deal.post_condition`, `deal.resolve_condition`, `deal.record_decision`). Merchants
  never need this path — the merchant org IS the RFQ/DealRoom's `ownerOrgId`, so they
  already have full access through the existing owner-match check.

### 2. `Opportunity`/`CapacityProfile` kept intentionally thin

The spec describes a much richer object graph than this build's earlier work:
`Movability.newIncrementalExpected`, `VolumeSlice`'s jurisdiction × MCC breakdown,
`RiskSnapshot`, `SettlementRequirement`, `TechnicalRequirement`, and a "mandatory
reconciliation" engine proving `SUM(VolumeSlice) = offeredCardGpv` — all explicitly P7
(Opportunity)/P8 (Capacity) scope, not P13/P14. This build ships exactly enough of each —
a real table with full base-audit columns, a thin create/read/list API, nothing more —
so P13 RFQ has a real `Opportunity` to attach a disclosure packet to and a real
`CapacityProfile` to invite a provider by. Building P7/P8's full richness now, before
either gate is actually being worked, would front-load complexity with no consumer.

### 3. Money stays split — BigInt+string vs Int+number, not unified

The build already established: integer minor units, never floats. This decision extends that with a
second axis rather than picking one representation for everything:

- **BigInt (Prisma) + numeric string (wire, `MinorUnitsStringSchema =
  z.string().regex(/^\d+$/)`)** for volume-scale columns — `Opportunity`'s GPV/volume
  totals, `CapacityProfile.monthlyCapacityMinor`. The binding constraint is Postgres's
  own `INT4` range (±2,147,483,647), not primarily JavaScript's `Number
  .MAX_SAFE_INTEGER` ceiling (2^53, which is far higher) — `INT4` overflows at roughly
  **$21.4M in minor units (cents)**, a ceiling a realistic monthly GPV or capacity
  figure clears almost immediately. `BigInt` maps to Postgres `INT8`/`NUMERIC`, clear of
  that ceiling by many orders of magnitude.
- **Plain `Int` (Prisma) + `number` (wire)** for bounded, single-transaction or
  JSON-embedded amounts — `Quote.terms`'s rate/reserve/capacity-offer figures,
  `DealCondition` fields. These live inside a `Json` column already (no `INT4` column
  constraint applies to begin with), and a single quote's bounded terms stay safely
  under any realistic ceiling regardless.

### 4. `QuoteDecision` folds into `Quote.status` + `DealDecision`, not a third table

Quote selection is represented two ways at once, each doing a different job:
`Quote.status` transitions straight to `SELECTED` (so "is this quote selected" is a
plain column check, no join needed), AND a `DealDecision` row with
`decisionType: "QUOTE_SELECTED"` is written into the same table the Deal Room's own
APPROVAL/DECLINE/EXCEPTION decisions use (so the decision **timeline** is one table, not
a UNION of two read at every request). The `DealDecision` row is system-recorded only —
never a direct client request (`RecordDecisionRequestSchema`'s `decisionType` enum is
restricted to `APPROVAL`/`DECLINE`/`EXCEPTION`; `QUOTE_SELECTED` is deliberately excluded
so a client can never forge one).

### 5. No separate `deal.open` authorization action

Opening a DealRoom is an automatic, atomic side effect of `rfq.select_quote` succeeding,
not an independently authorized action. One transaction: `Quote`→`SELECTED`,
`RFQ`→`SELECTED`, `Opportunity`→`SELECTED`, `DealRoom` created `OPEN`, both
`DealRoomParticipant` rows added (`MERCHANT`+`PROVIDER`), the `QUOTE_SELECTED`
`DealDecision` recorded — all inside `rfqs/service.ts`'s `selectQuote`'s single
`withTransaction` block. A DealRoom cannot exist without a selected quote in this model,
so a standalone `deal.open` check would only ever be reachable through the same
`rfq.select_quote` gate anyway — an extra action with no distinguishable failure mode
from the one it would always follow.

### 6. `DomainEvent` keeps `AuditEvent`'s lean shape

`packages/events`'s `DomainEventEnvelope<TType, TPayload>` is `{eventType, aggregateType,
aggregateId, payload, actorUserId, actorOrgId, actorRole, correlationId, occurredAt}` —
NOT the full base-audit-column set every other earlier model carries, and not a richer
event-sourcing envelope with its own stream-versioning, snapshotting, or replay
machinery. The categorical reason: `DomainEvent` and `AuditEvent` are both
**append-only infrastructure logs**, not governed business entities — every OTHER earlier
model (`Opportunity`, `RFQ`, `Quote`, `DealRoom`, etc.) IS a governed business entity a
human can edit/retire/own, and DOES carry the full base-audit set (`updated_at/by`,
`version`, `effective_from/to`, ...); a log row nothing ever updates has no use for any
of those columns. Separately, and consistently with that categorical distinction: P14's
actual exit condition is a human-readable, chronologically-merged **timeline** (scope
p.22), which this lean shape satisfies directly (`GET /deals/:id/timeline` merges
`DomainEvent` rows with RFQ-history rows and sorts by `occurredAt`) — building
event-sourcing infrastructure for a replay/rebuild need that doesn't exist would
compound the mistake, not just repeat it.

### 7. `rfq.create` is operator-only

`MERCHANT_PSP_USER`'s `allowedActions` does not include `rfq.create` — only
`PLATFORM_OWNER`/`MARKETPLACE_OPERATOR` hold it, via `crossOrgActions`, matching the spec's
"operator-assisted" framing for this pass rather than a merchant self-serve flow.
A merchant CAN reach `rfq.select_quote`, `deal.post_condition`, `deal.resolve_condition`,
`deal.record_decision` directly (all in `MERCHANT_PSP_USER.allowedActions`) — only RFQ
*creation* is gated to the operator persona.

## Consequences

- `packages/authz/src/can.ts`'s participant-grant branch is load-bearing production
  logic. Both call sites that compute `isParticipant`
  (`apps/api/src/modules/rfqs/service.ts`, `.../deals/service.ts`) derive it from a
  fresh DB read every time — there is no cached or client-suppliable path to set it.
  Proven both directions: `packages/authz/src/can.test.ts` + `matrix.test.ts` (unit),
  and `apps/api/tests/integration/rfqs.test.ts` + `deals.test.ts`'s dedicated "outsider
  provider" tenant-isolation blocks (integration, against the real DB) — an invited
  provider can act, an uninvited one gets a clean 403/404, not a 500 or a silent bypass.
- Keeping `Opportunity`/`CapacityProfile` thin means P7/P8 (Opportunity, Capacity gates)
  stay IN PROGRESS, not DONE, even though their tables now exist — the gate table
  reflects this explicitly rather than counting table-existence as gate completion.
  Whoever builds P7/P8 next adds the richer fields to these SAME tables/migrations
  (additive `ALTER TABLE`, not a rewrite) rather than starting over.
- The money split means every new earlier DTO in `packages/contracts` individually
  documents which representation it uses (see each file's header comment) rather than
  one rule applying uniformly — an accepted, explicit repetition cost in exchange for
  each field matching its actual realistic magnitude against the real constraint
  (Postgres `INT4`), not a rule-of-thumb JS number ceiling that would have under-applied
  `BigInt` far less often than the data actually needs it.
- Folding `QuoteDecision` into `Quote.status` + `DealDecision` means a future need to
  treat quote-selection differently from a human decision (different retention policy,
  a different downstream consumer) requires branching on `decisionType` rather than a
  separate table — a conscious tradeoff, flagged here rather than discovered as a
  surprise later.
- No `deal.open` action means `packages/authz/src/actions.ts`'s `ACTIONS` array has one
  fewer entry than a fully-orthogonal action-per-lifecycle-transition design would have
  — intentional, not an oversight, per point 5 above.
- `DomainEvent`'s lean shape means if a later phase (P17 Failure/replay, or a real
  event-driven `apps/worker`) needs actual event-sourcing guarantees (ordering
  guarantees beyond `occurredAt`, replay-from-snapshot, schema-versioned payloads), that
  is a genuine future migration, not a drop-in — flagged rather than silently assumed
  free.
- Gates affected: **P13 — RFQ** and **P14 — Deal Room** (this ADR documents the
  authorization mechanism both gates' DONE status depends on — see
  the test-evidence records for p13-rfq and p14-deal-room). **P7 — Opportunity** and
  **P8 — Capacity** move from NOT STARTED to IN PROGRESS (point 2 above — real tables
  and thin CRUD exist, full gate-specific logic doesn't yet). **P16 — Audit** benefits
  incidentally (every RFQ/Deal Room mutation this ADR covers also writes both an
  `AuditEvent` and a `DomainEvent`, extending P16's provable action set).
