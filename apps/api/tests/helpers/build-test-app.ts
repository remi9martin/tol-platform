// apps/api/tests/helpers/build-test-app.ts
//
// Builds a real app instance (the exact same buildApp() server.ts uses)
// for integration tests to drive via Fastify's `.inject()` — exercises
// the full plugin/route/service/authz/repository chain against the real
// docker-compose Postgres, with no real network socket needed. This is
// NOT a mock of the API; it IS the API, minus .listen().

import { prisma, newId, hashPassword } from "@tol/db";
import type { OrganizationType } from "@tol/db";
import { buildApp } from "../../src/app.js";

export async function buildTestApp() {
  return buildApp();
}

export interface TestFixtureOrg {
  id: string;
  displayName: string;
}

export interface TestFixtureUser {
  id: string;
  email: string;
  password: string;
}

/**
 * Creates a fresh, uniquely-named org + user + ACTIVE membership per call
 * (timestamp+random suffix in the org/email), independent of
 * prisma/seed.ts's shared earlier fixtures — so this test suite never
 * mutates or depends on the same rows a manually-run `pnpm prisma:seed`
 * pass relies on, and can run repeatedly without cleanup between runs.
 */
export async function createFixtureOrgWithUser(opts: {
  orgLabel: string;
  role: string;
  entityType?: OrganizationType;
}): Promise<{ org: TestFixtureOrg; user: TestFixtureUser; membershipId: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "TestPassw0rd!-" + suffix;

  const org = await prisma.organization.create({
    data: {
      id: newId(),
      legalName: `${opts.orgLabel} Test Org ${suffix}, LLC`,
      displayName: `${opts.orgLabel} Test Org ${suffix}`,
      entityType: opts.entityType ?? "MERCHANT",
      country: "US",
      verificationStatus: "VERIFIED",
      privacyClass: "MEMBER_MARKET",
    },
  });

  const email = `test-${suffix}@example.test`;
  const user = await prisma.user.create({
    data: {
      id: newId(),
      email,
      passwordHash: await hashPassword(password),
      status: "ACTIVE",
      privacyClass: "RESTRICTED",
    },
  });

  const membership = await prisma.organizationMembership.create({
    data: {
      id: newId(),
      organizationId: org.id,
      userId: user.id,
      // Prisma's generated enum type is imported dynamically here to avoid
      // a second explicit @prisma/client dependency in this test-only file
      // beyond what @tol/db already re-exports.
      role: opts.role as never,
      status: "ACTIVE",
      effectiveFrom: new Date(),
      privacyClass: "RESTRICTED",
    },
  });

  return {
    org: { id: org.id, displayName: org.displayName },
    user: { id: user.id, email, password },
    membershipId: membership.id,
  };
}

/**
 * earlier: a MATCH_READY Opportunity, created directly via Prisma (like
 * createFixtureOrgWithUser above) rather than through
 * opportunitiesService — this is test-fixture setup, not the behavior
 * under test.
 */
export async function createFixtureOpportunity(ownerOrgId: string, userId: string): Promise<{ id: string; ownerOrgId: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const opp = await prisma.opportunity.create({
    data: {
      id: newId(),
      ownerOrgId,
      opportunityType: "ACQUIRING",
      requestedService: `Test opportunity ${suffix}`,
      status: "MATCH_READY",
      currency: "USD",
      totalPaymentVolumeMinor: 10_000_000_00n,
      totalCardGpvMinor: 9_000_000_00n,
      eligibleCardGpvMinor: 8_000_000_00n,
      offeredCardGpvMinor: 5_000_000_00n,
      jurisdictions: ["US"],
      mccs: ["5411"],
      privacyClass: "MEMBER_MARKET",
      createdByUserId: userId,
      createdByOrgId: ownerOrgId,
    },
  });
  return { id: opp.id, ownerOrgId: opp.ownerOrgId };
}

/** earlier: a FRESH CapacityProfile, created directly via Prisma. */
export async function createFixtureCapacityProfile(providerOrgId: string, userId: string): Promise<{ id: string; providerOrgId: string }> {
  const profile = await prisma.capacityProfile.create({
    data: {
      id: newId(),
      providerOrgId,
      asOf: new Date(),
      freshnessClass: "FRESH",
      acceptingNewVolume: true,
      jurisdictions: ["US"],
      mccsAccepted: ["5411"],
      mccsExcluded: [],
      currency: "USD",
      monthlyCapacityMinor: 20_000_000_00n,
      minTicketMinor: 100,
      maxTicketMinor: 100_000,
      settlementRail: "ACH",
      settlementCadenceDays: 2,
      privacyClass: "RESTRICTED",
      createdByUserId: userId,
      createdByOrgId: providerOrgId,
    },
  });
  return { id: profile.id, providerOrgId: profile.providerOrgId };
}

/** Extracts the raw tol_session cookie value from a login response's set-cookie headers, for use as the `cookie` header on subsequent injected requests. */
export function extractCookieHeader(setCookieHeaders: string[] | undefined): string {
  if (!setCookieHeaders) return "";
  return setCookieHeaders
    .map((h) => h.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

export function extractCsrfToken(setCookieHeaders: string[] | undefined): string | undefined {
  if (!setCookieHeaders) return undefined;
  for (const h of setCookieHeaders) {
    const match = /tol_csrf=([^;]+)/.exec(h);
    if (match) return match[1];
  }
  return undefined;
}
