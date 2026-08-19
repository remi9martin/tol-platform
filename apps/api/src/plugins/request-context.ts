// apps/api/src/plugins/request-context.ts
//
// Populates request.context (the spec's requestId/correlationId/
// ipClass/userAgentClass) on every request, before any route handler
// runs. Accepts an incoming x-request-id/x-correlation-id for
// cross-service correlation, generating fresh ones when absent.

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { classifyIp, classifyUserAgent, type RequestContext } from "../shared/request-context.js";

declare module "fastify" {
  interface FastifyRequest {
    context: RequestContext;
  }
}

const requestContextPlugin: FastifyPluginAsync = async (app) => {
  // Fastify's decorateRequest requires a default matching the declared
  // (non-nullable) property type; `null` is cast here as the placeholder
  // — the onRequest hook below unconditionally overwrites it before any
  // route handler can observe the placeholder value.
  app.decorateRequest("context", null as unknown as RequestContext);

  app.addHook("onRequest", async (request) => {
    const requestId = (request.headers["x-request-id"] as string | undefined) || randomUUID();
    const correlationId = (request.headers["x-correlation-id"] as string | undefined) || requestId;
    request.context = {
      requestId,
      correlationId,
      ipClass: classifyIp(request.ip),
      userAgentClass: classifyUserAgent(request.headers["user-agent"]),
    };
    request.log = request.log.child({ requestId, correlationId });
  });

  // request.context can still be the null placeholder here for requests
  // that never reach the onRequest hook above — CORS preflight (OPTIONS)
  // is short-circuited by @fastify/cors before this plugin's onRequest
  // hook runs, and reply.send() from inside THAT short-circuit still
  // triggers onSend. Caught live during this stage browser testing: every
  // real browser login attempt sends a preflight OPTIONS first, and it
  // was crashing with "Cannot read properties of null (reading
  // 'requestId')", which made CORS itself fail (500 on the preflight),
  // which made the browser block the real POST entirely — a silent,
  // total login outage that no server-side curl test would ever catch
  // (curl doesn't send preflights). Falls back to Fastify's own
  // request.id so the header is still meaningful either way.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.context?.requestId ?? request.id);
    return payload;
  });
};

export default fp(requestContextPlugin, { name: "request-context" });
