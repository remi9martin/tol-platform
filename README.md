# TOL — Institutional Marketplace Platform

A closed-but-visible marketplace for institutional merchant-acquiring capacity: market-level visibility with deal-level privacy. Organizations publish anonymized capacity and appetite, qualified opportunities are matched to eligible capacity, and disclosure happens only under explicit permission — inside a controlled deal room with an auditable record.

> **Status: early MVP.** The core domain, backend, cryptography, and data model are implemented and tested (1,000+ automated tests). Pilot workflows, full security hardening, and frontend polish are still in progress. "TOL" is a working name pending trademark/domain clearance.

## Stack

- **Monorepo:** pnpm workspaces · TypeScript (strict)
- **Web:** Next.js (React) — `apps/web`
- **API:** Fastify — `apps/api`
- **Worker:** BullMQ + Redis — `apps/worker`
- **Data:** Prisma + PostgreSQL — `packages/db`
- **Domain & libraries:** `packages/{domain, crypto, authz, attribution, matching, evidence, contracts, events, config, queue}`

## What's implemented

- **Visible marketplace** with server-enforced field redaction — market data is anonymized at the API boundary, not hidden in the client.
- **Role/attribute-based access control** across a ten-persona model, with per-field disclosure policies.
- **Institutional evidence graph ("Passport")** — reusable organization facts, verification, and readiness/freshness scoring.
- **Sealed submissions ("Lockbox")** — AES-256-GCM envelope encryption with Shamir 2-of-3 threshold key custody and signed receipts.
- **Attribution** — deterministic, explainable contributor scoring with a dispute workflow.
- **Matching** — deterministic eligibility and explainable ranking (no ML), version-stamped.
- **RFQ + Deal Room** — a versioned request/quote lifecycle with conditions, decisions, and an immutable timeline.
- **Economics** — commission schedules, an append-only accrual ledger, and largest-remainder (Hamilton) apportionment over integer minor units (no floating-point money).
- **Async worker** — scheduled and event-triggered jobs (readiness, freshness, expiry, accrual) with failure-recovery coverage.

Design invariants worth noting: all money is integer minor units; concurrent state transitions are serialized with PostgreSQL advisory locks; sensitive plaintext is never persisted.

## Getting started

**Prerequisites:** Node 20+, pnpm, and Docker (for PostgreSQL + Redis).

```bash
# install
pnpm install

# start PostgreSQL + Redis (a compose file is provided under infra/)
docker compose -f infra/docker/docker-compose.yml up -d

# configure environment
cp .env.example .env    # then fill in the values

# database: apply migrations, optionally seed demo data
pnpm --filter @tol/db exec prisma migrate deploy
pnpm --filter @tol/db run prisma:seed

# run (separate terminals)
pnpm --filter @tol/api run dev       # API,    port 18400
pnpm --filter @tol/web run dev       # web,    port 18300
pnpm --filter @tol/worker run dev    # worker
```

## Testing

```bash
pnpm -r typecheck
pnpm -r build
pnpm -r test     # 1,000+ tests: unit + integration against real Postgres/Redis
```

## Documentation

- `docs/ARCHITECTURE.md` — system architecture
- `docs/adr/` — architecture decision records
- `docs/security/threat-model.md` — threat model
- `docs/runbooks/` — deploy, monitoring, rollback

## License

Proprietary — all rights reserved. Shared for review only.
