import type { FastifyPluginAsync } from "fastify";
import { UpdateOrganizationRequestSchema, type ListOrganizationsResponse } from "@tol/contracts";
import { organizationsService } from "./service.js";
import { toOrganizationDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";

const organizationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/organizations", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const orgs = await organizationsService.list(request.actor!);
    const body: ListOrganizationsResponse = { organizations: orgs.map((o) => toOrganizationDTO(request.actor!, o)) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>(
    "/organizations/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const org = await organizationsService.getById(request.actor!, request.params.id);
      return reply.code(200).send(toOrganizationDTO(request.actor!, org));
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/organizations/:id",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = UpdateOrganizationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid organization update request.", zodFieldErrors(parsed.error.issues));
      }
      const updated = await organizationsService.update(
        request.actor!,
        request.params.id,
        parsed.data,
        request.context,
      );
      return reply.code(200).send(toOrganizationDTO(request.actor!, updated));
    },
  );
};

export default organizationRoutes;
