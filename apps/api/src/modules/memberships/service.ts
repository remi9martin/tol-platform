// apps/api/src/modules/memberships/service.ts

import { can, type Actor, type PersonaRole } from "@tol/authz";
import {
  membershipRepository,
  organizationRepository,
  prisma,
  Prisma,
  sessionRepository,
  type OrganizationMembership,
} from "@tol/db";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

/**
 * Two concurrent requests that both read "no row exists yet" for the
 * same (organizationId, userId, role) tuple and both attempt to create
 * one will have exactly one of them win — the DB's own
 * @@unique([organizationId, userId, role]) constraint (packages/db
 * schema.prisma) is what actually prevents a duplicate, since the
 * find-then-create check in create()/updateRole() below isn't atomic
 * with the write. Without this wrapper, the LOSING request's raw Prisma
 * P2002 error would surface as an unhandled 500 instead of a clean,
 * understood 409 — flagged by review (apps-api-core block,
 * 2026-08-18); the constraint itself already made this data-safe, this
 * closes the error-response gap on top of that.
 */
async function runUniqueConstraintSafe<T>(fn: () => Promise<T>, conflictMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ProblemError.conflict(conflictMessage, true);
    }
    throw err;
  }
}

export const membershipsService = {
  /**
   * Listing is always scoped to ONE organization (route is
   * /organizations/:id/memberships) — unlike organizationsService.list(),
   * there's no separate "list across all orgs" case to special-case here.
   * can() already decides whether this actor may see this org's
   * memberships at all (same-org role, or one of the matrix's cross-org
   * grants); the repository call itself is unconditional once that gate
   * passes.
   */
  async list(actor: Actor, organizationId: string): Promise<OrganizationMembership[]> {
    const decision = can(actor, "membership.list", { type: "membership", ownerOrgId: organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);
    return membershipRepository.listByOrganization(prisma, organizationId);
  },

  async create(
    actor: Actor,
    organizationId: string,
    input: { userId: string; role: PersonaRole; invitationSource?: string },
    context: RequestContext,
  ): Promise<OrganizationMembership> {
    const decision = can(actor, "membership.create", { type: "membership", ownerOrgId: organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const org = await organizationRepository.findById(prisma, organizationId);
    if (!org) throw ProblemError.notFound("Organization not found.");

    return runUniqueConstraintSafe(() => withTransaction(async (tx) => {
      const existing = await membershipRepository.findByUserOrgRole(tx, input.userId, organizationId, input.role);

      let membership: OrganizationMembership;
      let action: string;

      if (existing && existing.status === "REVOKED") {
        membership = await membershipRepository.reactivate(tx, existing.id, {
          status: "INVITED",
          invitationSource: input.invitationSource ?? null,
          updatedByUserId: actor.userId,
        });
        action = "membership.reactivated";
      } else if (existing) {
        throw ProblemError.conflict(
          `A membership already exists for this user/role in this organization (status: ${existing.status}).`,
        );
      } else {
        membership = await membershipRepository.create(tx, {
          organizationId,
          userId: input.userId,
          role: input.role,
          status: "INVITED",
          invitationSource: input.invitationSource ?? null,
          createdByUserId: actor.userId,
          createdByOrgId: actor.organizationId,
        });
        action = "membership.created";
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: organizationId,
        action,
        resourceType: "membership",
        resourceId: membership.id,
        afterValue: { role: membership.role, status: membership.status, userId: membership.userId },
      });

      return membership;
    }), `A membership already exists for this user/role in this organization (created concurrently).`);
  },

  async updateStatus(
    actor: Actor,
    membershipId: string,
    status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "INVITED",
    context: RequestContext,
  ): Promise<OrganizationMembership> {
    const existing = await membershipRepository.findById(prisma, membershipId);
    if (!existing) throw ProblemError.notFound("Membership not found.");

    const decision = can(actor, "membership.update_status", {
      type: "membership",
      id: existing.id,
      ownerOrgId: existing.organizationId,
    });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return withTransaction(async (tx) => {
      const updated = await membershipRepository.updateStatus(tx, membershipId, status, actor.userId);

      // BLOCKER fix (concurrency-audit clean-window pass, a later):
      // sessionRepository.revokeAllForUser existed with zero call sites
      // — a suspended/revoked membership alone did nothing to the
      // user's actual session rows. auth.ts's own fix (this same pass)
      // already makes a non-ACTIVE membership fail closed on its very
      // next request regardless of whether this runs, but leaving the
      // session otherwise "valid" (not expired, not revoked) for a
      // membership that no longer grants anything is stale hygiene at
      // best — revoking here forces a clean re-login, which re-resolves
      // the user's CURRENT memberships fresh (authService.login already
      // picks `status === "ACTIVE"` only). Any transition that does NOT
      // land on ACTIVE revokes (not just SUSPENDED/REVOKED specifically —
      // this endpoint's `status` param accepts all 4 enum values with no
      // transition-machine guard anywhere in this codebase, so a caller
      // could equally move an ACTIVE membership straight to INVITED;
      // caught in review, a real finding,
      // fixed here). Scoped to every session, not just this one org's —
      // this endpoint has no membership-scoped revoke to target more
      // narrowly, and forcing a fresh login whenever a membership stops
      // being ACTIVE is the safe default (costs a re-login, never a
      // security hole).
      if (status !== "ACTIVE") {
        await sessionRepository.revokeAllForUser(tx, existing.userId);
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: existing.organizationId,
        action: "membership.status_changed",
        resourceType: "membership",
        resourceId: membershipId,
        beforeValue: { status: existing.status },
        afterValue: { status: updated.status },
        reason: `status: ${existing.status} -> ${status}`,
      });
      return updated;
    });
  },

  /**
   * Role change = revoke the old (org, user, role) row + create-or-
   * reactivate the new one, inside one transaction — never an in-place
   * role mutation, so a membership's role history stays reconstructable
   * (the spec AUTHORITY INVARIANT: prior value, new value, and who/why
   * must be persisted for any authority change).
   */
  async updateRole(
    actor: Actor,
    membershipId: string,
    newRole: PersonaRole,
    context: RequestContext,
  ): Promise<OrganizationMembership> {
    const existing = await membershipRepository.findById(prisma, membershipId);
    if (!existing) throw ProblemError.notFound("Membership not found.");

    const decision = can(actor, "membership.update_role", {
      type: "membership",
      id: existing.id,
      ownerOrgId: existing.organizationId,
    });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (existing.role === newRole) {
      throw ProblemError.badRequest("New role is the same as the current role.");
    }

    return runUniqueConstraintSafe(() => withTransaction(async (tx) => {
      await membershipRepository.updateStatus(tx, existing.id, "REVOKED", actor.userId);

      // BLOCKER fix (concurrency-audit clean-window pass, a later):
      // same reasoning as updateStatus() above. Any session whose
      // activeMembershipId still points at THIS now-REVOKED row would,
      // per auth.ts's own fix, correctly lose org/role access on its
      // next request — but it would NOT automatically pick up the new
      // role either (activeMembershipId doesn't repoint itself), so
      // without this it would just go inert for that org until the user
      // figures out to log out/in. Revoking forces a clean re-login,
      // which re-resolves the user's active membership fresh and lands
      // them on the new role immediately, matching "role-changed" in
      // the brief's own named revoke-trigger list (revoked/suspended/
      // role-changed) — every role change, not just downgrades, since
      // this service has no role-hierarchy concept to distinguish them.
      await sessionRepository.revokeAllForUser(tx, existing.userId);

      const priorAtNewRole = await membershipRepository.findByUserOrgRole(
        tx,
        existing.userId,
        existing.organizationId,
        newRole,
      );

      const next =
        priorAtNewRole && priorAtNewRole.status === "REVOKED"
          ? await membershipRepository.reactivate(tx, priorAtNewRole.id, {
              status: "ACTIVE",
              invitationSource: `role-change-from:${existing.id}`,
              updatedByUserId: actor.userId,
            })
          : await membershipRepository.create(tx, {
              organizationId: existing.organizationId,
              userId: existing.userId,
              role: newRole,
              status: "ACTIVE",
              invitationSource: `role-change-from:${existing.id}`,
              createdByUserId: actor.userId,
              createdByOrgId: actor.organizationId,
            });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: existing.organizationId,
        action: "membership.role_changed",
        resourceType: "membership",
        resourceId: next.id,
        beforeValue: { role: existing.role, membershipId: existing.id },
        afterValue: { role: next.role, membershipId: next.id },
        reason: `role: ${existing.role} -> ${newRole}`,
      });

      return next;
    }), `A membership already exists at role "${newRole}" for this user in this organization (created concurrently).`);
  },
};
