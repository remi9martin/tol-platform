import { describe, expect, it } from "vitest";
import { fieldPolicy, isFieldVisible, redactFields } from "./field-policy.js";
import type { Actor, Resource } from "./actions.js";

const ORG_A = "00000000-0000-7000-8000-00000000000a";
const ORG_B = "00000000-0000-7000-8000-00000000000b";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user-1",
    organizationId: ORG_A,
    role: "MERCHANT_PSP_USER",
    membershipId: "membership-1",
    ...overrides,
  };
}

const orgAResource: Resource = { type: "organization", ownerOrgId: ORG_A };

describe("fieldPolicy() — ownership always wins", () => {
  it("gives a same-org actor SECRET-ceiling (full) visibility of their own org's record", () => {
    const result = fieldPolicy(actor({ organizationId: ORG_A }), orgAResource);
    expect(result.isOwnerView).toBe(true);
    expect(result.maxVisibleClass).toBe("SECRET");
  });

  it("gives PLATFORM_OWNER full visibility even cross-org", () => {
    const result = fieldPolicy(actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" }), orgAResource);
    expect(result.maxVisibleClass).toBe("SECRET");
  });
});

describe("fieldPolicy() — cross-org ceiling by role", () => {
  it("caps a baseline member-role viewer at MEMBER_MARKET for another org's data", () => {
    const result = fieldPolicy(actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" }), orgAResource);
    expect(result.isOwnerView).toBe(false);
    expect(result.maxVisibleClass).toBe("MEMBER_MARKET");
  });

  it("gives COMPLIANCE_REVIEWER an elevated RESTRICTED ceiling cross-org (p.4 authority)", () => {
    const result = fieldPolicy(actor({ organizationId: ORG_B, role: "COMPLIANCE_REVIEWER" }), orgAResource);
    expect(result.maxVisibleClass).toBe("RESTRICTED");
  });

  it("caps an unauthenticated (role=null) actor at PUBLIC_MARKET", () => {
    const result = fieldPolicy(actor({ organizationId: null, role: null }), orgAResource);
    expect(result.maxVisibleClass).toBe("PUBLIC_MARKET");
  });
});

describe("isFieldVisible()", () => {
  it("hides a RESTRICTED field from a baseline cross-org viewer", () => {
    const viewer = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    expect(isFieldVisible(viewer, orgAResource, "RESTRICTED")).toBe(false);
    expect(isFieldVisible(viewer, orgAResource, "PUBLIC_MARKET")).toBe(true);
    expect(isFieldVisible(viewer, orgAResource, "MEMBER_MARKET")).toBe(true);
  });

  it("shows a RESTRICTED field to the owning org", () => {
    const owner = actor({ organizationId: ORG_A });
    expect(isFieldVisible(owner, orgAResource, "RESTRICTED")).toBe(true);
    expect(isFieldVisible(owner, orgAResource, "SECRET")).toBe(true);
  });

  it("fails CLOSED (throws) on a malformed DisclosureClass instead of silently treating it as visible", () => {
    // Regression test for the review-flagged fail-open risk: Array.indexOf
    // returning -1 for an unrecognized value would otherwise satisfy
    // `-1 <= any real rank` and leak the field. Simulates unvalidated input
    // (e.g. a value that arrived over HTTP and was cast without checking
    // isDisclosureClass() first) via an `as` escape hatch.
    const viewer = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    expect(() => isFieldVisible(viewer, orgAResource, "NOT_A_REAL_CLASS" as never)).toThrow(TypeError);
  });
});

describe("redactFields()", () => {
  // `type`, not `interface` — an interface has no index signature and TS
  // won't structurally match it against redactFields<T extends
  // Record<string, unknown>>'s constraint (interfaces are kept open for
  // declaration merging, so the compiler can't prove they're closed
  // shapes the way it can for a type alias's object literal).
  type OrgFields = {
    displayName: string;
    country: string;
    registrationId: string;
  };

  const fields: OrgFields = { displayName: "Acme", country: "US", registrationId: "US-12345" };
  const classes: Partial<Record<keyof OrgFields, "PUBLIC_MARKET" | "RESTRICTED">> = {
    displayName: "PUBLIC_MARKET",
    country: "PUBLIC_MARKET",
    registrationId: "RESTRICTED",
  };

  it("drops fields above the viewer's ceiling for a cross-org, non-privileged viewer", () => {
    const viewer = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const result = redactFields(viewer, orgAResource, fields, classes);
    expect(result.displayName).toBe("Acme");
    expect(result.country).toBe("US");
    expect(result.registrationId).toBeUndefined();
  });

  it("keeps every field for the owning org", () => {
    const owner = actor({ organizationId: ORG_A });
    const result = redactFields(owner, orgAResource, fields, classes);
    expect(result.registrationId).toBe("US-12345");
  });
});
