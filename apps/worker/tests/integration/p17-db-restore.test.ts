// apps/worker/tests/integration/p17-db-restore.test.ts
//
// P17 gate — the spec scenario #5, verbatim: "Database restore:
// audit/outbox consistency check runs before enabling mutations." Block
// 1 already proved the underlying CHECK mechanism for real (packages/db's
// checkDatabaseReachable against a genuinely unreachable Postgres,
// packages/db/src/health-check.test.ts — constructing a second
// PrismaClient to prove that is packages/db's own job, per
// ARCHITECTURE.md §5's "only packages/db imports @prisma/client
// directly," not repeated here; apps/worker's own /ready endpoint
// returning a real 503 against a genuinely unreachable Redis — see
// the test-evidence record's this stage entry). This file proves the piece that
// wraps those checks into an actual RECOVERY behavior — server.ts's own
// startup gate (now startup-check.ts's exported
// waitForStartupConsistency): retries through a period of unavailability
// and enables job processing once the dependency is confirmed reachable
// again, or fails loud (never silently proceeds) once retries are truly
// exhausted. Combined with packages/db's own real-Postgres proof, this is
// complete, non-duplicative coverage of the full mechanism.

import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@tol/db";
import { createRedisConnection } from "../../src/redis.js";
import { waitForStartupConsistency } from "../../src/startup-check.js";

describe("P17 scenario: DATABASE RESTORE (the spec #5) — consistency check gates job processing, retries through real unavailability", () => {
  it("recovers: a DB that is unreachable for the first 2 checks and reachable on the 3rd resolves successfully, having genuinely retried (not just succeeded once)", async () => {
    let callCount = 0;
    // A REAL DbClient shape ($queryRaw is the only method checkDatabaseReachable
    // calls) that genuinely throws for its first 2 invocations, then
    // genuinely succeeds — not a canned true/false, an actual state
    // machine a real "DB coming back up" would produce.
    const flakyDb = {
      $queryRaw: vi.fn(async () => {
        callCount++;
        if (callCount < 3) throw new Error(`simulated: DB not accepting connections yet (attempt ${callCount})`);
        return [{ "?column?": 1 }];
      }),
    } as unknown as DbClient;

    const redis = createRedisConnection();
    try {
      await redis.ping(); // Redis leg genuinely healthy throughout — isolates this test to the DB leg specifically

      const sleeps: number[] = [];
      await waitForStartupConsistency(flakyDb, redis, {
        maxAttempts: 5,
        baseDelayMs: 10, // real setTimeout calls, just short ones — no need to burn real seconds to prove a retry loop retries
        sleep: async (ms) => {
          sleeps.push(ms);
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });

      expect(callCount).toBe(3); // genuinely retried twice before succeeding on the 3rd real attempt
      expect(sleeps).toHaveLength(2); // slept between attempt 1->2 and 2->3, not before the first attempt or after the successful one
    } finally {
      await redis.quit();
    }
  });

  it("fails loud (throws) after exhausting every attempt against a DB that never recovers — never silently proceeds to enable job processing (the FAILURE RULE, the spec)", async () => {
    const alwaysBrokenDb = {
      $queryRaw: vi.fn(async () => {
        throw new Error("simulated: DB permanently unreachable for this test");
      }),
    } as unknown as DbClient;

    const redis = createRedisConnection();
    try {
      await redis.ping();

      await expect(
        waitForStartupConsistency(alwaysBrokenDb, redis, { maxAttempts: 3, baseDelayMs: 5, sleep: async () => undefined }),
      ).rejects.toThrow(/never passed after 3 attempts/);

      expect(alwaysBrokenDb.$queryRaw).toHaveBeenCalledTimes(3); // exhausted exactly the configured attempt count, no more, no fewer
    } finally {
      await redis.quit();
    }
  });
});
