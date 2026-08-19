// apps/api/src/modules/matching/routes.ts
//
// the spec/p.20 (P11/P12 gates). Two routes, nested under an
// opportunity (the spec's own route: /app/matches/[opportunityId]):
// evaluate (POST) is wrapped in withIdempotency — a retried network call
// must not create a second batch of MatchResult rows for what's
// semantically the same evaluation request, same reasoning as claim.create.
// list (GET) is read-only, no idempotency layer needed.

import type { FastifyPluginAsync } from "fastify";
import { EvaluateMatchesRequestSchema, type EvaluateMatchesResponse, type ListMatchesResponse } from "@tol/contracts";
import { prisma } from "@tol/db";
import { matchingService } from "./service.js";
import { toMatchResultDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const matchingRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { opportunityId: string } }>(
    "/opportunities/:opportunityId/matches/evaluate",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      // Body is entirely optional (EvaluateMatchesRequestSchema — see
      // that schema's own comment) — a bareword POST with no body is the
      // common case, so `request.body` is coalesced to `{}` before
      // parsing rather than requiring an empty-object payload from every
      // real caller.
      const parsed = EvaluateMatchesRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid match evaluation request.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const body = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "matching.evaluate",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<EvaluateMatchesResponse> => {
          const rows = await matchingService.evaluate(request.actor!, request.params.opportunityId, parsed.data, request.context);
          return { matches: rows.map(toMatchResultDTO) };
        },
      );

      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/matches", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const rows = await matchingService.list(request.actor!, request.params.opportunityId);
    const body: ListMatchesResponse = { matches: rows.map(toMatchResultDTO) };
    return reply.code(200).send(body);
  });
};

export default matchingRoutes;
