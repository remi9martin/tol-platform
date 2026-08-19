// apps/worker/tests/unit/startup-check.test.ts
//
// Pure logic tests for the GATING behavior on top of checkDatabaseReachable
// (real-Postgres-failure proof lives in packages/db/src/health-check.test.ts,
// per ARCHITECTURE.md §5's "only packages/db imports Prisma directly" —
// see startup-check.ts's own header comment). Fake db/redis stubs here
// are legitimate for THIS file's job: proving checkStartupConsistency's
// own AND-logic (ok only when BOTH pass) and error propagation, not
// re-proving that a broken Postgres connection throws.

import { describe, expect, it } from "vitest";
import type { DbClient } from "@tol/db";
import type { Redis } from "ioredis";
import { checkStartupConsistency, checkRedisReachable } from "../../src/startup-check.js";

function fakeDb(behavior: "ok" | "fail"): DbClient {
  return {
    $queryRaw: async () => {
      if (behavior === "fail") throw new Error("simulated DB connection refused");
      return [{ "?column?": 1 }];
    },
  } as unknown as DbClient;
}

function fakeRedis(behavior: "ok" | "fail" | "weird-reply"): Redis {
  return {
    ping: async () => {
      if (behavior === "fail") throw new Error("simulated Redis connection refused");
      if (behavior === "weird-reply") return "WEIRD";
      return "PONG";
    },
  } as unknown as Redis;
}

describe("checkStartupConsistency", () => {
  it("ok:true when both DB and Redis are reachable", async () => {
    const result = await checkStartupConsistency(fakeDb("ok"), fakeRedis("ok"));
    expect(result.ok).toBe(true);
    expect(result.database.ok).toBe(true);
    expect(result.redis.ok).toBe(true);
    expect(result.checkedAt).toBeTruthy();
  });

  it("ok:false when DB fails even though Redis is fine — the FAILURE RULE (the spec): never partially ready", async () => {
    const result = await checkStartupConsistency(fakeDb("fail"), fakeRedis("ok"));
    expect(result.ok).toBe(false);
    expect(result.database.ok).toBe(false);
    expect(result.database.error).toMatch(/simulated DB connection refused/);
    expect(result.redis.ok).toBe(true);
  });

  it("ok:false when Redis fails even though DB is fine", async () => {
    const result = await checkStartupConsistency(fakeDb("ok"), fakeRedis("fail"));
    expect(result.ok).toBe(false);
    expect(result.redis.ok).toBe(false);
    expect(result.redis.error).toMatch(/simulated Redis connection refused/);
    expect(result.database.ok).toBe(true);
  });

  it("ok:false when both fail", async () => {
    const result = await checkStartupConsistency(fakeDb("fail"), fakeRedis("fail"));
    expect(result.ok).toBe(false);
  });
});

describe("checkRedisReachable", () => {
  it("treats a non-PONG reply as not ok — defensive: never trust a merely-truthy reply", async () => {
    const result = await checkRedisReachable(fakeRedis("weird-reply"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unexpected PING reply/);
  });
});
