// apps/api/src/plugins/rate-limit.ts
//
// the spec: "Rate limiting by user/org/IP class with stricter limits
// for auth, exports and cryptographic release endpoints." earlier has no
// exports/crypto-release endpoints yet; the stricter tier applies to
// /auth/login (brute-force/credential-stuffing surface) specifically.

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import rateLimit from "@fastify/rate-limit";

const globalRateLimitPlugin: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.actor?.userId ?? request.ip,
  });
};

export default fp(globalRateLimitPlugin, { name: "rate-limit" });
