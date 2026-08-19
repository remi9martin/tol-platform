// apps/api/tests/integration/memberships.test.ts — invite/role-change/
// reactivate flow, plus the Idempotency-Key contract (the spec).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, newId, prisma } from "@tol/db";
import { buildTestApp, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

/** Creates a throwaway, already-ACTIVE User row for invite-flow test fixtures — password is never used since these users never log in. */
async function createInvitableUser(label: string) {
  return prisma.user.create({
    data: {
      id: newId(),
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      passwordHash: "unused",
      status: "ACTIVE",
      privacyClass: "RESTRICTED",
    },
  });
}

describe("memberships: create, idempotency, reactivate-after-revoke", () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
    owner = await createFixtureOrgWithUser({ orgLabel: "Golf", role: "PLATFORM_OWNER" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: owner.user.email, password: owner.user.password },
    });
    cookie = extractCookieHeader(login.cookies.map((c) => `${c.name}=${c.value}`));
    csrf = login.cookies.find((c) => c.name === "tol_csrf")?.value ?? "";
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("creates a new membership for an existing user", async () => {
    const invitee = await createInvitableUser("invitee");

    const res = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { userId: invitee.id, role: "CONTRIBUTOR_AGENT", invitationSource: "test-suite" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("INVITED");
    expect(res.json().role).toBe("CONTRIBUTOR_AGENT");
  });

  it("Idempotency-Key: a retried POST with the same key returns the SAME membership, not a duplicate", async () => {
    const invitee = await createInvitableUser("idem-invitee");
    const idempotencyKey = `test-key-${Date.now()}`;
    const payload = { userId: invitee.id, role: "CONTRIBUTOR_AGENT" };

    const first = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    const second = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(firstId);

    const rows = await prisma.organizationMembership.findMany({
      where: { organizationId: owner.org.id, userId: invitee.id },
    });
    expect(rows.length).toBe(1);
  });

  it("Idempotency-Key reused with a DIFFERENT body is rejected with 409, not silently replayed", async () => {
    const inviteeA = await createInvitableUser("key-reuse-a");
    const inviteeB = await createInvitableUser("key-reuse-b");
    const idempotencyKey = `reuse-key-${Date.now()}`;

    const first = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
      payload: { userId: inviteeA.id, role: "CONTRIBUTOR_AGENT" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
      payload: { userId: inviteeB.id, role: "CONTRIBUTOR_AGENT" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("revoke then re-invite to the SAME role reactivates the row instead of failing on the unique constraint", async () => {
    const invitee = await createInvitableUser("reactivate");

    const created = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { userId: invitee.id, role: "CONTRIBUTOR_AGENT" },
    });
    const membershipId = created.json().id;

    const revoked = await app.inject({
      method: "PATCH",
      url: `/memberships/${membershipId}/status`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { status: "REVOKED" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("REVOKED");

    // Re-invite the SAME user to the SAME role in the SAME org — this is
    // exactly the case the packages/db review's BLOCKER fix
    // (findByUserOrgRole + reactivate) exists for.
    const reinvited = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { userId: invitee.id, role: "CONTRIBUTOR_AGENT" },
    });
    expect(reinvited.statusCode).toBe(201);
    expect(reinvited.json().id).toBe(membershipId); // same row, reactivated
    expect(reinvited.json().status).toBe("INVITED");

    const row = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(row.effectiveTo).toBeNull();
    expect(row.retiredAt).toBeNull();
  });

  it("role change revokes the old row and creates a new one (history preserved, not overwritten)", async () => {
    const invitee = await createInvitableUser("role-change");
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${owner.org.id}/memberships`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { userId: invitee.id, role: "CONTRIBUTOR_AGENT" },
    });
    const oldId = created.json().id;

    const changed = await app.inject({
      method: "PATCH",
      url: `/memberships/${oldId}/role`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { role: "MARKETPLACE_OPERATOR" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().role).toBe("MARKETPLACE_OPERATOR");
    expect(changed.json().id).not.toBe(oldId);

    const oldRow = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: oldId } });
    expect(oldRow.status).toBe("REVOKED");

    const auditEvents = await prisma.auditEvent.findMany({
      where: { action: "membership.role_changed", resourceId: changed.json().id },
    });
    expect(auditEvents.length).toBeGreaterThan(0);
    expect(auditEvents[0]?.reason).toMatch(/CONTRIBUTOR_AGENT -> MARKETPLACE_OPERATOR/);
  });
});
