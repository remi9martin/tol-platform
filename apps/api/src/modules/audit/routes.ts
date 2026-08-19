// apps/api/src/modules/audit/routes.ts — read path for the earlier audit
// base. Gated on authz's "audit.read" action, which per matrix.ts is
// cross-org for PLATFORM_OWNER/MARKETPLACE_OPERATOR/COMPLIANCE_REVIEWER/
// AUDITOR_READONLY and same-org-only for everyone else — this is the
// route-level half of P16's "restricted actions reconstructable" gate;
// the write half lives in shared/audit.ts and every service that calls it.

import type { FastifyPluginAsync } from "fastify";
import { can } from "@tol/authz";
import { auditRepository, prisma } from "@tol/db";
import type { AuditEventDTO, ListAuditEventsResponse } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";

const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    "/organizations/:id/audit",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const organizationId = request.params.id;
      const decision = can(request.actor!, "audit.read", { type: "audit_event", ownerOrgId: organizationId });
      if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

      const events = await auditRepository.listBySubjectOrg(prisma, organizationId);
      const body: ListAuditEventsResponse = {
        events: events.map(
          (e): AuditEventDTO => ({
            id: e.id,
            occurredAt: e.occurredAt.toISOString(),
            actorUserId: e.actorUserId,
            actorOrgId: e.actorOrgId,
            actorRole: e.actorRole,
            subjectOrgId: e.subjectOrgId,
            action: e.action,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            reason: e.reason,
          }),
        ),
      };
      return reply.code(200).send(body);
    },
  );
};

export default auditRoutes;
