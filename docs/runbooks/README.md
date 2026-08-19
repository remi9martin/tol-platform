# docs/runbooks — Operational Runbooks

**Status: SKELETON — real operational content lands at pilot/release (Definition of Done, the spec: "Runbooks, monitoring, rollback, data handling and accountable operational ownership exist").**

This folder holds the operational documentation a real, running, on-call-supported deployment needs. As of earlier (2026-08-18), **nothing in this repo has ever been deployed** — `docker-compose.yml`'s `api`/`worker` services are commented out pending real Dockerfiles, `infra/terraform/` is a placeholder, and `.github/workflows/` has no real CI. Everything in this folder is therefore a **skeleton**: real structure, real headings, real references to the infra that exists today — but the runbooks themselves cannot be completed until there is a real deployed system to run them against. Filling in a skeleton with invented steps would be worse than leaving it honestly incomplete (this repo's own standing discipline — see the gate table: "No unresolved blocker is hidden behind a green dashboard").

## What's in this pass

| File | Covers |
|---|---|
| `deploy.md` | How a build gets from source to a running environment — image build, migration, health-gated cutover. |
| `rollback.md` | How to undo a bad deploy — application rollback and the database-migration complication that comes with "migrations are forward-only" (the spec). |
| `monitoring.md` | What signals exist today (structured logs, `/healthz`/`/readyz`) vs. what the scope requires at production maturity (metrics, tracing, alerting — the spec) and doesn't exist yet. |

## What's explicitly NOT in this pass (named so it isn't mistaken for an oversight)

The scope (p.28) separately names **six incident-specific runbooks**, tied to gate **P17 — Failure** (the gate table), not to this documentation pass:

```
docs/runbooks/RUN-001-provider-outage.md
docs/runbooks/RUN-002-lockbox-release.md
docs/runbooks/RUN-003-db-restore.md
docs/runbooks/RUN-004-security-incident.md
docs/runbooks/RUN-005-stuck-outbox.md
docs/runbooks/RUN-006-data-request.md
```

Each of those must name detection, authority, containment, recovery, validation, and a postmortem owner (the spec's own requirement) — and each depends on infrastructure that doesn't exist yet: `RUN-005-stuck-outbox.md` needs `apps/worker`'s outbox-publish job (earlier scope, the build log); `RUN-001-provider-outage.md` needs a real provider connector (`packages/connectors` is still a placeholder). Writing them now, before that infrastructure is real, would produce exactly the kind of unverifiable, aspirational documentation this repo's own build discipline exists to avoid. They belong to whichever day builds P17, working against the real thing.

## Prerequisite infrastructure this folder assumes once it's real

- `docker-compose.yml` — local dev topology today (Postgres 16, Redis 7, MinIO, Mailpit); the reference point for what a real deploy target eventually containerizes.
- `packages/db/prisma/migrations/` — the real, applied migration history (6 migrations through earlier) that any deploy/rollback procedure must respect (forward-only, per the spec).
- `apps/api`'s `/healthz` and `/readyz` routes (`apps/api/src/modules/health/routes.ts`) — real today, the natural hook for any future deploy-gating or monitoring probe.
- `apps/worker` — does not exist yet (earlier scope). Several of the eventual RUN-00N runbooks and the queue-depth signal in `monitoring.md` depend on it.

## Cross-references

- System architecture: `docs/ARCHITECTURE.md`.
- Environment topology (local/preview/staging/production) and the production infra target: the spec, summarized in `docs/product/OWNERSHIP.md` §4.
- Gate this folder ultimately serves: P17 (Failure), P19 (Pilot), and the Definition of Done — see the gate table.
