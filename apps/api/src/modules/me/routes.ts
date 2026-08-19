// apps/api/src/modules/me/routes.ts — the actor's own Person profile.
// Deliberately narrow (read-only, self-only) for earlier: it exists to
// exercise person.read + the isSelf path through can() via a real HTTP
// route, not to be a full Person CRUD surface (that's earlier+ once
// Passport/relationship-contact concepts land and there's an actual
// UI need to edit contact channels).

import type { FastifyPluginAsync } from "fastify";
import { can } from "@tol/authz";
import { personRepository, prisma } from "@tol/db";
import { ProblemError } from "../../shared/errors.js";

const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me/person", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const person = await personRepository.findByUserId(prisma, request.authUser!.id);
    if (!person) {
      throw ProblemError.notFound("No Person profile exists for this account yet.");
    }

    const decision = can(
      request.actor!,
      "person.read",
      { type: "person", id: person.id, ownerOrgId: person.organizationId },
      { isSelf: true },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return reply.code(200).send({
      id: person.id,
      name: person.name,
      title: person.title,
      organizationId: person.organizationId,
      contactChannels: person.contactChannels,
      verificationStatus: person.verificationStatus,
    });
  });
};

export default meRoutes;
