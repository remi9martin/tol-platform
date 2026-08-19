# Monitoring Runbook

**Status: SKELETON — completed at pilot/release.** `packages/observability` (the package the monorepo layout reserves for logging/tracing/metrics as shared infrastructure) is still an earlier placeholder — untouched. What's below separates the narrow slice that's real today (it lives directly in `apps/api`, not yet in the shared package) from the full signal set the scope requires at production maturity, so the gap is explicit rather than assumed away.

## Scope

What to watch once something is actually running, and what today's dev-loop already gives you for free. Does not cover deploy-time health gating mechanics (see `deploy.md`) or specific incident response (see the future `RUN-00N` runbooks, `docs/runbooks/README.md`).

## Signal minimum bar (the spec) vs. reality today

| Signal | Scope's minimum bar | Real today | Gap |
|---|---|---|---|
| **Logs** | Structured JSON, request/correlation IDs, actor/org IDs, safe error codes, redaction | **Partially real.** `apps/api/src/plugins/observability.ts` configures Fastify's built-in pino logger: structured JSON, a request serializer, and a redaction list (`req.headers.cookie`, `req.headers.authorization`, `req.headers['x-csrf-token']`, `res.headers['set-cookie']`, `body.password`, `body.passwordHash`) — unit-tested (`observability.test.ts`), matching the spec's "redaction unit tests are mandatory." `apps/api/src/shared/request-context.ts` attaches `requestId`/`actorId`/`organizationId`/`correlationId` per the spec. | No log aggregation/shipping destination exists (no CloudWatch/OpenTelemetry sink, no equivalent) — logs today only go to the local dev process's stdout. |
| **Metrics** | Request latency/errors, queue depth, connector health, match recompute, stale evidence/capacity | **Not built.** | No metrics collection at all. Queue depth is meaningless before `apps/worker` exists. |
| **Tracing** | API → domain service → DB → queue → connector correlation | **Not built**, beyond the `correlationId` field threaded through logs/events (a manual precursor, not real distributed tracing). | No tracing backend, no span propagation. |
| **Audit** | Immutable actor/action/resource/before-after references for governed operations | **Real, but partial.** `AuditEvent` (earlier) + `DomainEvent` (earlier+) tables are genuinely populated for every mutation across auth/org/membership, RFQ/Deal Room, Lockbox, Attribution, and Passport actions (the gate table P16). | Restricted-field-*view* auditing and bulk-export auditing don't exist yet — only mutations are audited so far. |
| **Health** | Liveness + readiness; dependency-specific status | **Real.** `GET /healthz` (liveness) and `GET /readyz` (readiness — checks Postgres via `SELECT 1`, returns `503` with `dependencies: { postgres: "error" }` on failure) — `apps/api/src/modules/health/routes.ts`. | Readiness only checks Postgres — Redis/MinIO/Mailpit have no dependency-specific check yet (consistent with them being unused by any real code path so far). Nothing currently polls these routes on a schedule or alerts on failure. |
| **Alerts** | Auth anomalies, connector failure, queue backlog, failed outbox, backup failure, key-release error | **Not built.** | No alerting channel configured at all. `packages/crypto`'s Lockbox release path is exactly the kind of "key-release error" this bar calls out — it's real and tested at the unit/integration level, but nothing pages anyone if it fails in a live environment, because there is no live environment. |

## What to build this into once there's something to monitor

1. **Ship the existing structured logs somewhere.** The hard part (structured format + redaction) is already done in `apps/api/src/plugins/observability.ts` — the missing piece is a destination, not a format.
2. **Promote `packages/observability` from placeholder to real**, consuming the redaction/serialization conventions already established in `apps/api` rather than inventing a second convention.
3. **Wire `/healthz`/`/readyz` into whatever orchestrates deploys** (see `deploy.md`) — they already return the right shape, nothing currently calls them on a schedule.
4. **Queue-depth and connector-health metrics wait on `apps/worker` and `packages/connectors`** respectively — both are still placeholders (earlier and "deliberately deferred" respectively, per the build log).
5. **Alert routing** needs a real deployed environment and an on-call rotation to route to — neither exists. Don't wire alerts to nobody.

## Dashboards

None exist. When they do, the P5/P6/P7/P8/P9/P10/P13/P14 gate evidence already captured in the test evidence is the natural source of "what a healthy system looks like" to build the first dashboard panels against, rather than guessing at metrics no one has looked at yet.

## Owner / sign-off (to be assigned)

No monitoring exists in a live environment yet, so no on-call/monitoring owner has been named. Assign this before the first real deploy, alongside the deploy and rollback owners.
