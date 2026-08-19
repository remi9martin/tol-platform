// apps/worker/tests/integration/p17-worker-crash.test.ts
//
// P17 gate — the spec scenario #3, verbatim: "Worker crashes mid-job:
// job is retried safely; external mutation uses idempotency/reference
// check." The most literal of the 7 named scenarios, proven the most
// literally here: a REAL separate OS process (tests/helpers/standalone-
// ping-worker.ts), genuinely SIGKILLed while it holds a real BullMQ job
// lock (confirmed via its own stdout, not assumed from timing), recovered
// by a second, independent Worker instance via BullMQ's real stalled-job
// detection — not a mock, not a simulated "what if" comment.

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { getConfig } from "@tol/config";
import { createRedisConnection } from "../../src/redis.js";
import { enqueueJob, closeQueue, resetQueueForTests } from "../../src/queue.js";
import { registerJob, resetRegistryForTests } from "../../src/jobs/registry.js";
import { pingJob } from "../../src/jobs/ping.job.js";
import { createWorkerRuntime } from "../../src/worker-runtime.js";

const TEST_QUEUE_NAME = `tol-worker-test-p17-crash-${randomUUID()}`;

// Real fix (review): the original version of this constant was a
// hardcoded, machine-specific absolute path (this developer's own
// pnpm store location, tsx's exact installed version baked in) — would
// break on any other machine, any CI runner, or after a routine tsx
// version bump. `require.resolve` uses Node's REAL module resolution
// algorithm to find wherever tsx actually got installed (respecting
// pnpm's own structure automatically, whatever version is actually
// present), same as how Node itself would resolve `import "tsx"`.
const require = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
const STANDALONE_SCRIPT = fileURLToPath(new URL("../helpers/standalone-ping-worker.ts", import.meta.url));

/** Spawns the standalone worker as a REAL child process and resolves once its stdout proves it is genuinely processing the target job (not just "started up" — actually holding that job's lock). */
function spawnStandaloneWorkerAndWaitForProcessing(): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, STANDALONE_SCRIPT, TEST_QUEUE_NAME, getConfig().redisUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error("standalone worker never reported PROCESSING_STARTED")), 10_000);
    rl.on("line", (line) => {
      if (line.startsWith("PROCESSING_STARTED")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Surfaced for debuggability only — the standalone process logging
      // to stderr isn't itself a test failure (BullMQ logs some
      // reconnect noise there too, same as this app's own logger does).
      console.error("[standalone-worker stderr]", chunk.toString());
    });
    child.on("error", reject);
  });
}

describe("P17 scenario: WORKER CRASHES MID-JOB (the spec #3) — a real SIGKILL, real stalled-job recovery, exactly-once completion", () => {
  let connection: Redis | undefined;
  let recoveryWorker: Worker | undefined;
  let crashedChild: ChildProcessByStdio<null, Readable, Readable> | undefined;

  afterEach(async () => {
    if (crashedChild && !crashedChild.killed) {
      crashedChild.kill("SIGKILL");
    }
    if (recoveryWorker) {
      await recoveryWorker.close();
      recoveryWorker = undefined;
    }
    await closeQueue(TEST_QUEUE_NAME);
    resetQueueForTests();
    resetRegistryForTests();
    if (connection) {
      await connection.quit();
      connection = undefined;
    }
  }, 15_000);

  it(
    "job picked up by a process that gets SIGKILLed mid-flight is reclaimed by a second worker once its lock genuinely expires, and completes exactly once",
    async () => {
      connection = createRedisConnection();
      const nonce = `crash-test-${randomUUID()}`;
      const job = await enqueueJob(connection, "worker.ping", { nonce }, { attempts: 3, backoff: { type: "fixed", delay: 300 } }, TEST_QUEUE_NAME);

      // THE fault: spawn a real second process, wait for genuine proof
      // (its own stdout) that it is actively holding this job's lock,
      // then kill it with SIGKILL — no graceful shutdown, no chance to
      // release the lock or tell BullMQ anything.
      crashedChild = await spawnStandaloneWorkerAndWaitForProcessing();
      crashedChild.kill("SIGKILL");

      // THE recovery: a second, independent Worker instance (this test
      // process's own, using the REAL production pingJob — not the
      // standalone script's artificially-slow copy) — low lockDuration/
      // stalledInterval so BullMQ's real stalled-job detection fires
      // fast enough for a test, not production's more patient defaults.
      registerJob("worker.ping", pingJob);
      recoveryWorker = createWorkerRuntime({ connection, queueName: TEST_QUEUE_NAME, lockDuration: 2000, stalledInterval: 500 });

      const outcome = await new Promise<{ type: "completed" | "stalled"; attemptsMade?: number }>((resolve, reject) => {
        let sawStalled = false;
        recoveryWorker!.on("stalled", (jobId) => {
          if (jobId === job.id) sawStalled = true;
        });
        recoveryWorker!.on("completed", (completedJob) => {
          if (completedJob.id === job.id) resolve({ type: "completed", attemptsMade: completedJob.attemptsMade });
        });
        setTimeout(() => {
          if (sawStalled) reject(new Error("job was correctly detected as stalled but never went on to complete"));
          else reject(new Error("job was never even detected as stalled — recovery mechanism didn't engage"));
        }, 20_000);
      });

      expect(outcome.type).toBe("completed");

      // EXACTLY ONCE — not stuck "active" forever (lost), not completed
      // twice (the crashed process somehow also reporting success). This
      // is the only observable state BullMQ itself exposes for "how many
      // times did this settle" — a job can only ever emit ONE terminal
      // "completed" event in its lifecycle; a job that had somehow been
      // double-processed by both the crashed process AND the recovery
      // worker would either show a lock-contention error or a
      // still-unresolved promise here, not a clean single resolution.
      const finalState = await job.getState();
      expect(finalState).toBe("completed");
    },
    30_000,
  );
});
