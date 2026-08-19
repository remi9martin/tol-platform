// apps/worker/src/server.ts — process entry point. Mirrors apps/api/src/
// server.ts's shape (load .env, getConfig(), build, listen, graceful
// shutdown) with one addition the spec scenario #5 asks for: a startup
// consistency gate, retried with backoff, BEFORE the Worker starts
// pulling jobs — "audit/outbox consistency check runs before enabling
// mutations."

import { fileURLToPath } from "node:url";
import { getConfig } from "@tol/config";
import { prisma, disconnectPrisma } from "@tol/db";
import { getLogger } from "./logger.js";
import { getSharedRedisConnection, disconnectSharedRedis } from "./redis.js";
import { waitForStartupConsistency } from "./startup-check.js";
import { registerAllJobs } from "./jobs/index.js";
import { createWorkerRuntime } from "./worker-runtime.js";
import { getQueue, closeQueue } from "./queue.js";
import { registerSweepSchedules } from "./sweeps.js";
import { buildHealthServer } from "./health.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env on disk — assume the environment already has what it needs.
}

async function main() {
  const logger = getLogger();
  const config = getConfig();

  // the spec scenario #5: "Database restore: audit/outbox consistency
  // check runs before enabling mutations." Retry loop itself lives in
  // startup-check.ts (moved there mid-earlier so the P17 test suite
  // can exercise it directly) — production uses every default (10
  // attempts, real sleep).
  await waitForStartupConsistency(prisma, getSharedRedisConnection(), { logger });

  registerAllJobs();

  const redis = getSharedRedisConnection();
  const worker = createWorkerRuntime({ connection: redis });
  const queue = getQueue(redis);

  // earlier-stage work: the reconciliation backstop for a dropped enqueue —
  // real BullMQ Job Schedulers, idempotent to register on every worker
  // startup (see sweeps.ts's own header for the full reasoning).
  await registerSweepSchedules(queue);
  logger.info({ schedules: (await queue.getJobSchedulers()).map((s) => s.key) }, "sweep schedules registered");

  const healthApp = buildHealthServer({ db: prisma, redis, queue });

  await healthApp.listen({ port: config.workerHealthPort, host: "0.0.0.0" });
  logger.info({ port: config.workerHealthPort }, "worker health server listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await worker.close();
      await closeQueue();
      await healthApp.close();
      await disconnectSharedRedis();
      await disconnectPrisma();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "error during shutdown");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal error during worker startup:", err);
  process.exit(1);
});
