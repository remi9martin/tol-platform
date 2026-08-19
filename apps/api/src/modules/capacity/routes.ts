import type { FastifyPluginAsync } from "fastify";
import { CreateCapacityProfileRequestSchema, type ListCapacityProfilesResponse } from "@tol/contracts";
import { capacityService } from "./service.js";
import { toCapacityProfileDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";
import { prisma } from "@tol/db";

const capacityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/capacity-profiles", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const results = await capacityService.list(request.actor!);
    const body: ListCapacityProfilesResponse = { capacityProfiles: results.map((r) => toCapacityProfileDTO(r.profile, r.freshnessClass)) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>(
    "/capacity-profiles/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const { profile, freshnessClass } = await capacityService.getById(request.actor!, request.params.id);
      return reply.code(200).send(toCapacityProfileDTO(profile, freshnessClass));
    },
  );

  app.post("/capacity-profiles", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = CreateCapacityProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid capacity profile creation request.", zodFieldErrors(parsed.error.issues));
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const dto = await withIdempotency(
      prisma,
      {
        key: idempotencyKey,
        scope: "capacity.create",
        method: request.method,
        path: request.url,
        body: request.body,
        organizationId: request.actor!.organizationId,
        userId: request.actor!.userId,
      },
      async () => {
        const { profile, freshnessClass } = await capacityService.create(request.actor!, parsed.data, request.context);
        return toCapacityProfileDTO(profile, freshnessClass);
      },
    );

    return reply.code(201).send(dto);
  });
};

export default capacityRoutes;
