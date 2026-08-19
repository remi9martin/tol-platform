// apps/api/src/plugins/db.ts — decorates the Fastify instance with the
// shared Prisma client from @tol/db and closes it on shutdown. Routes
// still never import @tol/db's `prisma` directly (they go through
// services -> repositories); this decoration exists for the readiness
// probe (plugins isn't the exception to "no direct Prisma access" — it's
// literally the health-check plumbing).

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma, disconnectPrisma } from "@tol/db";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof prisma;
  }
}

const dbPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("db", prisma);
  app.addHook("onClose", async () => {
    await disconnectPrisma();
  });
};

export default fp(dbPlugin, { name: "db" });
