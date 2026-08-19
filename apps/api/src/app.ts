// apps/api/src/app.ts — builds the Fastify instance: plugins, error
// handler, CORS, routes. server.ts is the only other file that touches
// this; everything else (modules/, shared/, plugins/) is composed here.

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { getConfig } from "@tol/config";
import { DomainTransitionError, MoneyInvariantError } from "@tol/domain";
import { buildLoggerOptions } from "./plugins/observability.js";
import dbPlugin from "./plugins/db.js";
import requestContextPlugin from "./plugins/request-context.js";
import authPlugin from "./plugins/auth.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import { ProblemError } from "./shared/errors.js";

import authRoutes from "./modules/auth/routes.js";
import organizationRoutes from "./modules/organizations/routes.js";
import membershipRoutes from "./modules/memberships/routes.js";
import auditRoutes from "./modules/audit/routes.js";
import meRoutes from "./modules/me/routes.js";
import healthRoutes from "./modules/health/routes.js";
// ---- earlier: P13 RFQ + P14 Deal Room ----
import opportunityRoutes from "./modules/opportunities/routes.js";
import capacityRoutes from "./modules/capacity/routes.js";
import rfqRoutes from "./modules/rfqs/routes.js";
import dealRoutes from "./modules/deals/routes.js";
// ---- earlier: Lockbox ----
import lockboxRoutes from "./modules/lockbox/routes.js";
// ---- earlier: Attribution ----
import claimRoutes from "./modules/claims/routes.js";
// ---- earlier: Passport (P6) + Marketplace (P5) ----
import passportRoutes from "./modules/passport/routes.js";
import marketplaceRoutes from "./modules/marketplace/routes.js";
// ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
import matchingRoutes from "./modules/matching/routes.js";
// ---- earlier: Economics (P15) ----
import economicsRoutes from "./modules/economics/routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig();

  const app = Fastify({
    logger: buildLoggerOptions(config.logLevel),
    genReqId: () => randomUUID(),
    // trustProxy defaults OFF (Fastify's own default). Only ever flip
    // this to `true` (or a specific trusted-hop count) once this service
    // is actually deployed behind a reverse proxy that OVERWRITES
    // X-Forwarded-For rather than passing a client-supplied value
    // through — flagged as a real gap by review (apps-api-core
    // block, 2026-08-18): with trustProxy on and no real proxy in front
    // (the local-dev-only shape, or a naive future deployment), any
    // client can forge X-Forwarded-For and spoof request.ip, defeating
    // both IP-class audit logging and IP-based rate limiting. Revisit
    // deliberately at actual deploy time, not by re-enabling this blind.
    trustProxy: false,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-Request-Id", "X-Correlation-Id"],
  });

  await app.register(dbPlugin);
  await app.register(requestContextPlugin);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin);

  // MUST be registered before any routes. Fastify captures a snapshot of
  // "the current error handler" onto each route's own compiled context at
  // the moment that route is registered — it does not re-resolve the
  // handler dynamically per-request. A setErrorHandler() call AFTER
  // routes exist silently does nothing for those already-registered
  // routes (they keep pointing at Fastify's built-in default handler,
  // which produces its own {statusCode, error, message} shape instead of
  // this file's problem+json one). Confirmed by direct reproduction
  // during this stage — every route returned Fastify's default error shape
  // with the right status code but the wrong body shape until this was
  // moved above the `app.register(...Routes)` calls below.
  //
  // the spec: "Use RFC-style problem responses: code, message,
  // requestId, fieldErrors, retryable, and safe details." The ONLY place
  // an error becomes an HTTP response — route/service code always
  // throws, never constructs a response body for a failure case.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ProblemError) {
      reply
        .code(err.status)
        .type("application/problem+json")
        .send({
          code: err.code,
          message: err.message,
          requestId: request.context?.requestId ?? request.id,
          fieldErrors: err.fieldErrors,
          retryable: err.retryable,
          details: err.details,
        });
      return;
    }

    // earlier: @tol/domain's assertValid*Transition() functions throw a
    // DomainTransitionError (InvalidOpportunityTransitionError/
    // InvalidRfqTransitionError/InvalidDealTransitionError) when a
    // caller attempts an illegal state transition (e.g. submitting a
    // quote after declining, or re-selecting an already-SELECTED RFQ) —
    // a CLIENT error (a bad/hostile/replayed request), not a server bug.
    // Caught here, centrally, rather than wrapping every one of
    // rfqs/deals service.ts's several assertValid*Transition call sites
    // in its own try/catch/rethrow-as-ProblemError.
    if (err instanceof DomainTransitionError) {
      reply
        .code(400)
        .type("application/problem+json")
        .send({
          code: "invalid_state_transition",
          message: err.message,
          requestId: request.context?.requestId ?? request.id,
          retryable: false,
        });
      return;
    }

    // Follow-up fix: @tol/domain/money.ts's assertCurrencyCode/
    // assertIntegerBps/assertBigIntMinorUnits/assertIntegerMinorUnits
    // throw MoneyInvariantError on a malformed value — same CLIENT-error
    // shape as DomainTransitionError just above (a bad/malformed request,
    // never a server bug), and same pre-existing gap: capacity/service.ts
    // and opportunities/service.ts already call parseBigIntMinorUnits
    // (which can throw this), with nothing here ever having caught it —
    // it fell through to the generic 500 path below, in every module
    // that already used these guards, not just the ones this pass adds.
    // Caught here, centrally, exactly like DomainTransitionError, rather
    // than wrapping every call site across every module in its own
    // try/catch/rethrow-as-ProblemError.
    if (err instanceof MoneyInvariantError) {
      reply
        .code(400)
        .type("application/problem+json")
        .send({
          code: "invalid_money_value",
          message: err.message,
          requestId: request.context?.requestId ?? request.id,
          retryable: false,
        });
      return;
    }

    // Fastify's own errors (rate-limit, cookie/body parsing, etc.) carry a
    // statusCode; anything else is treated as an unexpected 500. Either
    // way, the client never sees the raw error message/stack — only a
    // safe, generic one — while the real error is logged server-side
    // keyed by requestId for correlation. `err` is typed `unknown` by
    // Fastify 5's error-handler signature, so both fields are read via
    // explicit guards rather than assumed to exist.
    const hasStatusCode = (e: unknown): e is { statusCode: number } =>
      typeof e === "object" && e !== null && "statusCode" in e && typeof (e as { statusCode: unknown }).statusCode === "number";
    const status = hasStatusCode(err) ? err.statusCode : 500;
    const rawMessage = err instanceof Error ? err.message : "Unknown error";
    const requestId = request.context?.requestId ?? request.id;
    request.log.error({ err, requestId }, "unhandled error");

    reply
      .code(status)
      .type("application/problem+json")
      .send({
        code: status === 429 ? "rate_limited" : status < 500 ? "bad_request" : "internal_error",
        message: status < 500 ? rawMessage : "An unexpected error occurred.",
        requestId,
        retryable: status >= 500 || status === 429,
      });
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .type("application/problem+json")
      .send({
        code: "not_found",
        message: `No route matches ${request.method} ${request.url}`,
        requestId: request.context?.requestId ?? request.id,
        retryable: false,
      });
  });

  // Routes register AFTER the error/not-found handlers above — see the
  // comment on setErrorHandler for why the order is load-bearing.
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(organizationRoutes);
  await app.register(membershipRoutes);
  await app.register(auditRoutes);
  await app.register(meRoutes);
  // ---- earlier: P13 RFQ + P14 Deal Room ----
  await app.register(opportunityRoutes);
  await app.register(capacityRoutes);
  await app.register(rfqRoutes);
  await app.register(dealRoutes);
  // ---- earlier: Lockbox ----
  await app.register(lockboxRoutes);
  // ---- earlier: Attribution ----
  await app.register(claimRoutes);
  // ---- earlier: Passport (P6) + Marketplace (P5) ----
  await app.register(passportRoutes);
  await app.register(marketplaceRoutes);
  // ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
  await app.register(matchingRoutes);
  // ---- earlier: Economics (P15) ----
  await app.register(economicsRoutes);

  return app;
}
