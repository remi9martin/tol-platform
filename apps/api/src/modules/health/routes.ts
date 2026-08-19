// apps/api/src/modules/health/routes.ts — liveness/readiness (the spec:
// "Health — liveness + readiness; dependency-specific status"). No auth —
// these exist for infra/orchestration to probe, not for API consumers.

import type { FastifyPluginAsync } from "fastify";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async (_request, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  app.get("/readyz", async (request, reply) => {
    try {
      await app.db.$queryRaw`SELECT 1`;
      return reply.code(200).send({ status: "ready", dependencies: { postgres: "ok" } });
    } catch (err) {
      request.log.error({ err }, "readiness check failed: postgres unreachable");
      return reply.code(503).send({ status: "not_ready", dependencies: { postgres: "error" } });
    }
  });
};

export default healthRoutes;
