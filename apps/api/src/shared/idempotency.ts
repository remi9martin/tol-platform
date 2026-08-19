// apps/api/src/shared/idempotency.ts
//
// the spec: "All mutation endpoints support Idempotency-Key when
// duplicate network retries could create a second record or transition."
// This is the ONE call site services use for that — see
// modules/memberships/service.ts's createMembership for the concrete
// earlier usage (invite creation, the mutation most likely to get
// double-fired by a retried network request).
//
// This is also the packages/db review's carried-forward
// requirement (review, "packages/db block", idempotency.repository.ts
// BLOCKER): idempotencyRepository.reserve()'s docstring says the caller
// must catch the race — this file is that catch.

import { createHash } from "node:crypto";
import { Prisma, idempotencyRepository, type DbClient } from "@tol/db";
import { ProblemError } from "./errors.js";

export interface IdempotencyRequestInfo {
  key: string | undefined;
  scope: string;
  method: string;
  path: string;
  body: unknown;
  organizationId: string | null;
  userId: string | null;
}

function hashRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest("hex");
}

const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs `handler` under idempotency protection when the caller supplied an
 * Idempotency-Key header; runs it directly (no protection) when they
 * didn't — support is opt-in per p.9's own wording ("when duplicate
 * network retries COULD create a second record"), not mandatory on every
 * request.
 *
 * IMPORTANT — `handler` must resolve to the exact, already-serializable
 * response body (post-DTO-mapping), never a raw repository/Prisma
 * entity. The result is stored in a Json column and read back as plain
 * JSON on replay (Date objects become strings, etc.) — a caller that
 * expects the replayed value to still be the original rich object will
 * get a shape mismatch instead of the identical response a real replay
 * needs. See modules/memberships/routes.ts's createMembership route for
 * the corrected pattern (map to DTO INSIDE the handler passed here).
 *
 * - No prior key: reserves it, runs the handler, records the response,
 *   returns it.
 * - Same key + same request body, already completed: replays the cached
 *   response WITHOUT re-running the handler (the actual idempotency
 *   guarantee).
 * - Same key + DIFFERENT request body: 409 — a real client bug (reusing a
 *   key for a different logical request), not silently replayed.
 * - Same key, reservation race (a genuinely concurrent duplicate request
 * - No prior key: reserves it, runs the handler, records the response,
 *   returns it.
 * - Same key + same request body, already completed: replays the cached
 *   response WITHOUT re-running the handler (the actual idempotency
 *   guarantee).
 * - Same key + DIFFERENT request body: 409 — a real client bug (reusing a
 *   key for a different logical request), not silently replayed.
 * - Same key, reservation race (a genuinely concurrent duplicate request
 *   is still in flight, response not recorded yet): 409 retryable — safer
 *   than blocking or double-executing the handler.
 */
export async function withIdempotency<T>(
  db: DbClient,
  info: IdempotencyRequestInfo,
  handler: () => Promise<T>,
): Promise<T> {
  if (!info.key) {
    return handler();
  }

  const requestHash = hashRequest(info.method, info.path, info.body);

  const existing = await idempotencyRepository.find(db, info.scope, info.key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw ProblemError.conflict(
        "Idempotency-Key was already used for a different request body — use a new key for a new logical request.",
      );
    }
    if (existing.responseStatus !== null) {
      return existing.responseBody as T;
    }
    throw ProblemError.conflict("A request with this Idempotency-Key is already being processed.", true);
  }

  try {
    await idempotencyRepository.reserve(db, {
      key: info.key,
      scope: info.scope,
      requestHash,
      organizationId: info.organizationId,
      userId: info.userId,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_KEY_TTL_MS),
    });
  } catch (err) {
    // Unique-constraint violation on (scope, key): a concurrent request
    // won the race to reserve this key between our find() and reserve()
    // above. Treat it the same as "found an existing row" rather than
    // letting a raw Prisma error surface as a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ProblemError.conflict("A request with this Idempotency-Key is already being processed.", true);
    }
    throw err;
  }

  const result = await handler();

  const reserved = await idempotencyRepository.find(db, info.scope, info.key);
  if (reserved) {
    await idempotencyRepository.complete(db, reserved.id, { responseStatus: 200, responseBody: result as object });
  }

  return result;
}
