# Deploy Runbook

**Status: SKELETON — completed at pilot/release.** This repo has never been deployed anywhere. The structure below is real (it matches the scope's own stated production target and this repo's actual local topology); the step-by-step commands are not, because there is nothing yet to run them against. Do not treat any command-shaped text below as tested — none of it is.

## Scope

Covers getting a build of `apps/web`, `apps/api`, and (once it exists) `apps/worker` from source into a running environment. Does not cover first-time environment provisioning (that's `infra/terraform/` — also a placeholder today) or incident recovery (see `rollback.md` and the future `RUN-00N` runbooks in `docs/runbooks/README.md`).

## Environments (target topology, the spec — none provisioned yet)

| Environment | Purpose | Data |
|---|---|---|
| local | Full-stack developer loop | Synthetic only — this is the only environment that exists today |
| preview | Per-PR UI/API validation | Synthetic fixtures |
| staging | Integrated controlled testing | Sanitized/synthetic; selected test partners |
| production | Invite-only live network | Real data under production controls |

## What exists today vs. what a real deploy needs

| Piece | Local (real today) | Deploy target (not built) |
|---|---|---|
| Postgres | `docker-compose.yml` service, port 5432 | RDS PostgreSQL Multi-AZ (the spec reference target) |
| Redis | `docker-compose.yml` service, port 6379 | ElastiCache Redis |
| Object storage | MinIO (`docker-compose.yml`, ports 9000/9001) | S3 with versioning/object lock where appropriate |
| `apps/api` | `pnpm --filter @tol/api run dev` (tsx watch, not a container) | Containerized — needs `infra/docker/api.Dockerfile` (does not exist; `docker-compose.yml`'s `api` service is commented out pending it) |
| `apps/worker` | Does not exist | Containerized — needs `infra/docker/worker.Dockerfile` (does not exist) + the worker's own implementation (earlier scope) |
| Secrets | `.env` (local file, gitignored) | KMS + Secrets Manager (the spec); separate KMS keys per environment |
| Network/ingress | `localhost` + explicit ports (18300/18400, chosen to sit outside Windows' dynamic/excluded TCP ranges — see `.env.example`) | CloudFront/WAF → web/API service (the spec reference target) |

## Planned deploy sequence (structure only — not yet exercised)

1. **Build.** Produce a versioned artifact/image per app (`apps/web`, `apps/api`, `apps/worker`) from a specific commit. Blocked today on `infra/docker/*.Dockerfile` not existing.
2. **Migrate.** Apply pending Prisma migrations (`pnpm --filter @tol/db run prisma:migrate:deploy`, the deploy-safe counterpart to the dev-loop's `prisma:migrate:dev`) against the target database, **before** the new application version starts receiving traffic. Migrations in this repo are forward-only and reviewed (the spec) — see `rollback.md` for what that implies when a deploy needs to be undone.
3. **Health-gate.** New instances must pass `/healthz` (liveness) and `/readyz` (readiness — currently checks Postgres reachability; `apps/api/src/modules/health/routes.ts`) before receiving production traffic. Both routes are real today; nothing currently orchestrates a gated rollout around them.
4. **Cutover.** the spec's target: "Deploys are health-gated; rollback to prior image is one command/workflow." No orchestration layer (load balancer, container platform) exists yet to make this concrete.
5. **Verify.** Post-deploy smoke check against the real gate evidence this repo already tracks the shape of — re-run the relevant the test evidence walkthroughs against the newly-deployed environment, not just against local dev.

## Secrets at deploy time

Never bundle secrets into `apps/web`'s browser bundle — only `NEXT_PUBLIC_*`-prefixed variables are browser-visible (see `docs/product/OWNERSHIP.md` §4). Production and staging must use **separate accounts/projects and separate KMS keys** (the spec) — the current single-environment `.env` pattern (four Lockbox KEKs + one HMAC key, `LOCKBOX_KEK_*`/`LOCKBOX_RECEIPT_HMAC_KEY`) is an explicit, documented MVP stand-in for real per-environment KMS custody (`docs/adr/0009-lockbox-crypto.md`), not a pattern to lift directly into a shared multi-environment secret store.

## Owner / sign-off (to be assigned)

No deploy has ever happened, so no deploy owner has been named. Assign this before the first real deploy, not after.
