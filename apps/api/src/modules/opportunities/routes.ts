import type { FastifyPluginAsync } from "fastify";
import { CreateOpportunityRequestSchema, ReplaceVolumeSlicesRequestSchema, type ListOpportunitiesResponse, type VolumeSlicesResponse } from "@tol/contracts";
import { opportunitiesService } from "./service.js";
import { toOpportunityDTO, toVolumeReconciliationDTO, toVolumeSliceDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";
import { prisma } from "@tol/db";

const opportunityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/opportunities", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const opportunities = await opportunitiesService.list(request.actor!);
    const body: ListOpportunitiesResponse = { opportunities: opportunities.map(toOpportunityDTO) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>(
    "/opportunities/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const opportunity = await opportunitiesService.getById(request.actor!, request.params.id);
      return reply.code(200).send(toOpportunityDTO(opportunity));
    },
  );

  // the spec: Idempotency-Key — a retried create must not create two
  // Opportunity rows for the same logical submission.
  app.post("/opportunities", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = CreateOpportunityRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid opportunity creation request.", zodFieldErrors(parsed.error.issues));
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const dto = await withIdempotency(
      prisma,
      {
        key: idempotencyKey,
        scope: "opportunity.create",
        method: request.method,
        path: request.url,
        body: request.body,
        organizationId: request.actor!.organizationId,
        userId: request.actor!.userId,
      },
      async () => {
        const created = await opportunitiesService.create(request.actor!, parsed.data, request.context);
        return toOpportunityDTO(created);
      },
    );

    return reply.code(201).send(dto);
  });

  // ---- earlier: P7 VolumeSlice + volume reconciliation ----

  app.get<{ Params: { id: string } }>(
    "/opportunities/:id/volume-slices",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const { slices, reconciliation } = await opportunitiesService.getVolumeSlices(request.actor!, request.params.id);
      const body: VolumeSlicesResponse = { slices: slices.map(toVolumeSliceDTO), reconciliation: toVolumeReconciliationDTO(reconciliation) };
      return reply.code(200).send(body);
    },
  );

  // the spec: Idempotency-Key — a retried replace must not apply the
  // same delete-all-then-recreate twice (the second application would
  // be a harmless no-op given identical input, but a DIFFERENT retried
  // body under the same key is exactly what withIdempotency's
  // requestHash check exists to catch).
  app.put<{ Params: { id: string } }>(
    "/opportunities/:id/volume-slices",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = ReplaceVolumeSlicesRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid volume-slice replacement request.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "opportunity.replace_volume_slices",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<VolumeSlicesResponse> => {
          const { slices, reconciliation } = await opportunitiesService.replaceVolumeSlices(request.actor!, request.params.id, parsed.data, request.context);
          return { slices: slices.map(toVolumeSliceDTO), reconciliation: toVolumeReconciliationDTO(reconciliation) };
        },
      );

      return reply.code(200).send(dto);
    },
  );
};

export default opportunityRoutes;
