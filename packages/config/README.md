# packages/config — Typed Environment Loader

Typed environment/config loader shared by apps/api (and, later, apps/worker and infra scripts). Single place that reads `process.env` and fails loudly on missing/malformed config, instead of every app doing it ad hoc (the spec).

**Status: implemented**, scoped to exactly what `apps/api` needs this pass (`NODE_ENV`, `PORT`, `WEB_ORIGIN`, `DATABASE_URL`, `SESSION_SECRET`, `LOG_LEVEL`). `getConfig()` throws at first call (i.e. at process boot, in `apps/api/src/server.ts`) rather than deep inside a request handler — same "fail loud, at startup" discipline already used in `packages/db` (Prisma's own `DATABASE_URL` check) and `packages/authz` (the authority-matrix exhaustiveness check).

Added during this stage (apps/api) as a small, directly-scope-mandated supporting package — not a separately-tasked earlier block, but apps/api reading `process.env.SESSION_SECRET` ad hoc inline would violate p.11's explicit rule, and the alternative (skip validation entirely) would silently ship a service that starts up fine with a missing or too-short session secret.

## Import boundary

Consumers import only from `src/index.ts` via the `@tol/config` workspace alias.
