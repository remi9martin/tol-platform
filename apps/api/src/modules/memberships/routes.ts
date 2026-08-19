import type { FastifyPluginAsync } from "fastify";
import {
  CreateMembershipRequestSchema,
  UpdateMembershipRoleRequestSchema,
  UpdateMembershipStatusRequestSchema,
  type ListMembershipsResponse,
} from "@tol/contracts";
import { prisma } from "@tol/db";
import { membershipsService } from "./service.js";
import { toMembershipDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const membershipRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    "/organizations/:id/memberships",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const memberships = await membershipsService.list(request.actor!, request.params.id);
      const body: ListMembershipsResponse = { memberships: memberships.map(toMembershipDTO) };
      return reply.code(200).send(body);
    },
  );

  // the spec: "All mutation endpoints support Idempotency-Key when
  // duplicate network retries could create a second record or
  // transition" — invite creation is exactly that case (a retried POST
  // must not create two membership rows for the same invite).
  app.post<{ Params: { id: string } }>(
    "/organizations/:id/memberships",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = CreateMembershipRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid membership creation request.", zodFieldErrors(parsed.error.issues));
      }

      // Cache the DTO (JSON-serializable: dates already ISO strings), not
      // the raw Prisma entity — a real bug caught by
      // memberships.test.ts's idempotency-replay case during this stage: the
      // raw entity's Date fields round-trip through the Json column as
      // strings on replay, and toMembershipDTO() calling .toISOString()
      // on an already-string value threw, turning a replayed (should be
      // 201) response into an unhandled 500. Caching the exact response
      // body IS the more correct design anyway — idempotency replays what
      // was SENT, not an intermediate domain object.
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "membership.create",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async () => {
          const membership = await membershipsService.create(
            request.actor!,
            request.params.id,
            parsed.data,
            request.context,
          );
          return toMembershipDTO(membership);
        },
      );

      return reply.code(201).send(dto);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/memberships/:id/status",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = UpdateMembershipStatusRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid status update request.", zodFieldErrors(parsed.error.issues));
      }
      const updated = await membershipsService.updateStatus(
        request.actor!,
        request.params.id,
        parsed.data.status,
        request.context,
      );
      return reply.code(200).send(toMembershipDTO(updated));
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/memberships/:id/role",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = UpdateMembershipRoleRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid role update request.", zodFieldErrors(parsed.error.issues));
      }
      const updated = await membershipsService.updateRole(
        request.actor!,
        request.params.id,
        parsed.data.role,
        request.context,
      );
      return reply.code(200).send(toMembershipDTO(updated));
    },
  );
};

export default membershipRoutes;
