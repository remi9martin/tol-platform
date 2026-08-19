# packages/db — Prisma Schema, Migrations, Repositories

Prisma schema, migrations, repositories. The only package that talks to PostgreSQL directly; apps/api and apps/worker consume repositories, never the Prisma client directly.

Serves gate(s): P3 Data, P4 Auth (session/membership tables), P16 Audit (AuditEvent table).

**Status: implemented.** Organization, Person, User, OrganizationMembership, Session, AuditEvent, IdempotencyKey. See `prisma/schema.prisma` for full field-level citations back to the spec. Deliberately NOT built yet (earlier+ per ADR-0002): Relationship/RelationshipClaim (p.13), Passport/Fact/Evidence (p.14), Opportunity/Capacity (p.15-16), Lockbox (p.17), RFQ/DealRoom (p.21-22), Economics (p.23).

## Local setup

```bash
# from repo root
docker compose up -d postgres
pnpm install
pnpm --filter @tol/db run prisma:migrate:dev   # applies migrations, generates client
pnpm --filter @tol/db run prisma:seed          # seeds earlier fixtures
```

Seeded users (all share the dev-only password `TolSeed!2026-Dev` — see `prisma/seed.ts` and the test evidence):

| Email | Role | Organization |
|---|---|---|
| owner@tolplatform.dev | PLATFORM_OWNER | TOL Platform Operations |
| operator@tolplatform.dev | MARKETPLACE_OPERATOR | TOL Platform Operations |
| auditor@tolplatform.dev | AUDITOR_READONLY | TOL Platform Operations |
| alice@meridian-acquiring.example | ACQUIRER_PROVIDER_USER | Meridian Acquiring Group |
| bob@northline-retail.example | MERCHANT_PSP_USER | Northline Retail Holdings |

## Design notes (read before extending this schema)

- **Version pin:** `prisma`/`@prisma/client` are pinned to `6.19.3`, not the newly-released Prisma 7 line (mandatory driver adapters, renamed generator, `prisma.config.ts`, explicit env loading — a materially different, less-established workflow). Revisit deliberately later, not as a side effect of a routine dependency bump.
- **IDs:** UUIDv7, generated application-side in `src/ids.ts` (stock `postgres:16-alpine` has no `pg_uuidv7` extension installed, so there's no DB-side default that produces them). See the spec.
- **Soft-reference audit columns:** `created_by_user_id` / `created_by_org_id` / `updated_by_user_id` are plain UUID columns, not enforced Prisma relations. Enforcing FKs there would block legitimate retention/deletion of the *actor* while keeping the historical record — the opposite of what p.12's own soft-deletion policy wants.
- **Dual-duty status columns:** where an entity's own domain status (e.g. `OrganizationMembership.status`, `User.status`) already represents a lifecycle state, that field also serves as the base-audit "status" column (p.12) instead of carrying a second, redundant generic status field. `Organization`/`Person` keep `verificationStatus` (domain) and `status` (generic `RecordStatus`, base-audit) separate because those really are two different axes for those entities.
- **Inferred enum values:** `OrganizationType` and `VerificationStatus`'s allowed values are not given verbatim anywhere in the build spec (p.13 names the fields, not their value sets) — see the inline comments in `schema.prisma` for the reasoning. Flagged as an inference, not a spec quote.
- **Password hashing** (`src/password.ts`) lives here, next to the `User` model, rather than in `packages/crypto` (scoped specifically to Lockbox envelope encryption per D1 — a different, cryptographically unrelated concern) or duplicated in `apps/api`. Both `prisma/seed.ts` and `apps/api`'s login service import it from here, so seeded fixtures and real login always hash/verify identically.

## Import boundary

Consumers import only from this package's public `src/index.ts` via the `@tol/db` workspace alias. Deep imports into `@tol/db/src/repositories/*` (or anywhere else internal) are forbidden (the spec).
