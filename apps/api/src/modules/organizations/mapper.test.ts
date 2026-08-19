import { describe, expect, it } from "vitest";
import type { Actor } from "@tol/authz";
import type { Organization } from "@tol/db";
import { toOrganizationDTO } from "./mapper.js";

const ORG_A = "00000000-0000-7000-8000-00000000000a";
const ORG_B = "00000000-0000-7000-8000-00000000000b";

function fakeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG_A,
    legalName: "Acme Holdings, LLC",
    displayName: "Acme Holdings",
    entityType: "MERCHANT",
    country: "US",
    registrationId: "US-99999",
    website: "https://acme.example",
    verificationStatus: "VERIFIED",
    createdAt: new Date(),
    createdByUserId: null,
    createdByOrgId: null,
    updatedAt: new Date(),
    updatedByUserId: null,
    status: "ACTIVE",
    version: 1,
    privacyClass: "MEMBER_MARKET",
    sourceType: "PLATFORM",
    sourceReference: null,
    effectiveFrom: null,
    effectiveTo: null,
    retiredAt: null,
    ...overrides,
  } as Organization;
}

/**
 * the actual route surface never lets a MEMBER_MARKET-ceiling
 * cross-org viewer reach GET /organizations/:id at all — every role
 * that's granted "organization.read" cross-org (matrix.ts:
 * PLATFORM_OWNER/MARKETPLACE_OPERATOR/COMPLIANCE_REVIEWER/
 * AUDITOR_READONLY) also happens to carry an elevated field-policy
 * ceiling, so the "interesting" redaction case (a bare MEMBER_MARKET
 * viewer seeing a REDACTED registrationId) isn't reachable through
 * apps/api's routes until a later day's Marketplace gate (P5) opens
 * broader read access. That's a real, honestly-noted reachability gap —
 * this test proves the MAPPER's redaction mechanism itself is correct in
 * isolation, independent of whether today's authz matrix currently
 * routes a live request into it.
 */
describe("toOrganizationDTO — field redaction by viewer ceiling", () => {
  it("owner (same org) sees every field, including RESTRICTED-tier registrationId", () => {
    const actor: Actor = { userId: "u1", organizationId: ORG_A, role: "MERCHANT_PSP_USER", membershipId: "m1" };
    const dto = toOrganizationDTO(actor, fakeOrg());
    expect(dto.registrationId).toBe("US-99999");
    expect(dto.legalName).toBe("Acme Holdings, LLC");
  });

  it("PLATFORM_OWNER sees every field even cross-org", () => {
    const actor: Actor = { userId: "u2", organizationId: ORG_B, role: "PLATFORM_OWNER", membershipId: "m2" };
    const dto = toOrganizationDTO(actor, fakeOrg());
    expect(dto.registrationId).toBe("US-99999");
  });

  it("a hypothetical MEMBER_MARKET-ceiling cross-org viewer sees public/member fields but NOT registrationId", () => {
    const actor: Actor = { userId: "u3", organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER", membershipId: "m3" };
    const dto = toOrganizationDTO(actor, fakeOrg());
    expect(dto.displayName).toBe("Acme Holdings");
    expect(dto.country).toBe("US");
    expect(dto.registrationId).toBeUndefined();
  });

  it("an unauthenticated (role=null) viewer sees only PUBLIC_MARKET-tier fields", () => {
    const actor: Actor = { userId: "u4", organizationId: null, role: null, membershipId: null };
    const dto = toOrganizationDTO(actor, fakeOrg());
    expect(dto.displayName).toBe("Acme Holdings"); // PUBLIC_MARKET
    expect(dto.country).toBe("US"); // PUBLIC_MARKET
    expect(dto.legalName).toBeUndefined(); // MEMBER_MARKET — hidden from an anonymous viewer
    expect(dto.registrationId).toBeUndefined(); // RESTRICTED
  });
});
