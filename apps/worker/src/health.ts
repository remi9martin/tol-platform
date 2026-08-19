// apps/worker/src/health.ts
//
// the spec Observability signal table: "Health || liveness +
// readiness; dependency-specific status." A small Fastify app (not the
// BullMQ Worker itself — that has no HTTP surface) exposing:
//   GET /health — liveness: the process is up and answering at all.
//   GET /ready  — readiness: DB + Redis both reachable right now (scope
//                 scenario #5's gate, computed live on every call, never
//                 cached/stale).
//   GET /status — operator view of queue depth + BullMQ's failed set,
//                 which IS this app's dead-letter queue (the spec:
//                 "A dead-letter view is mandatory in operator
//                 controls").

import Fastify from "fastify";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { DbClient } from "@tol/db";
import { checkStartupConsistency } from "./startup-check.js";
import { getLogger } from "./logger.js";

export interface HealthServerDeps {
  db: DbClient;
  redis: Redis;
  queue: Queue;
}

// No explicit `: FastifyInstance` return-type annotation — Fastify's
// default `FastifyInstance` generic expects its own `FastifyBaseLogger`
// shape, which a raw pino `Logger` (passed via `loggerInstance` below)
// doesn't structurally satisfy (missing `msgPrefix`, a Fastify-specific
// addition) even though it works correctly at runtime — this is a known
// Fastify+pino typing friction, not a real bug. Letting TypeScript infer
// this function's actual, more-specific return type (rather than forcing
// it to widen to the mismatched default) sidesteps the false-positive
// error without an `as`/`any` escape hatch.
export function buildHealthServer(deps: HealthServerDeps) {
  const app = Fastify({ loggerInstance: getLogger() });

  app.get("/health", async () => ({
    status: "ok",
    app: "tol-worker",
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async (_request, reply) => {
    const result = await checkStartupConsistency(deps.db, deps.redis);
    if (!result.ok) {
      reply.code(503);
    }
    return result;
  });

  app.get("/status", async () => {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      deps.queue.getWaitingCount(),
      deps.queue.getActiveCount(),
      deps.queue.getCompletedCount(),
      deps.queue.getFailedCount(),
      deps.queue.getDelayedCount(),
    ]);
    const deadLetter = await deps.queue.getFailed(0, 49);
    return {
      queue: deps.queue.name,
      counts: { waiting, active, completed, failed, delayed },
      deadLetter: deadLetter.map((job) => ({
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        data: job.data as unknown,
        timestamp: job.timestamp,
      })),
    };
  });

  return app;
}
