// packages/authz/src/can.ts
//
// The P4 gate lives here: tenant isolation is not a separate check
// somewhere in apps/api, it is THIS function's core mechanism — every
// caller (apps/api's services, apps/web's server components reflecting
// affordances) goes through can(), and can() is the only place that
// compares an actor's organization to a resource's owner organization.

import type { Action, Actor, AuthContext, AuthDecision, Resource } from "./actions.js";
import { AUTHORITY_MATRIX } from "./matrix.js";

/** Which resource `type` each action legitimately operates on — guards against a caller passing a mismatched resource by mistake. */
const ACTION_RESOURCE_TYPE: Record<Action, Resource["type"]> = {
  "organization.read": "organization",
  "organization.list": "organization",
  "organization.update": "organization",
  "membership.read": "membership",
  "membership.list": "membership",
  "membership.create": "membership",
  "membership.update_role": "membership",
  "membership.update_status": "membership",
  "person.read": "person",
  "person.update": "person",
  "audit.read": "audit_event",
  // ---- earlier ----
  "opportunity.create": "opportunity",
  "opportunity.read": "opportunity",
  "opportunity.list": "opportunity",
  "opportunity.update": "opportunity",
  "capacity.create": "capacity_profile",
  "capacity.read": "capacity_profile",
  "capacity.list": "capacity_profile",
  "rfq.create": "rfq",
  "rfq.read": "rfq",
  "rfq.list": "rfq",
  "rfq.decline": "rfq",
  "rfq.submit_quote": "rfq",
  "rfq.withdraw_quote": "rfq",
  "rfq.select_quote": "rfq",
  "deal.read": "deal_room",
  "deal.list": "deal_room",
  "deal.post_condition": "deal_room",
  "deal.resolve_condition": "deal_room",
  "deal.record_decision": "deal_room",
  // ---- earlier ----
  "lockbox.seal": "lockbox",
  "lockbox.read_receipt": "lockbox",
  "lockbox.withdraw": "lockbox",
  "lockbox.release": "lockbox",
  // ---- earlier ----
  "claim.create": "claim",
  "claim.read": "claim",
  "claim.list": "claim",
  "claim.dispute": "claim",
  "claim.decide": "claim",
  // ---- earlier ----
  "passport.create": "passport",
  "passport.read": "passport",
  "passport.list": "passport",
  "passport.update": "passport",
  "passport.verify": "passport",
  "opportunity.browse_market": "opportunity",
  "capacity.browse_market": "capacity_profile",
  // ---- earlier ----
  "matching.evaluate": "match_result",
  "match.read": "match_result",
  "match.list": "match_result",
  // ---- earlier ----
  "schedule.read": "commission_schedule",
  "schedule.list": "commission_schedule",
  "schedule.manage": "commission_schedule",
  "economics.read": "revenue_event",
  "economics.list": "revenue_event",
  "economics.record": "revenue_event",
  "ledger.read": "commission_accrual",
  "ledger.list": "commission_accrual",
  "ledger.record_payment": "commission_accrual",
  "ledger.adjust": "commission_accrual",
};

function deny(reason: string): AuthDecision {
  return { allowed: false, reason };
}

function allow(reason: string): AuthDecision {
  return { allowed: true, reason };
}

/**
 * can(actor, action, resource, context) — deny by default. Every path
 * through this function that isn't an explicit `allow(...)` return falls
 * through to the final `deny(...)` at the bottom; there is no implicit
 * "if nothing matched, allow" branch anywhere.
 */
export function can(actor: Actor, action: Action, resource: Resource, context: AuthContext = {}): AuthDecision {
  const expectedType = ACTION_RESOURCE_TYPE[action];
  if (resource.type !== expectedType) {
    return deny(`action "${action}" applies to resource type "${expectedType}", got "${resource.type}"`);
  }

  // role and organizationId always originate from the SAME
  // OrganizationMembership row (apps/api's auth plugin resolves both
  // together from Session.activeMembership, never independently) — there
  // is no real code path where one is set without the other. Requiring
  // both here isn't a gap for e.g. PLATFORM_OWNER; it means "this actor
  // currently has no active membership selected at all", in which case
  // even Platform Owner's cross-org grants don't apply, because a
  // cross-org grant is still exercised FROM a home-org membership context
  // (their own org's membership row), not from a member-of-nothing state.
  if (actor.role === null || actor.organizationId === null) {
    return deny("actor has no active organization membership — no action is grantable without one");
  }

  const grant = AUTHORITY_MATRIX[actor.role];
  // AUTHORITY_MATRIX is exhaustive over PersonaRole (enforced at module
  // load in matrix.ts), so this is unreachable for a well-typed Actor —
  // kept as a defensive deny rather than a non-null assertion so a
  // malformed actor.role (e.g. from unvalidated external input) fails
  // closed instead of throwing.
  if (!grant) {
    return deny(`no authority matrix entry for role "${actor.role}"`);
  }

  if (!grant.allowedActions.has(action)) {
    return deny(`role "${actor.role}" is not granted "${action}" (deny-by-default: unlisted combination)`);
  }

  // person.update carries an extra "self, or explicitly grant broader
  // authority" rule on top of the base matrix lookup — see matrix.ts's
  // managesOtherPeopleInOwnOrg doc comment for why this isn't just a
  // flat allow once the action is in the role's set.
  if (action === "person.update" && !context.isSelf && !grant.managesOtherPeopleInOwnOrg) {
    return deny(`role "${actor.role}" may only update its own person record (context.isSelf was false)`);
  }

  if (grant.crossOrgActions.has(action)) {
    return allow(`role "${actor.role}" has cross-org authority for "${action}"`);
  }

  // earlier: the isParticipant path (ADR-0008) — an invited
  // provider acting on a merchant-owned RFQ, or either counterparty
  // acting on a joint DealRoom, is not the resource's ownerOrgId but IS
  // individually, verifiably named on this specific instance (an
  // RFQRecipient or DealRoomParticipant row the CALLER already looked up
  // before invoking can() — this function never queries the database
  // itself). Checked before the ownerOrgId comparison below so it works
  // as a genuine alternative path, not a narrowing of it: it does not
  // require resource.ownerOrgId to match, or even be non-null.
  if (context.isParticipant && grant.participantActions.has(action)) {
    return allow(`role "${actor.role}" has verified participant authority for "${action}" on this specific resource`);
  }

  // earlier hardening (review): a
  // `commission_accrual` resource has no legitimate "plain same-org
  // owner" at all (actions.ts's own Resource.ownerOrgId comment — a
  // deal's merchant org is NOT automatically entitled to see the
  // internal commission split just because it's the merchant's own
  // deal). The documented contract is that callers always pass
  // `ownerOrgId: null` for this resource type — this line makes that
  // STRUCTURAL rather than merely relying on every future call site to
  // remember the convention: even if a caller ever passed a real
  // `ownerOrgId` here by mistake, the ordinary same-org fallback below
  // is categorically skipped for this one resource type, so only
  // `crossOrgActions` (checked above) or a freshly-verified
  // `isParticipant` (also checked above) can ever grant `ledger.*`
  // access — never "the actor happens to work at the deal's merchant
  // org." Every other resource type is unaffected; this is the one
  // deliberate exception, not a new default.
  if (resource.type === "commission_accrual") {
    return deny(`"${action}" on a commission_accrual requires cross-org authority or verified participant (recipient) standing — there is no ordinary same-org owner path for the traceable ledger`);
  }

  if (resource.ownerOrgId === null) {
    return deny(`"${action}" requires same-org scope but resource has no ownerOrgId to compare against`);
  }

  if (resource.ownerOrgId !== actor.organizationId) {
    return deny(
      `tenant isolation: actor's org (${actor.organizationId}) does not match resource's org (${resource.ownerOrgId}), and role "${actor.role}" has no cross-org grant for "${action}"`,
    );
  }

  return allow(`role "${actor.role}" is granted "${action}" within its own organization`);
}

/** Convenience boolean wrapper for call sites that don't need the reason (e.g. apps/web affordance rendering). */
export function canBool(actor: Actor, action: Action, resource: Resource, context?: AuthContext): boolean {
  return can(actor, action, resource, context).allowed;
}
