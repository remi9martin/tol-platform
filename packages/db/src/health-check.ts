// packages/db/src/health-check.ts
//
// earlier: apps/worker's startup/readiness gate needs to prove "the
// database is actually reachable and can serve a query" — the spec
// scenario #5, "Database restore: audit/outbox consistency check runs
// before enabling mutations." This lives HERE, not in apps/worker,
// because this package is "the only package that talks to Postgres
// directly" (ARCHITECTURE.md §5) — apps/worker calls this function
// through @tol/db's public surface, exactly like every repository call.

import type { DbClient } from "./repositories/types.js";

export interface DatabaseHealthResult {
  ok: boolean;
  error?: string;
}

/**
 * A trivial, real query — proves the DB is not just accepting TCP
 * connections but can actually serve a query, without depending on any
 * specific table's existence (so this stays valid across every future
 * migration). Not a full audit/outbox consistency audit (that's an ops
 * runbook, the spec's own "Create docs/runbooks/RUN-003-db-restore.md"
 * item — out of a single day's code scope) — this is the CODE-LEVEL gate
 * a worker's own startup can reasonably own.
 */
export async function checkDatabaseReachable(db: DbClient): Promise<DatabaseHealthResult> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
