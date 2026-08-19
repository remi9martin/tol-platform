// apps/api/src/modules/auth/routes.ts — validates request/response DTOs,
// resolves actor context, calls one application service, serializes the
// result (the spec's route-handler contract). All session/CSRF cookie
// construction happens here (an HTTP concern), never in the service.

import type { FastifyPluginAsync } from "fastify";
import { LoginRequestSchema, SwitchOrgRequestSchema, type SessionResponse } from "@tol/contracts";
import { authService } from "./service.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { CSRF_COOKIE, SESSION_COOKIE, generateCsrfToken } from "../../shared/session.js";
import type { MembershipWithOrganization } from "@tol/db";

function toSessionResponse(
  userId: string,
  email: string,
  memberships: MembershipWithOrganization[],
  activeMembershipId: string | null,
): SessionResponse {
  const active = memberships.find((m) => m.id === activeMembershipId) ?? null;
  return {
    user: { id: userId, email },
    activeMembershipId: active?.id ?? null,
    activeOrganizationId: active?.organizationId ?? null,
    activeRole: active?.role ?? null,
    memberships: memberships.map((m) => ({
      membershipId: m.id,
      organizationId: m.organizationId,
      organizationDisplayName: m.organization.displayName,
      role: m.role,
      status: m.status,
    })),
  };
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = LoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid login request.", zodFieldErrors(parsed.error.issues));
      }

      const result = await authService.login(parsed.data.email, parsed.data.password, request.context);

      const csrfToken = generateCsrfToken();
      reply.setCookie(SESSION_COOKIE.name, result.rawToken, SESSION_COOKIE.options(app.isProduction));
      reply.setCookie(CSRF_COOKIE.name, csrfToken, CSRF_COOKIE.options(app.isProduction));

      const body = toSessionResponse(
        result.user.id,
        result.user.email,
        result.memberships,
        result.activeMembership?.id ?? null,
      );
      return reply.code(200).send(body);
    },
  );

  app.post("/auth/logout", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    await authService.logout(request.sessionId!, request.authUser!.id, request.context);
    reply.clearCookie(SESSION_COOKIE.name, { path: "/" });
    reply.clearCookie(CSRF_COOKIE.name, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/auth/session", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const memberships = await authService.getMemberships(request.authUser!.id);
    const body = toSessionResponse(
      request.authUser!.id,
      request.authUser!.email,
      memberships,
      request.actor?.membershipId ?? null,
    );
    return reply.code(200).send(body);
  });

  app.post("/auth/switch-org", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = SwitchOrgRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid switch-org request.", zodFieldErrors(parsed.error.issues));
    }

    await authService.switchOrg(
      request.authUser!.id,
      request.sessionId!,
      parsed.data.organizationId,
      request.context,
    );

    const memberships = await authService.getMemberships(request.authUser!.id);
    const active = memberships.find((m) => m.organizationId === parsed.data.organizationId);
    const body = toSessionResponse(request.authUser!.id, request.authUser!.email, memberships, active?.id ?? null);
    return reply.code(200).send(body);
  });
};

export default authRoutes;
