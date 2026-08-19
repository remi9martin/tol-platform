// apps/api/src/modules/organizations/service.ts

import { can, type Actor } from "@tol/authz";
import { organizationRepository, prisma, type Organization } from "@tol/db";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import type { RequestContext } from "../../shared/request-context.js";
import type { UpdateOrganizationRequest } from "@tol/contracts";

export const organizationsService = {
  async getById(actor: Actor, id: string): Promise<Organization> {
    const org = await organizationRepository.findById(prisma, id);
    if (!org) throw ProblemError.notFound("Organization not found.");

    const decision = can(actor, "organization.read", { type: "organization", id: org.id, ownerOrgId: org.id });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return org;
  },

  /**
   * List returns the actor's own organizations, PLUS every organization
   * when the role has organization.list cross-org authority (matrix.ts:
   * PLATFORM_OWNER, MARKETPLACE_OPERATOR, COMPLIANCE_REVIEWER,
   * AUDITOR_READONLY). This is can() applied at collection scope, not a
   * bypass of it — every returned row still individually satisfies
   * can(actor, "organization.read", ...) for whoever's asking.
   */
  async list(actor: Actor): Promise<Organization[]> {
    const decision = can(actor, "organization.list", { type: "organization", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const crossOrg = actor.role !== null && ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"].includes(actor.role);
    if (crossOrg) {
      return organizationRepository.list(prisma);
    }
    const own = actor.organizationId ? await organizationRepository.findById(prisma, actor.organizationId) : null;
    return own ? [own] : [];
  },

  async update(
    actor: Actor,
    id: string,
    patch: UpdateOrganizationRequest,
    context: RequestContext,
  ): Promise<Organization> {
    const existing = await organizationRepository.findById(prisma, id);
    if (!existing) throw ProblemError.notFound("Organization not found.");

    const decision = can(actor, "organization.update", { type: "organization", id, ownerOrgId: id });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const updated = await organizationRepository.update(prisma, id, patch, actor.userId);

    // Explicit safe-field allowlist for before/after — never a raw
    // entity spread (see shared/audit.ts's "SAFE-FIELD DISCIPLINE" note).
    await auditWriter(context).write(prisma, {
      actorUserId: actor.userId,
      actorOrgId: actor.organizationId,
      actorRole: actor.role,
      subjectOrgId: id,
      action: "organization.updated",
      resourceType: "organization",
      resourceId: id,
      beforeValue: pickChangedFields(existing, patch),
      afterValue: pickChangedFields(updated, patch),
    });

    return updated;
  },
};

function pickChangedFields(org: Organization, patch: UpdateOrganizationRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof UpdateOrganizationRequest)[]) {
    out[key] = org[key];
  }
  return out;
}
