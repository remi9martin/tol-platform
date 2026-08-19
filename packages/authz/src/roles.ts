// packages/authz/src/roles.ts
//
// packages/authz is a pure, dependency-free policy engine (no runtime
// dependency on @tol/db or any other package — see README.md "Why no
// dependencies" for the reasoning). It therefore defines its OWN copy of
// the PersonaRole and DisclosureClass vocabulary rather than importing
// Prisma's generated enum types. Both this file and
// packages/db/prisma/schema.prisma's enums of the same name are
// independently grounded in the same scope citations (p.4 for personas,
// ADR-0005 / p.12 for disclosure classes) — packages/authz/src/
// roles.consistency.test.ts asserts the two never drift apart.

/**
 * The persona/authority matrix from the spec. Counted directly from the
 * page's persona table during this build (10 rows). Prior repo docs say
 * "nine personas" — verified against the primary source during this
 * build and found to be an undercount; all 10 rows are modeled.
 */
export const PERSONA_ROLES = [
  "PLATFORM_OWNER",
  "MARKETPLACE_OPERATOR",
  "PARTNERSHIP_LEAD",
  "UNDERWRITING_ANALYST",
  "COMPLIANCE_REVIEWER",
  "FINANCE_OPERATOR",
  "CONTRIBUTOR_AGENT",
  "MERCHANT_PSP_USER",
  "ACQUIRER_PROVIDER_USER",
  "AUDITOR_READONLY",
] as const;

export type PersonaRole = (typeof PERSONA_ROLES)[number];

export function isPersonaRole(value: string): value is PersonaRole {
  return (PERSONA_ROLES as readonly string[]).includes(value);
}

/**
 * Canonical six-value disclosure/data-class ladder per ADR-0005
 * (= the spec's list). Ordered least-to-most sensitive — both p.4 and
 * p.12 list the six values in this same increasing-sensitivity order,
 * which packages/authz treats as a real ladder (a total order) for the
 * field-policy mechanism in field-policy.ts. That's a modeling choice,
 * not a verbatim scope rule — flagged here rather than silently assumed.
 */
export const DISCLOSURE_CLASSES = [
  "PUBLIC_MARKET",
  "MEMBER_MARKET",
  "MATCH_SUMMARY",
  "DEAL_ROOM",
  "RESTRICTED",
  "SECRET",
] as const;

export type DisclosureClass = (typeof DISCLOSURE_CLASSES)[number];

export function isDisclosureClass(value: string): value is DisclosureClass {
  return (DISCLOSURE_CLASSES as readonly string[]).includes(value);
}

/**
 * Index into DISCLOSURE_CLASSES — higher = more sensitive. Used by
 * field-policy.ts's ladder comparison (`fieldRank <= viewerCeilingRank`).
 * Throws on an unrecognized value rather than returning Array.indexOf's
 * -1 — fixed after review (packages/authz block, 2026-08-18)
 * correctly flagged that -1 would satisfy `-1 <= any rank`, silently
 * treating a malformed/unvalidated DisclosureClass as MORE visible than
 * even PUBLIC_MARKET (rank 0) instead of failing closed. TypeScript's
 * `DisclosureClass` parameter type prevents this for well-typed callers,
 * but this function must stay safe for the unvalidated-input case too
 * (e.g. a value that arrived over HTTP and was cast, not verified, by a
 * caller who skipped isDisclosureClass()).
 */
export function disclosureRank(cls: DisclosureClass): number {
  const rank = DISCLOSURE_CLASSES.indexOf(cls);
  if (rank === -1) {
    throw new TypeError(`disclosureRank: "${cls}" is not a valid DisclosureClass`);
  }
  return rank;
}

export const PERSONA_LABELS: Record<PersonaRole, string> = {
  PLATFORM_OWNER: "Platform Owner",
  MARKETPLACE_OPERATOR: "Marketplace Operator",
  PARTNERSHIP_LEAD: "Partnership Lead",
  UNDERWRITING_ANALYST: "Underwriting / Readiness Analyst",
  COMPLIANCE_REVIEWER: "Compliance Reviewer",
  FINANCE_OPERATOR: "Finance Operator",
  CONTRIBUTOR_AGENT: "Contributor / Agent",
  MERCHANT_PSP_USER: "Merchant / PSP User",
  ACQUIRER_PROVIDER_USER: "Acquirer / Provider User",
  AUDITOR_READONLY: "Auditor / Read-only",
};
