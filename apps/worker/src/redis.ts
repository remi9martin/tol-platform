// apps/worker/src/redis.ts
//
// the spec: "Queues use Redis/BullMQ or equivalent." One ioredis
// connection is shared across this app's Queue + Worker + QueueEvents in
// production (server.ts) — BullMQ's own docs endorse passing a single
// pre-built ioredis instance and internally `.duplicate()`-ing it where a
// blocking command needs its own connection, rather than each BullMQ
// primitive opening an independent TCP connection.
//
// `maxRetriesPerRequest: null` is BullMQ's own hard requirement (not this
// codebase's preference) for any connection a Worker/QueueEvents uses —
// ioredis's default retry-per-request would otherwise make a blocking
// BRPOPLPUSH-style call give up and reject instead of blocking, which is
// exactly the failure mode the OUTAGE test exists to rule out.

// Named import, not default — ioredis is a CJS package whose .d.ts
// declares `export { default } from "./Redis"` alongside `export {
// default as Redis } from "./Redis"`; under this repo's
// moduleResolution: NodeNext, the default-import path type-checks as the
// (non-constructable) module namespace object rather than the class
// itself. The named import sidesteps that CJS/ESM default-interop
// ambiguity entirely and is exactly the class either way.
import { Redis, type RedisOptions } from "ioredis";
import { getConfig } from "@tol/config";
import { getLogger } from "./logger.js";

const BASE_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  // Real, bounded reconnect-with-backoff — the mechanism the
  // OUTAGE test proves directly: a connection that drops keeps retrying
  // on its own schedule (never gives up permanently), capped so a long
  // outage doesn't hammer Redis once it comes back.
  retryStrategy(attempts: number) {
    return Math.min(attempts * 200, 5000);
  },
};

/**
 * Creates a NEW, independent ioredis connection — used by server.ts for
 * the one shared production connection, and by the tests to create
 * their OWN disposable connection for outage/reconnect fault injection
 * (a test must never disconnect the shared production connection out
 * from under whatever else in the same process is using it).
 */
export function createRedisConnection(overrideUrl?: string): Redis {
  const url = overrideUrl ?? getConfig().redisUrl;
  const logger = getLogger();
  const connection = new Redis(url, BASE_REDIS_OPTIONS);

  connection.on("error", (err: Error) => logger.warn({ err: err.message }, "redis connection error"));
  connection.on("reconnecting", (delayMs: number) => logger.info({ delayMs }, "redis reconnecting"));
  connection.on("ready", () => logger.info("redis connection ready"));

  return connection;
}

let sharedConnection: Redis | undefined;

/** The one connection apps/worker's Queue + Worker + health server's readiness check share in production. */
export function getSharedRedisConnection(): Redis {
  if (!sharedConnection) sharedConnection = createRedisConnection();
  return sharedConnection;
}

export async function disconnectSharedRedis(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = undefined;
  }
}

/** Test-only escape hatch, mirroring @tol/config's resetConfigCacheForTests(). */
export function resetSharedRedisForTests(): void {
  sharedConnection = undefined;
}
