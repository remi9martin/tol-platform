// packages/authz/src/actions.ts
//
// the action vocabulary — scoped to exactly the resources that exist
// this pass (Organization, OrganizationMembership, Person, AuditEvent).
// New actions get added here as later days add resources; nothing here
// pre-declares actions for entities that don't exist yet (Passport,
// Lockbox, etc.) — an authority matrix entry for a non-existent resource
// would be unverifiable, not a real permission.
//
// earlier adds P13 RFQ + P14 Deal Room's action vocabulary (Opportunity,
// CapacityProfile, RFQ, DealRoom — Quote/RFQVersion/RFQRecipient/
// DealCondition/DealDecision are authorized through their PARENT
// aggregate, RFQ or DealRoom, never as independent resource types — see
// ADR-0008 for why). No `deal.open` action — opening a deal room
// is a side effect of a successful `rfq.select_quote` call (one
// transaction, one can() check), not a separately user-invoked action.

import type { DisclosureClass, PersonaRole } from "./roles.js";

export const ACTIONS = [
  "organization.read",
  "organization.list",
  "organization.update",
  "membership.read",
  "membership.list",
  "membership.create",
  "membership.update_role",
  "membership.update_status",
  "person.read",
  "person.update",
  "audit.read",
  // ---- earlier: P13 RFQ + P14 Deal Room ----
  "opportunity.create",
  "opportunity.read",
  "opportunity.list",
  // earlier addendum (P7): VolumeSlice is a sub-resource of Opportunity,
  // authorized through this ONE new action — same "sub-objects through
  // their parent aggregate" precedent as RFQVersion/Quote/DealCondition
  // through RFQ/DealRoom (D8) and Fact/Evidence through Passport (D11).
  // Granted to the exact same role set as opportunity.create (the
  // opportunity's owner maintains its own volume breakdown) — see
  // matrix.ts's own comment at each grant site.
  "opportunity.update",
  "capacity.create",
  "capacity.read",
  "capacity.list",
  "rfq.create",
  "rfq.read",
  "rfq.list",
  "rfq.decline",
  "rfq.submit_quote",
  "rfq.withdraw_quote",
  "rfq.select_quote",
  "deal.read",
  "deal.list",
  "deal.post_condition",
  "deal.resolve_condition",
  "deal.record_decision",
  // ---- earlier: Lockbox (P9) ----
  // Four actions, matching the earlier brief's own scope exactly (a richer
  // commit/freeze/dispute action set is modeled in @tol/domain's state
  // machine for canonical completeness but has no authorized action yet
  // — see lockbox-states.ts's header comment). "read_receipt" (proof-of-
  // existence: hash/version/sealed-date/signature) is DELIBERATELY a
  // separate, narrower action from ever reading the sealed CONTENTS —
  // there is no "lockbox.read_contents" action at all; the only way
  // plaintext is ever disclosed is as the direct response of a successful
  // "lockbox.release" call (ADR-0009), never a separate read path.
  "lockbox.seal",
  "lockbox.read_receipt",
  "lockbox.withdraw",
  "lockbox.release",
  // ---- earlier: Attribution (P10) ----
  // the spec personas grounded per-action in matrix.ts's own comments.
  // "claim.list" (not literally named by this day's build instruction,
  // which named 4 actions) added for consistency with every OTHER
  // multi-instance resource in this schema (opportunity/capacity/rfq/deal
  // all pair .read with .list) — see matrix.ts's header comment.
  "claim.create",
  "claim.read",
  "claim.list",
  "claim.dispute",
  "claim.decide",
  // ---- earlier: P6 Passport + P5 Marketplace ----
  // Fact/Evidence are authorized through their PARENT Passport aggregate
  // (passport.update covers adding/updating both) — same "sub-objects
  // authorized through their parent, never as independent resource
  // types" precedent as RFQVersion/Quote/DealCondition (ADR-0008)
  // and ClaimEvidence/ClaimDecision (D10). "passport.verify" is the
  // reviewer step (READY -> VERIFIED) — Journey B's readiness-review
  // authority, the Passport analog of claim.decide.
  "passport.create",
  "passport.read",
  "passport.list",
  "passport.update",
  "passport.verify",
  // the spec verbatim: "Members can see market depth, categories of
  // capacity and anonymized opportunity inventory." A DELIBERATELY
  // DIFFERENT, broader-granted action from opportunity.read/
  // capacity.read (which stay exactly as narrowly-granted as earlier left
  // them, gating the FULL, unredacted record) — *_browse_market is the
  // "any platform member sees a REDACTED card" capability p.1 describes
  // as a blanket, marketplace-wide feature, not a per-role privilege.
  // Field-level redaction for non-owner viewers is packages/authz's
  // EXISTING fieldPolicy()/redactFields() mechanism (earlier), applied by
  // apps/api's marketplace mapper (this stage) — this action only answers
  // "may this actor browse the market at all" (yes, for everyone with an
  // active membership), never "which fields" (that's fieldPolicy()'s
  // job, checked separately, same division of labor as
  // organization.read + redactFields() already established earlier).
  "opportunity.browse_market",
  "capacity.browse_market",
  // ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
  // the spec/p.20 name no explicit action vocabulary for triggering/
  // reading a match evaluation (unlike p.4's persona table, which DOES
  // name concrete actions for other resources) — "matching.evaluate"/
  // "match.read" follow this codebase's own `resource.action` naming
  // convention (matching capacity.create/opportunity.read/claim.decide
  // etc.), the same "documented inference, not scope-verbatim" discipline
  // as several other earlier naming calls (ADR-0012). "match.list"
  // (not literally named either) is added for the SAME consistency
  // reason claim.list was in earlier: every other multi-instance resource
  // in this schema pairs .read with .list (opportunity/capacity/rfq/
  // deal/claim/passport all do) — see that section's header comment.
  // MatchResult is a genuinely TWO-SIDED resource, same shape as
  // RFQ/DealRoom (D8): "ownerOrgId" for authz purposes is always the
  // underlying Opportunity's owner (the merchant) — the provider side
  // reads through `participantActions`, verified by the caller (this stage)
  // confirming the MatchResult's capacityId belongs to their own org,
  // the exact same mechanism as rfq.read/deal.read for
  // ACQUIRER_PROVIDER_USER.
  "matching.evaluate",
  "match.read",
  "match.list",
  // ---- earlier: Economics (P15) ----
  // the spec names no explicit action vocabulary (unlike p.4's persona
  // table for other resources) — "schedule.*"/"economics.*"/"ledger.*"
  // follow this codebase's own `resource.action` naming convention, same
  // "documented inference, not scope-verbatim" discipline as the
  // matching.*/match.* naming (ADR-0012). Three resource types,
  // three action families:
  //   schedule.*  — CommissionSchedule (the split rule: read/list/manage,
  //                 "manage" covers create+activate+supersede+retire as
  //                 one action, matching this schema's own "a schedule
  //                 change is a whole new version, never a partial
  //                 field edit" precedent — no separate schedule.create/
  //                 schedule.update the way opportunity.create/.update
  //                 are split, because there IS no in-place update here).
  //   economics.* — RevenueEvent (read/list/record — "record" is the
  //                 money-in fact, deliberately separate from "manage"
  //                 a schedule's split rules).
  //   ledger.*    — CommissionAccrual (the traceable ledger itself:
  //                 read/list, plus two real mutations —
  //                 "record_payment" writes a CommissionPayment + its
  //                 PAYMENT-type ledger rows, "adjust" writes an
  //                 ADJUSTMENT/REVERSAL row — kept as two separate
  //                 actions rather than one generic "ledger.write"
  //                 because p.4's own "no rate editing without
  //                 authority" ceiling for FINANCE_OPERATOR reads
  //                 naturally as "may record real payouts and
  //                 corrections, may not redefine the split itself" —
  //                 see matrix.ts's own comment on that role).
  // CommissionComponent/CommissionPayment are authorized through their
  // PARENT aggregate (schedule.manage covers a schedule's components;
  // ledger.record_payment covers the CommissionPayment a payment action
  // creates) — same "sub-objects through their parent, never independent
  // resource types" precedent as RFQVersion/Quote (D8), ClaimEvidence/
  // ClaimDecision (D10), Fact/Evidence (D11).
  "schedule.read",
  "schedule.list",
  "schedule.manage",
  "economics.read",
  "economics.list",
  "economics.record",
  "ledger.read",
  "ledger.list",
  "ledger.record_payment",
  "ledger.adjust",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * The authenticated request context authz decisions are made against.
 * organizationId/role are null when the actor has no active
 * OrganizationMembership selected for this session (e.g. a brand-new
 * user who hasn't been invited anywhere yet) — such an actor can never
 * pass a same-org check and is only ever granted actions a role-less
 * actor is explicitly allowed (none, in the earlier matrix).
 */
export interface Actor {
  userId: string;
  organizationId: string | null;
  role: PersonaRole | null;
  membershipId: string | null;
}

export interface Resource {
  type:
    | "organization"
    | "membership"
    | "person"
    | "audit_event"
    // ---- earlier ----
    | "opportunity"
    | "capacity_profile"
    | "rfq"
    | "deal_room"
    // ---- earlier ----
    | "lockbox"
    // ---- earlier ----
    | "claim"
    // ---- earlier ----
    | "passport"
    // ---- earlier ----
    | "match_result"
    // ---- earlier ----
    | "commission_schedule"
    | "revenue_event"
    | "commission_accrual";
  id?: string;
  /**
   * The org this resource is scoped by/belongs to. This is what the
   * tenant-isolation check in can() compares against actor.organizationId
   * — the P4 gate's entire mechanism is this one comparison plus the
   * cross-org allowlist in matrix.ts. For DealRoom specifically this is
   * ALWAYS `merchantOrgId` (the underlying Opportunity's owner) — a deal
   * room is inherently a joint merchant+provider resource, but Resource
   * only has room for one ownerOrgId; the provider side is authorized
   * through `AuthContext.isParticipant` below instead of a second
   * ownerOrgId (ADR-0008).
   *
   * the `commission_accrual` resource is a DELIBERATE DEPARTURE from
   * that DealRoom precedent, not an extension of it: a `CommissionAccrual`
   * has no legitimate "plain same-org owner" at all, even though it FKs
   * to a DealRoom (whose own ownerOrgId is the merchant). The deal's
   * merchant org is NOT automatically entitled to see the internal
   * commission split between the platform and its contributor just
   * because the underlying deal is the merchant's own — the spec's own
   * "cannot inspect private competing records" / "no rate editing
   * without authority" framing treats economics as MORE restricted than
   * ordinary deal visibility, not equally open. apps/api's economics
   * service (this stage) MUST therefore always pass `ownerOrgId: null` when
   * calling `can()` for `ledger.read`/`ledger.list`/`economics.read`/
   * `economics.list`/`schedule.read`/`schedule.list` — this structurally
   * forces every access through EITHER `crossOrgActions` (PLATFORM_OWNER/
   * FINANCE_OPERATOR/AUDITOR_READONLY — the named oversight roles) OR a
   * freshly-verified `AuthContext.isParticipant` (a party checking
   * `recipientOrgId === actor.organizationId` on the SPECIFIC accrual
   * being read — CONTRIBUTOR_AGENT/MERCHANT_PSP_USER/ACQUIRER_PROVIDER_
   * USER). Passing the deal's real `merchantOrgId` here instead would be
   * a real security bug: `ledger.read` is in these three roles'
   * `allowedActions` (required for the participant path to even be
   * reachable — matrix.ts's own structural invariant), so an
   * `ownerOrgId` that happened to equal the merchant's own org would
   * silently grant that merchant BLANKET visibility into the whole
   * ledger — every recipient's split, not just its own — via the
   * ordinary same-org fallback, defeating the participant check
   * entirely. See ADR-0013.
   */
  ownerOrgId: string | null;
  privacyClass?: DisclosureClass;
}

export interface AuthContext {
  /**
   * True when the resource IS the actor's own record (e.g. a User
   * reading/updating their own Person profile, or membership update
   * limited to a user acting on their own membership row). Some rules
   * grant access to "self" that they don't grant generally.
   */
  isSelf?: boolean;
  /**
   * True when the actor's organization is a NAMED PARTICIPANT of this
   * SPECIFIC resource INSTANCE, verified by the caller via a real
   * repository lookup BEFORE calling can() — an RFQRecipient row (for
   * `rfq.*` actions) or a DealRoomParticipant row (for `deal.*` actions).
   * can() itself has no database access and can never compute this; it
   * only trusts what the caller asserts, the same way `isSelf` works.
   *
   * This is DIFFERENT from `crossOrgActions` (matrix.ts): crossOrgActions
   * grants a role access to ANY org's resource, unconditionally — broad,
   * reserved for platform/operator/compliance/auditor roles.
   * `participantActions` (this file's RoleGrant addition) grants access
   * to ONE resource instance the actor's org is verifiably, individually
   * named on — narrow, for MERCHANT_PSP_USER/ACQUIRER_PROVIDER_USER
   * acting on their own RFQs/deals when they are not the resource's
   * `ownerOrgId` (e.g. an invited provider reading/quoting a merchant-
   * owned RFQ). Introduced in earlier because the single-owner
   * Organization/Membership/Person/AuditEvent resources never needed a
   * second, non-owning legitimate party — RFQ and DealRoom are the
   * first two-sided resources this schema has. See ADR-0008.
   *
   * earlier reuses this SAME mechanism for `claim.dispute`: a challenger
   * org is essentially never the claim's own `claimantOrgId` (disputing
   * your own claim is a withdrawal, not a dispute) — the service layer
   * computes `isParticipant` by verifying, via a real repository lookup,
   * that the challenger org has STANDING (its own competing Claim on the
   * same subjectOrgId/opportunityId, or is itself the claim's
   * subjectOrgId) before ever calling `can()`. See ADR-0010.
   *
   * earlier reuses it a third way, for `ledger.read`/`ledger.list`: a
   * CommissionAccrual's structural `ownerOrgId` (for the same-org check
   * above) is the underlying DealRoom's merchant org — but the actual
   * RECIPIENT of a ledger entry (a contributor, or either deal party
   * acting as one) is a DIFFERENT org entirely, named on
   * `CommissionAccrual.recipientOrgId`. `CONTRIBUTOR_AGENT`/
   * `MERCHANT_PSP_USER`/`ACQUIRER_PROVIDER_USER` see ONLY their own
   * accruals this way — the spec's own "See own claims/economics;
   * cannot inspect private competing records" — the service layer
   * verifies `recipientOrgId === actor.organizationId` before setting
   * `isParticipant`, never a blanket grant to browse every recipient's
   * ledger. See ADR-0013.
   */
  isParticipant?: boolean;
}

export interface AuthDecision {
  allowed: boolean;
  /** Always populated, including on allow — makes every decision auditable/debuggable, not just denials. */
  reason: string;
}
