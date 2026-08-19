// packages/authz/src/field-policy.ts
//
// fieldPolicy(actor, resource) — field-level disclosure by privacy_class
// (the spec/p.11: "@tol/authz exposes can(actor, action, resource,
// context) and fieldPolicy(actor, resource)"). Distinct from can(): can()
// answers "may this actor perform this ACTION at all", fieldPolicy()
// answers "given they may READ this resource, which of its FIELDS are
// they allowed to see" — an actor can pass can(actor, "organization.read",
// ...) and still not see every field.
//
// Ownership always wins: the organization that OWNS a record (or
// Platform Owner) sees it in full, regardless of the record's own
// privacy_class — that column governs what NON-owning parties see, not
// what the owner sees of themselves. This mirrors the marketplace's own
// "visible market, private deal" thesis (p.6): tiers gate cross-party
// disclosure, not self-visibility.

import type { Actor, Resource } from "./actions.js";
import type { DisclosureClass } from "./roles.js";
import { disclosureRank } from "./roles.js";

export interface FieldPolicyResult {
  /** The actor sees this resource's own org data as owner (or Platform Owner) — full access, not gated by privacy_class at all. */
  isOwnerView: boolean;
  /** Highest DisclosureClass tier visible to this actor for this resource. Compare via disclosureRank(fieldClass) <= disclosureRank(maxVisibleClass). */
  maxVisibleClass: DisclosureClass;
}

/**
 * Cross-org visibility ceiling by role — how much of ANOTHER org's data
 * this role sees when it is NOT the owner. Roles absent from this map
 * default to MEMBER_MARKET (the spec's baseline: any authenticated
 * platform member sees at least MEMBER_MARKET-tier fields of any org).
 * Grounded in p.4: "Platform operators may access sensitive content only
 * when their role permits it" — the three operator/compliance-tier roles
 * below are the ones the scope calls out as having elevated authority.
 */
const CROSS_ORG_CEILING: Partial<Record<Actor["role"] & string, DisclosureClass>> = {
  PLATFORM_OWNER: "SECRET",
  MARKETPLACE_OPERATOR: "RESTRICTED",
  COMPLIANCE_REVIEWER: "RESTRICTED",
  AUDITOR_READONLY: "RESTRICTED",
};

export function fieldPolicy(actor: Actor, resource: Resource): FieldPolicyResult {
  const isPlatformOwner = actor.role === "PLATFORM_OWNER";
  const isOwner = resource.ownerOrgId !== null && resource.ownerOrgId === actor.organizationId;

  if (isPlatformOwner || isOwner) {
    return { isOwnerView: isPlatformOwner || isOwner, maxVisibleClass: "SECRET" };
  }

  if (actor.role === null) {
    return { isOwnerView: false, maxVisibleClass: "PUBLIC_MARKET" };
  }

  const ceiling = CROSS_ORG_CEILING[actor.role] ?? "MEMBER_MARKET";
  return { isOwnerView: false, maxVisibleClass: ceiling };
}

/** True when a field tagged `fieldClass` is visible to `actor` for `resource`, per fieldPolicy()'s ceiling. */
export function isFieldVisible(actor: Actor, resource: Resource, fieldClass: DisclosureClass): boolean {
  const { maxVisibleClass } = fieldPolicy(actor, resource);
  return disclosureRank(fieldClass) <= disclosureRank(maxVisibleClass);
}

/**
 * Applies fieldPolicy to a plain object of {value, class} entries,
 * returning only the fields the actor may see. The concrete shape a
 * caller uses this for (e.g. Organization's registrationId being
 * RESTRICTED-tier) is decided by that caller (apps/api's mappers) — this
 * function is the generic mechanism, not tied to any one entity.
 *
 * `defaultClass` falls back to the resource's OWN `privacyClass` (its
 * base-audit `privacy_class` column, the spec) when the caller doesn't
 * override it, rather than a hardcoded constant — this is what makes the
 * `Resource.privacyClass` field mean something instead of sitting unused
 * (tightened after review, packages/authz block, 2026-08-18,
 * noted it was declared but never actually read by anything).
 *
 * Skips dangerous own-key names (`__proto__`, `constructor`, `prototype`)
 * defensively — `fields` is typed as application-constructed data for
 * the actual call sites, but this is a generic, reusable utility a
 * future caller could feed a raw parsed-JSON object, which IS a known
 * prototype-pollution vector for exactly this "iterate own keys, assign
 * into a fresh object" shape.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function redactFields<T extends Record<string, unknown>>(
  actor: Actor,
  resource: Resource,
  fields: T,
  fieldClasses: Partial<Record<keyof T, DisclosureClass>>,
  defaultClass?: DisclosureClass,
): Partial<T> {
  const { maxVisibleClass } = fieldPolicy(actor, resource);
  const fallbackClass = defaultClass ?? resource.privacyClass ?? "MEMBER_MARKET";
  const out: Partial<T> = {};
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (DANGEROUS_KEYS.has(String(key))) continue;
    const cls = fieldClasses[key] ?? fallbackClass;
    if (disclosureRank(cls) <= disclosureRank(maxVisibleClass)) {
      out[key] = fields[key];
    }
  }
  return out;
}
