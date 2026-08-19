// apps/api/src/plugins/observability.ts
//
// the spec: "Structured JSON, request/correlation IDs, actor/org IDs,
// safe error codes, redaction." Fastify's logger is pino under the hood
// and is configured at Fastify(...) construction time (app.ts), not via
// `register()` like the other plugins in this folder — so this file
// exports a config FACTORY, not a Fastify plugin, but lives here to keep
// "the file that owns observability policy" discoverable in one place
// per p.9's file map.
//
// Redaction paths below are exactly what the spec requires: "No
// sensitive payloads in analytics, logs or error tracking. Redaction unit
// tests are mandatory" — see observability.test.ts.

import type { FastifyServerOptions } from "fastify";

export const REDACTED_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['x-csrf-token']",
  "res.headers['set-cookie']",
  "body.password",
  "body.passwordHash",
];

export function buildLoggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
        };
      },
    },
  };
}
