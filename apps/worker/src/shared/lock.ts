// apps/worker/src/shared/lock.ts
//
// Same pg_advisory_xact_lock(hashtext(id)) pattern apps/api/src/modules/
// claims/service.ts's fileDispute()/decide() already prove works (see
// that file's own extensive comment on why a plain "re-read fresh inside
// the transaction" does NOT close the race by itself under Postgres's
// default READ COMMITTED isolation — re-reading only helps once one side
// has actually COMMITTED; two truly concurrent transactions can each
// independently read the SAME pre-mutation state and both proceed).
// Factored into one shared helper here (apps/api's own two call sites
// don't share one either — each inlines its own `tx.$executeRaw` call —
// but this file's four this stage jobs all need the identical one-liner, so
// a shared helper avoids four independent copies of a security-relevant
// pattern silently drifting apart over time).
//
// Serializes on the AGGREGATE's own id (hashed to a bigint key) —
// automatically released at transaction end (commit or rollback), no
// separate unlock call, no cleanup path to forget.

import type { Prisma } from "@tol/db";

export async function lockAggregate(tx: Prisma.TransactionClient, aggregateId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${aggregateId}))`;
}
