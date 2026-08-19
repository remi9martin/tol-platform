// packages/db/src/client.ts
//
// Single PrismaClient instance for the whole process. apps/api and
// apps/worker (later) import repositories from this package's public
// index.ts — they never import PrismaClient or @prisma/client directly
// (the spec: "Repositories are defined in packages/db; routes never call
// Prisma directly").

import { PrismaClient } from "@prisma/client";

declare global {
  var __tolPrisma: PrismaClient | undefined;
}

/**
 * In dev, module reloads (tsx watch, Next.js route handler HMR) would
 * otherwise spin up a fresh PrismaClient — and a fresh connection pool —
 * on every reload. Stashing the instance on `globalThis` survives reloads
 * within the same process. Production/test processes just get one
 * instance for their lifetime either way.
 */
export const prisma: PrismaClient =
  globalThis.__tolPrisma ??
  new PrismaClient({
    log: process.env["NODE_ENV"] === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env["NODE_ENV"] !== "production") {
  globalThis.__tolPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
