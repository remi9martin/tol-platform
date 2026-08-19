// apps/api/tests/integration/volume-slices.test.ts
//
// P7 gate proof (the spec: "Volume reconciliation + role
// classification") through the real HTTP surface — a REAL SUM check
// (@tol/domain's reconcileOpportunityVolume) run against real
// VolumeSlice rows written and read through actual HTTP round trips,
// never a hand-computed reconciliation result. Proves: a matching
// breakdown reconciles cleanly; a mismatched one fails loudly and names
// exactly why (never silently accepted, p.15); tenant isolation.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma } from "@tol/db";
import { buildTestApp, createFixtureOpportunity, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

describe("P7 — Opportunity: volume reconciliation through the real HTTP surface", () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let ownerSession: { cookie: string; csrf: string };
  let outsiderSession: { cookie: string; csrf: string };
  let opportunity: { id: string; ownerOrgId: string };

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    owner = await createFixtureOrgWithUser({ orgLabel: "VolumeOwner", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "VolumeOutsider", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    ownerSession = await login(app, owner.user.email, owner.user.password);
    outsiderSession = await login(app, outsider.user.email, outsider.user.password);

    // createFixtureOpportunity's own offeredCardGpvMinor is 5_000_000_00n (see build-test-app.ts).
    opportunity = await createFixtureOpportunity(owner.org.id, owner.user.id);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("DENIES a different org from replacing this opportunity's volume slices — 403, tenant isolation", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/opportunities/${opportunity.id}/volume-slices`,
      headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf },
      payload: { slices: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a breakdown that DOES NOT sum to offeredCardGpvMinor fails loudly — reconciled: false, a real sum_mismatch entry naming both figures, never silently accepted", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/opportunities/${opportunity.id}/volume-slices`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: {
        slices: [{ jurisdiction: "US", mcc: "5411", cardOrigin: "DOMESTIC", channel: "ECOMMERCE", amountMinor: "1000000", period: "2026-07" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reconciliation.reconciled).toBe(false);
    expect(body.reconciliation.mismatches.some((m: { code: string }) => m.code === "sum_mismatch")).toBe(true);
    expect(body.reconciliation.sliceTotalMinor).toBe("1000000");
    expect(body.reconciliation.offeredCardGpvMinor).toBe("500000000");
  });

  it("a breakdown that DOES sum correctly reconciles cleanly — reconciled: true, zero mismatches, through a REAL SUM over REAL persisted rows", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/opportunities/${opportunity.id}/volume-slices`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: {
        slices: [
          { jurisdiction: "US", mcc: "5411", cardOrigin: "DOMESTIC", channel: "ECOMMERCE", amountMinor: "300000000", period: "2026-07" },
          { jurisdiction: "US", mcc: "5812", cardOrigin: "DOMESTIC", channel: "ECOMMERCE", amountMinor: "200000000", period: "2026-07" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reconciliation.reconciled).toBe(true);
    expect(body.reconciliation.mismatches).toEqual([]);
    expect(body.reconciliation.sliceTotalMinor).toBe("500000000");
    expect(body.slices.length).toBe(2);
  });

  it("replacing again with a NEW breakdown wholly supersedes the old one — GET reflects only the latest set, proving the delete-all+recreate transaction, not an accumulating append", async () => {
    await app.inject({
      method: "PUT",
      url: `/opportunities/${opportunity.id}/volume-slices`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: { slices: [{ jurisdiction: "CA", mcc: "5411", cardOrigin: "DOMESTIC", channel: "ECOMMERCE", amountMinor: "500000000", period: "2026-08" }] },
    });

    const res = await app.inject({ method: "GET", url: `/opportunities/${opportunity.id}/volume-slices`, headers: { cookie: ownerSession.cookie } });
    const body = res.json();
    expect(body.slices.length).toBe(1);
    expect(body.slices[0].jurisdiction).toBe("CA");
    expect(body.reconciliation.reconciled).toBe(true);
  });

  it("a duplicate cell within the SAME submission is rejected with a real duplicate_cell mismatch, not silently double-counted", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/opportunities/${opportunity.id}/volume-slices`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: {
        slices: [
          { jurisdiction: "US", mcc: "5411", cardOrigin: "DOMESTIC", channel: "ECOMMERCE", amountMinor: "250000000", period: "2026-07" },
          { jurisdiction: "US", mcc: "5411", cardOrigin: "DOMESTIC", channel: "ECOMMERCE", amountMinor: "250000000", period: "2026-07" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciliation.mismatches.some((m: { code: string }) => m.code === "duplicate_cell")).toBe(true);
  });
});
