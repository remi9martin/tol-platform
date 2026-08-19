// apps/api/src/plugins/auth.ts
//
// The P4 gate's session half. Resolves the tol_session cookie into
// request.actor (the @tol/authz Actor shape) on every request, BEFORE
// any route handler runs — routes never touch the raw session token or
// query Session themselves. request.actor.organizationId/role come from
// Session.activeMembership (packages/db), never from a client-supplied
// header or query param, which is what makes tenant isolation
// unspoofable from the request side: an attacker can send whatever
// X-Organization-Id header they like, nothing here ever reads one.

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "@tol/authz";
import { sessionRepository, type User } from "@tol/db";
import { getConfig } from "@tol/config";
import { CSRF_COOKIE, SESSION_COOKIE, csrfTokensMatch, hashSessionToken } from "../shared/session.js";
import { ProblemError } from "../shared/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
    authUser: User | null;
    sessionId: string | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    isProduction: boolean;
  }
}

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("actor", null);
  app.decorateRequest("authUser", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (request) => {
    const rawToken = request.cookies[SESSION_COOKIE.name];
    if (!rawToken) return;

    const tokenHash = hashSessionToken(rawToken);
    const session = await sessionRepository.findByTokenHash(app.db, tokenHash);
    if (!session) return;
    if (session.revokedAt !== null) return;
    if (session.expiresAt.getTime() <= Date.now()) return;

    request.sessionId = session.id;
    request.authUser = session.user;

    // BLOCKER fix (concurrency-audit clean-window pass, a later):
    // this used to build request.actor from session.activeMembership
    // unconditionally, with no status check — a membership SUSPENDED or
    // REVOKED after the session was created (e.g. via
    // memberships/service.ts's updateStatus, hours or days into an
    // otherwise-still-valid session) kept granting its org/role on every
    // subsequent request, since nothing here ever re-checked it. Treat a
    // non-ACTIVE activeMembership exactly like a null one (the same
    // fail-closed shape a brand-new user with no membership at all
    // already gets, per @tol/authz's own Actor doc comment: "organizationId/
    // role are null when the actor has no active OrganizationMembership
    // selected for this session") — the session itself stays valid (the
    // user is still authenticated), but every org-scoped can() check
    // downstream now correctly has nothing to grant against.
    const membership =
      session.activeMembership && session.activeMembership.status === "ACTIVE" ? session.activeMembership : null;
    request.actor = {
      userId: session.user.id,
      organizationId: membership?.organizationId ?? null,
      role: (membership?.role as Actor["role"]) ?? null,
      membershipId: membership?.id ?? null,
    };

    // Fire-and-forget-ish, but awaited: keeps lastSeenAt honest for the
    // session-hygiene story (e.g. a future "log out my other devices"
    // screen) without adding a second round trip's worth of user-facing
    // latency in a separate request.
    await sessionRepository.touchLastSeen(app.db, session.id);
  });

  app.decorate("requireAuth", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.actor || !request.authUser) {
      throw ProblemError.unauthorized();
    }
  });

  // the spec: "CSRF protections apply to cookie-authenticated
  // mutations." Only applies when a session cookie is actually present
  // (i.e. this request is relying on cookie auth at all) — login itself
  // has no pre-existing session to protect and is correctly exempt by
  // this same condition, not a special-cased route list.
  app.decorate("requireCsrf", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const sessionCookiePresent = Boolean(request.cookies[SESSION_COOKIE.name]);
    if (!sessionCookiePresent) return;

    const cookieToken = request.cookies[CSRF_COOKIE.name];
    const headerToken = request.headers["x-csrf-token"] as string | undefined;
    if (!csrfTokensMatch(cookieToken, headerToken)) {
      throw new ProblemError({
        status: 403,
        code: "csrf_check_failed",
        message: "Missing or mismatched CSRF token for a cookie-authenticated mutation.",
      });
    }
  });

  // Exposed so route handlers can build response cookies with the right
  // secure flag without each importing @tol/config themselves.
  app.decorate("isProduction", getConfig().isProduction);
};

export default fp(authPlugin, { name: "auth", dependencies: ["db"] });
