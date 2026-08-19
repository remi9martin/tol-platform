// apps/api/src/modules/organizations/mapper.ts
//
// The concrete earlier application of packages/authz's fieldPolicy() /
// redactFields() (the spec/p.11: "fieldPolicy(actor, resource)"; scope
// p.5 tenant rule: "Merchant users see... they do not see hidden provider
// floor/appetite"). registrationId is the one earlier field tagged
// RESTRICTED — a cross-org viewer without operator/compliance authority
// gets an Organization DTO with that field simply absent, not null,
// which is why OrganizationDTOSchema declares it `.optional()` rather
// than `.nullable()`.

import { redactFields, type Actor, type Resource } from "@tol/authz";
import type { Organization } from "@tol/db";
import type { OrganizationDTO } from "@tol/contracts";

const FIELD_CLASSES = {
  legalName: "MEMBER_MARKET",
  displayName: "PUBLIC_MARKET",
  entityType: "MEMBER_MARKET",
  country: "PUBLIC_MARKET",
  registrationId: "RESTRICTED",
  website: "MEMBER_MARKET",
  verificationStatus: "MEMBER_MARKET",
} as const;

export function toOrganizationDTO(actor: Actor, org: Organization): OrganizationDTO {
  const resource: Resource = { type: "organization", id: org.id, ownerOrgId: org.id, privacyClass: org.privacyClass };

  const visible = redactFields(
    actor,
    resource,
    {
      legalName: org.legalName,
      displayName: org.displayName,
      entityType: org.entityType,
      country: org.country,
      registrationId: org.registrationId ?? undefined,
      website: org.website ?? undefined,
      verificationStatus: org.verificationStatus,
    },
    FIELD_CLASSES,
  );

  // NO fallback to the raw `org.*` values here — that was a real bug
  // caught by mapper.test.ts during this stage: falling back to `org.X` when
  // `visible.X` is undefined silently un-redacts every field regardless
  // of viewer, which defeats the entire mechanism. `visible` IS the
  // answer; only displayName/country/privacyClass are asserted non-
  // optional below because they're the three fields guaranteed to
  // survive redaction for ANY viewer (PUBLIC_MARKET-tier or metadata),
  // which OrganizationDTOSchema encodes as required — see its own
  // comment for why the rest are genuinely optional on the wire.
  return {
    id: org.id,
    legalName: visible.legalName,
    displayName: visible.displayName!,
    entityType: visible.entityType,
    country: visible.country!,
    registrationId: visible.registrationId,
    website: visible.website,
    verificationStatus: visible.verificationStatus,
    privacyClass: org.privacyClass,
  };
}
