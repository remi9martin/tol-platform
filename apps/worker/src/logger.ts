// apps/worker/src/logger.ts
//
// the spec Observability signal table: "Logs || Structured JSON,
// request/correlation IDs, actor/org IDs, safe error codes, redaction."
// apps/api gets this for free from Fastify's bundled pino instance
// (apps/api/src/plugins/observability.ts's own header comment notes
// packages/observability is still an unbuilt earlier placeholder, so
// apps/api rolls a small local logger-options file instead of depending
// on it). apps/worker has no Fastify request/response cycle for its
// BullMQ Worker side (only the small health/status HTTP surface does),
// so this file creates ONE pino instance up front and shares it across
// both — BullMQ job-lifecycle logs and the health server's own request
// logs — rather than instantiating two independent loggers.

import pino from "pino";
import { getConfig } from "@tol/config";

let cached: pino.Logger | undefined;

/** Same "cache after first call" shape as @tol/config's getConfig() — one logger instance for the process, not one per call site. */
export function getLogger(): pino.Logger {
  if (cached) return cached;
  const config = getConfig();
  cached = pino({
    level: config.logLevel,
    redact: {
      // Same redaction list apps/api's observability plugin uses for
      // HTTP headers/cookies — job payloads never carry these fields
      // directly, but a defensively-shared list costs nothing and stays
      // consistent if a future job ever logs a raw request-shaped object.
      paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.passwordHash"],
      censor: "[REDACTED]",
    },
    base: { app: "tol-worker" },
  });
  return cached;
}

/** Test-only escape hatch, mirroring @tol/config's resetConfigCacheForTests(). */
export function resetLoggerForTests(): void {
  cached = undefined;
}
