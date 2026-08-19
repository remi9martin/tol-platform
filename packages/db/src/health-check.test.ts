// packages/db/src/health-check.test.ts
//
// earlier, P17 scenario #5 ("Database restore: audit/outbox consistency
// check runs before enabling mutations"). Both branches here are REAL —
// the "unreachable" case constructs a genuine second PrismaClient
// pointed at a port nothing listens on and lets it actually fail to
// connect, rather than mocking $queryRaw to throw. This file (not
// apps/worker's own test suite) is where that real-Postgres-failure
// proof belongs, per this package's own "only packages/db imports
// @prisma/client directly" rule (ARCHITECTURE.md §5) — apps/worker's
// tests exercise the GATING logic built on top of this function's
// result, via a stub, not this function's own correctness.

import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "./client.js";
import { checkDatabaseReachable } from "./health-check.js";

describe("checkDatabaseReachable", () => {
  it("returns ok:true against the real, reachable database", async () => {
    const result = await checkDatabaseReachable(prisma);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it(
    "returns ok:false with a real connection error against a genuinely unreachable database — port 59999 has nothing listening; connection_limit=1&pool_timeout=2 keeps this fast instead of waiting on Prisma's default acquisition timeout",
    async () => {
      const brokenClient = new PrismaClient({
        datasources: { db: { url: "postgresql://tol:changeme@localhost:59999/tol_platform?connection_limit=1&pool_timeout=2" } },
      });
      try {
        const result = await checkDatabaseReachable(brokenClient);
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
      } finally {
        await brokenClient.$disconnect();
      }
    },
    15_000,
  );
});
