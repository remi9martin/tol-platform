// apps/worker/src/shared/job-idempotency.ts
//
// The job-shaped analog of apps/api/src/shared/idempotency.ts. SPEC_-
// TRACEABILITY.md's P17 row names `apps/api (shared/idempotency.ts)`
// explicitly as one of P17's owning paths — this file is the second half
// of that same idea, reusing the SAME underlying table
// (`idempotency_keys`, `@tol/db`'s `idempotencyRepository`) with a
// job-shaped key instead of an HTTP header.
//
// DELIBERATE DIFFERENCE from apps/api's withIdempotency, documented here
// rather than silently diverging (ADR-0014 part 2 has the full
// reasoning): apps/api's version 409-conflicts a second caller when a key
// is "reserved but not yet completed" — correct for an HTTP client, which
// should back off and retry LATER. A BullMQ job retry is not a second
// caller in that sense — it's the SAME logical unit of work getting
// another attempt after a crash/timeout, and it must be able to get
// through a stale reservation left by a prior attempt that died before
// completing. So this version does NOT reserve-then-run; it runs, then
// records the result (upsert-shaped, tolerating a concurrent duplicate
// write via the same P2002 catch apps/api's own version uses) — the
// actual duplicate-prevention guarantee comes from EVERY this stage job
// handler being independently idempotent at the business/repository
// level (each job's own header comment states its own check-before-write
// invariant). This table is a fast-path cache + audit trail on top of
// that, not the only line of defense — belt-and-suspenders, not a single
// point of failure, for a property (P17) whose whole point is "don't
// trust any one mechanism to survive every failure mode."

import { createHash } from "node:crypto";
import { Prisma, idempotencyRepository, type DbClient } from "@tol/db";

export interface JobIdempotencyInfo {
  /** Namespaces keys per job type — e.g. "worker.passport-readiness" — same purpose as apps/api's endpoint-scoped `scope` string. */
  scope: string;
  /** A DETERMINISTIC key derived from the job's logical identity (e.g. `${passportId}:${asOfIsoDate}`) — deliberately NOT BullMQ's own `job.id` (which is unique per enqueue call; two different job.ids can and do carry the SAME logical unit of work under DUPLICATE/REPLAY, and collapsing them to one effect is the entire point of this file). */
  key: string;
  /** Hashed the same way apps/api's requestHash is — lets a caller detect "same key, different logical input" (a real bug) vs. "same key, same input, safe to replay the cached result." */
  requestPayload: unknown;
}

export class JobIdempotencyConflictError extends Error {
  constructor(scope: string, key: string) {
    super(`idempotency key collision: scope="${scope}" key="${key}" was already recorded with a DIFFERENT request payload — this indicates two logically different jobs were assigned the same idempotency key, a caller bug, not a safe-to-replay duplicate`);
    this.name = "JobIdempotencyConflictError";
  }
}

const JOB_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * Runs `handler` and returns its result. If `scope`+`key` already has a
 * COMPLETED record, `handler` is never called — the prior result is
 * returned directly (this is what makes the DUPLICATE and REPLAY
 * tests pass: re-submitting the identical logical job a second — or
 * hundredth — time is a cheap read, not a recompute).
 *
 * `handler`'s return value must be JSON-serializable (it's persisted into
 * `idempotency_keys.response_body`, same constraint apps/api's version
 * has on its own handler).
 */
export async function withJobIdempotency<T>(db: DbClient, info: JobIdempotencyInfo, handler: () => Promise<T>): Promise<T> {
  const requestHash = hashPayload(info.requestPayload);

  const existing = await idempotencyRepository.find(db, info.scope, info.key);
  if (existing && existing.responseStatus !== null) {
    if (existing.requestHash !== requestHash) {
      throw new JobIdempotencyConflictError(info.scope, info.key);
    }
    return existing.responseBody as T;
  }

  const result = await handler();

  try {
    const reservation = await idempotencyRepository.reserve(db, {
      key: info.key,
      scope: info.scope,
      requestHash,
      organizationId: null,
      userId: null,
      expiresAt: new Date(Date.now() + JOB_IDEMPOTENCY_TTL_MS),
    });
    await idempotencyRepository.complete(db, reservation.id, { responseStatus: 200, responseBody: result as object });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      throw err;
    }
    // A concurrent attempt recorded this key first — fine. Our own
    // handler() call was independently idempotent (every this stage job
    // guarantees this at the business level), so having run concurrently
    // with another attempt is safe; we just don't get to be the one whose
    // result gets cached. Not an error worth surfacing to the caller.
  }

  return result;
}
