// apps/api/tests/integration/tenant-isolation.test.ts
//
// THE P4 PROOF. the spec: "P4 Auth — Tenant isolation proven." Exit
// evidence per the spec (Day 1 row): "Two organizations sign in; role
// isolation tests pass." This file is that evidence: two REAL,
// independently-created organizations, two REAL sessions established
// through the actual /auth/login route (not a mocked actor), and proof
// that Org A's session cannot read Org B's private data through ANY
// apps/api route — plus the inverse (Org B cannot read Org A) and the
// positive control (each org CAN read its own data), so this isn't just
// "always returns 403" masquerading as a security boundary.
//
// Runs against the real docker-compose Postgres (see
// apps/api/tests/helpers/build-test-app.ts) via Fastify's `.inject()` —
// exercises the full route -> preHandler(auth) -> service -> authz.can()
// -> repository chain for real, no mocking of any layer in that chain.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma } from "@tol/db";
import { buildTestApp, createFixtureOrgWithUser, extractCookieHeader, extractCsrfToken } from "../helpers/build-test-app.js";

describe("P4 — tenant isolation (org A cannot read org B's private data)", () => {
  let app: FastifyInstance;
  let orgA: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let orgB: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let cookieA: string;
  let csrfA: string | undefined;
  let cookieB: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    orgA = await createFixtureOrgWithUser({ orgLabel: "Alpha", role: "MERCHANT_PSP_USER" });
    orgB = await createFixtureOrgWithUser({ orgLabel: "Bravo", role: "MERCHANT_PSP_USER" });

    const loginA = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: orgA.user.email, password: orgA.user.password },
    });
    expect(loginA.statusCode).toBe(200);
    cookieA = extractCookieHeader(loginA.cookies.map((c) => `${c.name}=${c.value}`));
    csrfA = loginA.cookies.find((c) => c.name === "tol_csrf")?.value;

    const loginB = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: orgB.user.email, password: orgB.user.password },
    });
    expect(loginB.statusCode).toBe(200);
    cookieB = extractCookieHeader(loginB.cookies.map((c) => `${c.name}=${c.value}`));
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("POSITIVE CONTROL: org A's session CAN read org A's own organization", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgA.org.id}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(orgA.org.id);
  });

  it("POSITIVE CONTROL: org B's session CAN read org B's own organization", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgB.org.id}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(orgB.org.id);
  });

  it("THE PROOF: org A's session CANNOT read org B's organization", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgB.org.id}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    expect(res.json().message).toMatch(/tenant isolation/i);
  });

  it("THE PROOF, inverse direction: org B's session CANNOT read org A's organization", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgA.org.id}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(403);
  });

  it("org A's session CANNOT list org B's memberships", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgB.org.id}/memberships`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(403);
  });

  it("org A's session CANNOT read org B's audit trail", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgB.org.id}/audit`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(403);
  });

  it("org A's session CANNOT mutate org B's organization (PATCH), even with a stolen org id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/organizations/${orgB.org.id}`,
      headers: { cookie: cookieA, "x-csrf-token": csrfA ?? "" },
      payload: { displayName: "Hijacked" },
    });
    expect(res.statusCode).toBe(403);

    // Confirm it genuinely didn't change — the 403 isn't just a response
    // shape while the write silently went through underneath.
    const check = await app.inject({
      method: "GET",
      url: `/organizations/${orgB.org.id}`,
      headers: { cookie: cookieB },
    });
    expect(check.json().displayName).toBe(orgB.org.displayName);
    expect(check.json().displayName).not.toBe("Hijacked");
  });

  it("an unauthenticated request (no cookie) is denied 401, not 403 — the two failure modes stay distinct", async () => {
    const res = await app.inject({ method: "GET", url: `/organizations/${orgA.org.id}` });
    expect(res.statusCode).toBe(401);
  });

  it("a request with a garbage/forged session cookie is treated as unauthenticated, not crashed", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/organizations/${orgA.org.id}`,
      headers: { cookie: "tol_session=00000000000000000000000000000000000000000000000000000000000000" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("P2 — deny-by-default through the real HTTP surface", () => {
  let app: FastifyInstance;
  let contributor: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let cookie: string;
  let csrf: string | undefined;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
    // CONTRIBUTOR_AGENT is never granted membership.create in the
    // authority matrix (packages/authz/src/matrix.ts) — an unlisted
    // role/action combination, proven denied here through the real route,
    // not just packages/authz's own unit tests.
    contributor = await createFixtureOrgWithUser({ orgLabel: "Charlie", role: "CONTRIBUTOR_AGENT" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: contributor.user.email, password: contributor.user.password },
    });
    cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));
    csrf = login.cookies.find((c) => c.name === "tol_csrf")?.value;
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("CONTRIBUTOR_AGENT cannot invite a new membership into their own org (unlisted role/action)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/organizations/${contributor.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf ?? "" },
      payload: { userId: contributor.user.id, role: "CONTRIBUTOR_AGENT" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/deny-by-default|not granted/i);
  });

  it("CONTRIBUTOR_AGENT cannot change any membership's role (PLATFORM_OWNER-only action)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/memberships/${contributor.membershipId}/role`,
      headers: { cookie, "x-csrf-token": csrf ?? "" },
      payload: { role: "PLATFORM_OWNER" },
    });
    expect(res.statusCode).toBe(403);
  });
});
