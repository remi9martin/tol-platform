// packages/queue/src/connection.ts
//
// A PRODUCER-side connection — deliberately different tuning from
// apps/worker's own consumer-side one (apps/worker/src/redis.ts):
// apps/worker's Worker uses BLOCKING Redis commands (BRPOPLPUSH-style),
// which is why IT needs `maxRetriesPerRequest: null` (retry forever,
// never let ioredis's own retry-budget break the blocking wait) and an
// infinite reconnect strategy (a long-lived process SHOULD wait out an
// outage — an earlier OUTAGE test proves this). A producer's `.add()`
// call, by contrast, happens inside a short-lived apps/api HTTP request
// — enqueueing is documented everywhere in this package as ADDITIVE,
// never required for the request's own synchronous correctness path
// (ADR-0014 part 6), so a slow/unreachable Redis should fail
// FAST here, not hold an HTTP response open waiting for a retry budget
// meant for a process that lives for hours.

import { Redis, type RedisOptions } from "ioredis";
import { getConfig } from "@tol/config";

const PRODUCER_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy(attempts: number) {
    // Bounded, unlike the consumer's — a producer connection that can't
    // reach Redis after a few tries should stop trying and let each
    // individual enqueue call fail fast (callers already wrap every
    // enqueue in try/catch — see enqueue.ts) rather than accumulate an
    // ever-growing reconnect loop behind a request-scoped call.
    if (attempts > 3) return null;
    return Math.min(attempts * 200, 1000);
  },
};

let sharedConnection: Redis | undefined;

export function getProducerConnection(): Redis {
  if (!sharedConnection) {
    sharedConnection = new Redis(getConfig().redisUrl, PRODUCER_OPTIONS);
    sharedConnection.on("error", () => {
      // Deliberately silent at the connection level — every enqueue call
      // site (enqueue.ts) already catches and logs its own failure with
      // real context (which job, which entity id); a second, contextless
      // log line here would just be noise apps/api's own logs don't need.
    });
  }
  return sharedConnection;
}

export async function disconnectProducerConnection(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => sharedConnection?.disconnect());
    sharedConnection = undefined;
  }
}

/** Test-only escape hatch, mirroring every other package's own resetXForTests() convention. */
export function resetProducerConnectionForTests(): void {
  sharedConnection = undefined;
}
