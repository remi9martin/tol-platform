// apps/api/tests/integration/auth.test.ts — login/session/logout/
// switch-org/CSRF, exercised through the real route surface.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, prisma } from "@tol/db";
import { buildTestApp, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

describe("auth: login / session / logout", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
    fixture = await createFixtureOrgWithUser({ orgLabel: "Delta", role: "MERCHANT_PSP_USER" });
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("rejects a wrong password with 401 and a generic message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: "definitely-wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Invalid email or password.");
  });

  it("rejects a nonexistent email with the SAME generic message (no user enumeration via error text)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody-at-all@example.test", password: "whatever" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Invalid email or password.");
  });

  it("rejects a malformed request body with 400 and field errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "not-an-email", password: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fieldErrors).toBeTruthy();
  });

  it("logs in successfully and sets an HttpOnly session cookie + a readable CSRF cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });
    expect(res.statusCode).toBe(200);

    const sessionCookie = res.cookies.find((c) => c.name === "tol_session");
    const csrfCookie = res.cookies.find((c) => c.name === "tol_csrf");
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(csrfCookie?.httpOnly).toBeFalsy();

    const body = res.json();
    expect(body.user.email).toBe(fixture.user.email);
    expect(body.activeOrganizationId).toBe(fixture.org.id);
    expect(body.activeRole).toBe("MERCHANT_PSP_USER");
  });

  it("GET /auth/session reflects the same actor a fresh request authenticates as", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });
    const cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));

    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json().activeOrganizationId).toBe(fixture.org.id);
  });

  it("logout revokes the session — the SAME cookie is rejected on the next request", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });
    const cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));
    const csrf = login.cookies.find((c) => c.name === "tol_csrf")?.value;

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "x-csrf-token": csrf ?? "" },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("password login rate limit kicks in after repeated failed attempts (the spec: stricter limit on auth)", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email: "rate-limit-probe@example.test", password: "wrong" },
        }),
      ),
    );
    const statuses = attempts.map((r) => r.statusCode);
    expect(statuses.some((s) => s === 429)).toBe(true);
  });
});

describe("auth: CSRF protection on cookie-authenticated mutations", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
    fixture = await createFixtureOrgWithUser({ orgLabel: "Echo", role: "PLATFORM_OWNER" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });
    cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));
    csrf = login.cookies.find((c) => c.name === "tol_csrf")?.value ?? "";
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("rejects a mutation with a valid session cookie but NO CSRF header", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/organizations/${fixture.org.id}`,
      headers: { cookie },
      payload: { displayName: "New Name" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("csrf_check_failed");
  });

  it("rejects a mutation with a CSRF header that doesn't match the cookie", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/organizations/${fixture.org.id}`,
      headers: { cookie, "x-csrf-token": "wrong-token-entirely" },
      payload: { displayName: "New Name" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts a mutation with a matching session cookie + CSRF header", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/organizations/${fixture.org.id}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { displayName: "Legitimately Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Legitimately Renamed");
  });

  it("GET requests never require a CSRF header (only mutations do)", async () => {
    const res = await app.inject({ method: "GET", url: `/organizations/${fixture.org.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });
});

describe("audit base: restricted actions leave a reconstructable trail", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
    fixture = await createFixtureOrgWithUser({ orgLabel: "Foxtrot", role: "PLATFORM_OWNER" });
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("logging in writes an auth.login AuditEvent naming the actor and subject org", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });

    const events = await prisma.auditEvent.findMany({
      where: { actorUserId: fixture.user.id, action: "auth.login" },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.subjectOrgId).toBe(fixture.org.id);
  });

  it("updating an organization writes an organization.updated event with before/after values", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });
    const cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));
    const csrf = login.cookies.find((c) => c.name === "tol_csrf")?.value ?? "";

    await app.inject({
      method: "PATCH",
      url: `/organizations/${fixture.org.id}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { displayName: "Audited Rename" },
    });

    const events = await prisma.auditEvent.findMany({
      where: { subjectOrgId: fixture.org.id, action: "organization.updated" },
      orderBy: { occurredAt: "desc" },
    });
    expect(events.length).toBeGreaterThan(0);
    const latest = events[0]!;
    expect((latest.afterValue as { displayName?: string })?.displayName).toBe("Audited Rename");
    expect(latest.actorUserId).toBe(fixture.user.id);
  });
});

describe("regression: real-browser request shapes .inject()/curl don't exercise by default", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  /**
   * Caught live during this stage browser testing, NOT by any prior
   * automated test: a CORS preflight OPTIONS request crashed with 500
   * ("Cannot read properties of null (reading 'requestId')") because
   * request.context is only populated by the request-context plugin's
   * onRequest hook, and @fastify/cors short-circuits OPTIONS requests
   * before that hook runs. curl and .inject() calls in every other test
   * in this suite only ever send the real method directly (GET/POST/
   * PATCH), never an OPTIONS preflight — a real browser sends one
   * automatically before every cross-origin mutating request, so this
   * was a silent, total login/mutation outage that no prior test caught.
   */
  it("a CORS preflight OPTIONS request against a real route succeeds (not the 500 this used to be)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: {
        origin: "http://localhost:18300",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBeTruthy();
  });

  it("OPTIONS preflight against an authenticated route also succeeds pre-auth (CORS runs before the auth gate)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/organizations/00000000-0000-7000-8000-000000000000",
      headers: {
        origin: "http://localhost:18300",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,x-csrf-token",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
  });

  /**
   * Caught in the same browser session: apps/web's API client sent
   * `Content-Type: application/json` on every request unconditionally,
   * including bodyless ones (logout). Fastify's default JSON body parser
   * correctly rejects a JSON content-type with zero bytes of body
   * (FST_ERR_CTP_EMPTY_JSON_BODY) — sign-out failed with a 400 in the
   * real browser. This test pins the server-side contract: logout must
   * keep accepting a genuinely bodyless POST (apps/web was fixed to stop
   * sending the header when there's no body; this guards the other side
   * of that contract so a future client mistake fails here, in a fast
   * unit test, instead of silently in production).
   */
  it("POST /auth/logout accepts a request with no body and no Content-Type header", async () => {
    const fixture = await createFixtureOrgWithUser({ orgLabel: "Hotel", role: "MERCHANT_PSP_USER" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: fixture.user.email, password: fixture.user.password },
    });
    const cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));
    const csrf = login.cookies.find((c) => c.name === "tol_csrf")?.value ?? "";

    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "x-csrf-token": csrf }, // deliberately no content-type, no payload
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("B (a later clean-window fix): session revocation — a suspended/revoked membership on a still-valid session is denied on its next request", () => {
  // Pre-fix, apps/api/src/plugins/auth.ts built request.actor from
  // session.activeMembership.organizationId/role with NO status check —
  // a membership SUSPENDED or REVOKED hours into an otherwise-still-valid
  // session kept granting its org/role on every subsequent request,
  // since nothing here ever re-checked it. sessionRepository.
  // revokeAllForUser also had ZERO call sites — suspending/revoking a
  // membership did nothing to the user's actual session rows either.
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("PRIMARY PROOF (real API path): suspending a membership via PATCH /memberships/:id/status revokes the target's live session — the SAME cookie that worked a moment ago is denied (401) on its very next request, both for /auth/session and for a real protected action", async () => {
    const admin = await createFixtureOrgWithUser({ orgLabel: "RevokeAdmin", role: "PLATFORM_OWNER" });
    const target = await createFixtureOrgWithUser({ orgLabel: "RevokeTarget", role: "MERCHANT_PSP_USER" });

    const targetLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: target.user.email, password: target.user.password },
    });
    expect(targetLogin.statusCode).toBe(200);
    const targetCookie = extractCookieHeader(targetLogin.cookies.map((c) => `${c.name}=${c.value}`));

    // BASELINE: the session genuinely grants org/role access before the
    // suspension — proves this isn't "always denied" masquerading as a fix.
    const before = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: targetCookie } });
    expect(before.statusCode).toBe(200);
    expect(before.json().activeOrganizationId).toBe(target.org.id);
    const beforeAction = await app.inject({
      method: "GET",
      url: `/organizations/${target.org.id}/memberships`,
      headers: { cookie: targetCookie },
    });
    expect(beforeAction.statusCode).toBe(200);

    const adminLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: admin.user.email, password: admin.user.password },
    });
    const adminCookie = extractCookieHeader(adminLogin.cookies.map((c) => `${c.name}=${c.value}`));
    const adminCsrf = adminLogin.cookies.find((c) => c.name === "tol_csrf")?.value ?? "";

    // PLATFORM_OWNER's membership.update_status grant is cross-org
    // (packages/authz/src/matrix.ts crossOrgActions) — suspends a
    // DIFFERENT org's membership, the real shape a compliance/admin
    // action takes.
    const suspend = await app.inject({
      method: "PATCH",
      url: `/memberships/${target.membershipId}/status`,
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { status: "SUSPENDED" },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().status).toBe("SUSPENDED");

    // THE PROOF: the SAME target cookie, never re-issued, on its very
    // next request — denied. sessionRepository.revokeAllForUser now has
    // a real call site (memberships/service.ts's updateStatus), so the
    // session itself is revoked, not merely stripped of org context.
    const after = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: targetCookie } });
    expect(after.statusCode).toBe(401);
    const afterAction = await app.inject({
      method: "GET",
      url: `/organizations/${target.org.id}/memberships`,
      headers: { cookie: targetCookie },
    });
    expect(afterAction.statusCode).toBe(401);
  });

  it("DEFENSE-IN-DEPTH (isolates auth.ts's own read-time guard): even if a membership's status changes through a path that does NOT call revokeAllForUser, the fail-closed status check in auth.ts alone still denies org/role access on the next request", async () => {
    const target = await createFixtureOrgWithUser({ orgLabel: "DirectRevokeTarget", role: "MERCHANT_PSP_USER" });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: target.user.email, password: target.user.password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));

    const before = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(before.json().activeOrganizationId).toBe(target.org.id);
    expect(before.json().activeRole).toBe("MERCHANT_PSP_USER");

    // Deliberately bypasses membershipsService.updateStatus (and
    // therefore revokeAllForUser) entirely — a direct DB write,
    // simulating any OTHER code path that might change a membership's
    // status without remembering to revoke sessions. Isolates whether
    // auth.ts's OWN status check is a genuine, independent backstop, not
    // just a passthrough that happens to work because the one known
    // call site also revokes.
    await prisma.organizationMembership.update({
      where: { id: target.membershipId },
      data: { status: "SUSPENDED" },
    });

    // The session itself was never revoked (revokedAt still null) — the
    // request is still authenticated (200, not 401) — but auth.ts's own
    // status check must still refuse to grant the org/role from a
    // non-ACTIVE membership, exactly like a null activeMembership.
    const after = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(after.statusCode).toBe(200);
    expect(after.json().activeOrganizationId).toBeNull();
    expect(after.json().activeRole).toBeNull();
    expect(after.json().activeMembershipId).toBeNull();

    // Real protected action, not just the reflected session field.
    const action = await app.inject({
      method: "GET",
      url: `/organizations/${target.org.id}/memberships`,
      headers: { cookie },
    });
    expect(action.statusCode).toBe(403);
  });
});
