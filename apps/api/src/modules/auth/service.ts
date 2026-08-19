// apps/api/src/modules/auth/service.ts
//
// the spec auth requirements (session cookies, MFA flag surfaced for
// operator/admin roles) implemented against seeded users per
// ADR-0007 — email+password is the real, complete login
// mechanism; magic-link/Google OAuth are explicitly deferred, not
// silently dropped (see D7's own text for why: both need external
// provider setup — a real mailer, a real Google OAuth app — that isn't
// available to configure this pass).

import {
  membershipRepository,
  prisma,
  sessionRepository,
  userRepository,
  verifyPassword,
  type MembershipWithOrganization,
  type Session,
  type User,
} from "@tol/db";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter, type AuditWriter } from "../../shared/audit.js";
import { generateSessionToken, hashSessionToken, sessionExpiryFromNow } from "../../shared/session.js";
import type { RequestContext } from "../../shared/request-context.js";

export interface LoginResult {
  user: User;
  session: Session;
  rawToken: string;
  memberships: MembershipWithOrganization[];
  activeMembership: MembershipWithOrganization | null;
}

// Identical message on "no such user" and "wrong password" — deliberately
// avoids letting an attacker distinguish "this email doesn't exist" from
// "this email exists but the password was wrong" (a standard
// user-enumeration mitigation).
const INVALID_CREDENTIALS = "Invalid email or password.";

function buildAuditWriter(context: RequestContext): AuditWriter {
  return auditWriter(context);
}

export const authService = {
  async login(
    email: string,
    password: string,
    context: RequestContext,
  ): Promise<LoginResult> {
    const user = await userRepository.findByEmail(prisma, email);
    if (!user) {
      // Run a hash comparison anyway against a fixed dummy hash so the
      // response-time profile for "no such user" and "wrong password"
      // stays close — a real (if partial) timing-based enumeration
      // mitigation, cheap to include.
      await verifyPassword(password, "$2b$12$C6UzMDM.H6dfI/f/IKcEeO7uw.qzwsF.jUiVtHhkS0.wS8sGjF3ny");
      throw ProblemError.unauthorized(INVALID_CREDENTIALS);
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk) {
      throw ProblemError.unauthorized(INVALID_CREDENTIALS);
    }

    if (user.status !== "ACTIVE") {
      throw ProblemError.unauthorized("This account is not active. Contact your organization administrator.");
    }

    const memberships = await membershipRepository.listByUser(prisma, user.id);
    const activeMembership = memberships.find((m) => m.status === "ACTIVE") ?? null;

    const rawToken = generateSessionToken();
    const session = await sessionRepository.create(prisma, {
      userId: user.id,
      tokenHash: hashSessionToken(rawToken),
      activeMembershipId: activeMembership?.id ?? null,
      expiresAt: sessionExpiryFromNow(),
      ipClass: context.ipClass,
      userAgentClass: context.userAgentClass,
    });

    await userRepository.recordLogin(prisma, user.id);

    await buildAuditWriter(context).write(prisma, {
      actorUserId: user.id,
      actorOrgId: activeMembership?.organizationId ?? null,
      actorRole: activeMembership?.role ?? null,
      subjectOrgId: activeMembership?.organizationId ?? null,
      action: "auth.login",
      resourceType: "user",
      resourceId: user.id,
    });

    return { user, session, rawToken, memberships, activeMembership };
  },

  async logout(sessionId: string, userId: string, context: RequestContext): Promise<void> {
    await sessionRepository.revoke(prisma, sessionId);
    await buildAuditWriter(context).write(prisma, {
      actorUserId: userId,
      actorOrgId: null,
      actorRole: null,
      subjectOrgId: null,
      action: "auth.logout",
      resourceType: "user",
      resourceId: userId,
    });
  },

  async getMemberships(userId: string): Promise<MembershipWithOrganization[]> {
    return membershipRepository.listByUser(prisma, userId);
  },

  async switchOrg(
    userId: string,
    sessionId: string,
    organizationId: string,
    context: RequestContext,
  ): Promise<MembershipWithOrganization> {
    const membership = await membershipRepository.findActiveByUserAndOrg(prisma, userId, organizationId);
    if (!membership) {
      throw ProblemError.forbidden("You do not have an active membership in that organization.");
    }

    await sessionRepository.updateActiveMembership(prisma, sessionId, membership.id);

    await buildAuditWriter(context).write(prisma, {
      actorUserId: userId,
      actorOrgId: organizationId,
      actorRole: membership.role,
      subjectOrgId: organizationId,
      action: "auth.switch_org",
      resourceType: "user",
      resourceId: userId,
    });

    // findActiveByUserAndOrg doesn't include the `organization` relation
    // (it's the hot-path tenant-isolation check, kept minimal); re-fetch
    // via listByUser (which does) to return the shape the route needs.
    const memberships = await membershipRepository.listByUser(prisma, userId);
    const full = memberships.find((m) => m.id === membership.id);
    if (!full) {
      throw ProblemError.internal("Membership vanished between lookup and refetch — this should be unreachable.");
    }
    return full;
  },
};
