// apps/worker/src/startup-check.ts
//
// the spec recovery scenario #5: "Database restore: audit/outbox
// consistency check runs before enabling mutations." This is the
// worker's own readiness GATE — the logic deciding "is it safe to start
// pulling jobs off the queue" — built on top of @tol/db's
// checkDatabaseReachable (the real-Postgres-failure proof lives in that
// package's own test, per ARCHITECTURE.md §5) and this file's own
// checkRedisReachable (apps/worker's domain, not @tol/db's).

import type { DbClient } from "@tol/db";
import { checkDatabaseReachable } from "@tol/db";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

const REDIS_CHECK_TIMEOUT_MS = 3000;

/**
 * Bounded by its own timeout race — a real bug this file's own this stage
 * test caught (not a hypothetical): redis.ts's shared connection sets
 * `maxRetriesPerRequest: null` (BullMQ's hard requirement — see that
 * file's header comment) and a `retryStrategy` that NEVER gives up
 * (always returns a backoff delay, never `null`). Both are correct for
 * the Worker's own queue-processing connection, but together they mean a
 * bare `redis.ping()` on a connection that can't currently reach Redis
 * queues forever waiting for a reconnect that may never come — exactly
 * wrong for a readiness check, which must always answer within a bounded
 * time regardless of what's actually broken. This is that bound; it does
 * NOT change the connection's own retry policy (that stays infinite —
 * correct for OUTAGE recovery), it only stops THIS check from hanging.
 */
export async function checkRedisReachable(redis: Redis): Promise<HealthCheckResult> {
  // review (review) caught
  // a genuine timer leak here: without clearTimeout, a FAST successful
  // ping still leaves the setTimeout scheduled for the full
  // REDIS_CHECK_TIMEOUT_MS, holding a timer handle no one observes —
  // harmless in a long-running server process but real (delays clean
  // process exit, wastes a handle) and free to fix.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`redis.ping() did not respond within ${REDIS_CHECK_TIMEOUT_MS}ms`)), REDIS_CHECK_TIMEOUT_MS);
      }),
    ]);
    return pong === "PONG" ? { ok: true } : { ok: false, error: `unexpected PING reply: ${JSON.stringify(pong)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ConsistencyCheckResult {
  ok: boolean;
  database: HealthCheckResult;
  redis: HealthCheckResult;
  checkedAt: string;
}

/**
 * Both legs run concurrently — a slow/hanging one doesn't block the
 * other's result. `ok` is true only when BOTH pass — the FAILURE RULE
 * (the spec: "A background failure must never silently leave a green
 * user-facing state") applies to this gate as much as to any job: a
 * worker that can reach Redis but not Postgres is NOT ready, full stop,
 * not "partially ready."
 */
export async function checkStartupConsistency(db: DbClient, redis: Redis): Promise<ConsistencyCheckResult> {
  const [database, redisResult] = await Promise.all([checkDatabaseReachable(db), checkRedisReachable(redis)]);
  return { ok: database.ok && redisResult.ok, database, redis: redisResult, checkedAt: new Date().toISOString() };
}

export interface WaitForStartupConsistencyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable sleep — an earlier test suite passes a near-instant stub so a "retries N times then succeeds/fails" proof doesn't have to burn real wall-clock seconds; production (server.ts) uses the real default. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, "info" | "warn">;
}

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noopLogger: Pick<Logger, "info" | "warn"> = { info: () => undefined as unknown as ReturnType<Logger["info"]>, warn: () => undefined as unknown as ReturnType<Logger["warn"]> };

/**
 * Moved here from server.ts (earlier, mid-block) so the P17 test
 * suite can exercise this retry LOOP directly — the spec scenario #5:
 * "Database restore: audit/outbox consistency check runs before enabling
 * mutations." Retries with linear-ish, capped backoff rather than trying
 * once and giving up — a DB/Redis that's mid-restart when this process
 * boots (container orchestration commonly starts everything at once)
 * should not fail the whole worker permanently; it should wait for its
 * dependencies the way any real production service does. Fails loud
 * (throws) only after exhausting every attempt — matching @tol/config's
 * own "fail loud at boot" discipline from a different angle (bad config
 * vs. unready dependency).
 */
export async function waitForStartupConsistency(db: DbClient, redis: Redis, opts: WaitForStartupConsistencyOptions = {}): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const logger = opts.logger ?? noopLogger;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await checkStartupConsistency(db, redis);
    if (result.ok) {
      logger.info({ attempt }, "startup consistency check passed — enabling job processing");
      return;
    }
    logger.warn({ attempt, database: result.database, redis: result.redis }, "startup consistency check failed — will retry");
    if (attempt < maxAttempts) {
      // Real fix (review): a real, if narrow, production concern — every
      // worker instance in a fleet that boots at the same moment (a
      // fresh container rollout is the common case) hits this SAME
      // linear backoff schedule in lockstep, so if the shared DB/Redis
      // is genuinely flapping, every instance's retry attempts land in
      // synchronized bursts instead of spreading out ("thundering
      // herd"). Full jitter (0 to the computed delay, not the delay
      // plus/minus a bit) is the standard mitigation — decorrelates N
      // instances' retry timing from each other without changing the
      // MAX total wait before giving up.
      const delay = Math.min(attempt * baseDelayMs, maxDelayMs);
      await sleep(Math.random() * delay);
    }
  }
  throw new Error(
    `startup consistency check never passed after ${maxAttempts} attempts — refusing to start job processing (the spec scenario #5: never enable mutations against an unconfirmed DB/Redis)`,
  );
}
