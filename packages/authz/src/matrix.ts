// packages/authz/src/matrix.ts
//
// The P2 "authority matrix" gate (the spec: "Authority matrix
// complete"). Grounded in the spec's per-persona "Primary job" / "Special
// authority" columns, translated into the concrete action set (see
// actions.ts — only actions for resources that actually exist this pass).
// DENY BY DEFAULT: a (role, action) pair with no entry here, or an action
// missing from a role's allowedActions set, is denied — can.ts never
// falls back to "allow" when a lookup misses.

import type { Action } from "./actions.js";
import type { PersonaRole } from "./roles.js";
import { PERSONA_ROLES } from "./roles.js";

export interface RoleGrant {
  /** Actions this role may perform at all. Anything not listed is denied — no exceptions. */
  allowedActions: ReadonlySet<Action>;
  /**
   * Subset of allowedActions where the same-organization restriction is
   * WAIVED — i.e. this role may act across organizations for these
   * actions (the spec: "Platform operators may access sensitive content
   * only when their role permits it"). Any allowed action NOT in this set
   * requires resource.ownerOrgId === actor.organizationId (or a verified
   * `participantActions` grant below).
   */
  crossOrgActions: ReadonlySet<Action>;
  /**
   * earlier addition (ADR-0008). Subset of allowedActions where a
   * VERIFIED, INSTANCE-SPECIFIC participant relationship (an
   * RFQRecipient or DealRoomParticipant row, checked by the caller and
   * passed as `context.isParticipant`) substitutes for the ownerOrgId
   * match — narrower than crossOrgActions (which grants access to EVERY
   * org's resources, not just the ones the actor's org is individually
   * named on). Required on every entry below (not optional) for the same
   * reason crossOrgActions is required: an omitted field reading as "no
   * grant" by TypeScript's structural typing would be indistinguishable
   * from a deliberately-empty set, and this matrix's whole design
   * philosophy is that every grant is explicit.
   */
  participantActions: ReadonlySet<Action>;
  /**
   * True only for roles allowed to update ANOTHER member's Person record
   * within their own org (not just their own). p.4: Partnership Lead
   * maintains "relationship provenance" contacts; Platform Owner has
   * global authority. Every other role may only ever update its own
   * Person record (context.isSelf) — see can.ts's person.update rule.
   */
  managesOtherPeopleInOwnOrg: boolean;
}

const set = <T>(...items: T[]): ReadonlySet<T> => new Set(items);

export const AUTHORITY_MATRIX: Record<PersonaRole, RoleGrant> = {
  // p.4: "Own product configuration and network policy... Global
  // settings; no silent record mutation" — broadest authority, every
  // action, cross-org, and the ONLY role permitted to change another
  // member's role (membership.update_role).
  PLATFORM_OWNER: {
    allowedActions: set<Action>(
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
      "opportunity.create",
      "opportunity.update",
      "opportunity.read",
      "opportunity.list",
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
      // ---- earlier: Lockbox ----
      "lockbox.seal",
      "lockbox.read_receipt",
      "lockbox.withdraw",
      "lockbox.release",
      // ---- earlier: Attribution — p.18 anti-gaming rule: "Platform-owned/
      // direct relationships can be seeded with documented effective
      // dates to prevent retroactive squatting" — the platform's OWN org
      // needs claim.create/dispute (own-org, see crossOrgActions below
      // for why they're excluded there) to exercise exactly that
      // defense. claim.decide is this role's share of the Journey A
      // reviewer authority (broadest-authority pattern, matching every
      // other resource this role can cross-org-decide/release).
      "claim.create",
      "claim.read",
      "claim.list",
      "claim.dispute",
      "claim.decide",
      // ---- earlier: P6 Passport + P5 Marketplace — broadest-authority
      // pattern extended, matching every other resource. Platform Owner
      // both maintains its own org's Passport (own-org create/read/
      // update, symmetric to every other org-affiliated role) AND
      // reviews/verifies every org's Passport cross-org (see
      // crossOrgActions below) — the same dual own-org-actor +
      // cross-org-overseer shape this role already has for Lockbox
      // (seals its own, releases everyone's) and Claims (files its own
      // anti-squatting defenses, decides everyone's).
      "passport.create",
      "passport.read",
      "passport.list",
      "passport.update",
      "passport.verify",
      "opportunity.browse_market",
      "capacity.browse_market",
      // ---- earlier: Matching — broadest-authority pattern extended once
      // more: this role both triggers matching for its own org's
      // opportunities (own-org matching.evaluate, symmetric to
      // opportunity.create) AND cross-org evaluates/reads every org's
      // matches (see crossOrgActions below), the same dual own-org-actor
      // + cross-org-overseer shape as Lockbox/Claims/Passport above.
      "matching.evaluate",
      "match.read",
      "match.list",
      // ---- earlier: Economics — broadest-authority pattern extended a
      // final time: this role holds every economics action, INCLUDING
      // schedule.manage (rate-setting authority) — the one action
      // FINANCE_OPERATOR is explicitly denied (p.4: "no rate editing
      // without authority" — Platform Owner IS that authority). All ten
      // actions are cross-org (see crossOrgActions below), matching this
      // role's consistent pattern for every other resource.
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
    ),
    crossOrgActions: set<Action>(
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
      "opportunity.create",
      "opportunity.update",
      "opportunity.read",
      "opportunity.list",
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
      // ---- earlier: Lockbox — NOTE lockbox.withdraw is deliberately
      // EXCLUDED here (unlike every other action, which is fully
      // cross-org for this role). The earlier brief and ADR-0001
      // are explicit: "only the sealer org can withdraw" — even Platform
      // Owner's otherwise-broadest authority does not override this, so
      // the plain same-org ownerOrgId path (sealerOrgId) is the only way
      // ANY role ever withdraws a Lockbox, including this one. seal/
      // read_receipt/release stay cross-org, matching this role's
      // existing "broadest authority" pattern for everything else. ----
      "lockbox.seal",
      "lockbox.read_receipt",
      "lockbox.release",
      // earlier: read/list/decide are cross-org (same broadest-authority
      // pattern as everything else above) — create/dispute deliberately
      // STAY OUT of crossOrgActions, the same "own-org even for Platform
      // Owner" carve-out shape as lockbox.withdraw above: filing or
      // disputing a claim is inherently an act taken AS a specific
      // claimant/challenger org (this role's own platform org, per the
      // anti-squatting rule cited above), never on behalf of an
      // arbitrary other org.
      "claim.read",
      "claim.list",
      "claim.decide",
      // earlier: read/list/verify are cross-org (broadest-authority
      // pattern) — create/update deliberately STAY OUT of
      // crossOrgActions, the SAME "own-org even for Platform Owner"
      // carve-out as lockbox.withdraw / claim.create above: maintaining
      // a Passport's factual content is inherently an act taken AS that
      // org, never on behalf of an arbitrary other one. Market browsing
      // is universally cross-org — see actions.ts's own comment on why
      // *_browse_market is a blanket "any member" capability, not a
      // graduated privilege.
      "passport.read",
      "passport.list",
      "passport.verify",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: cross-org (broadest-authority pattern, matching every
      // other resource this role can cross-org-decide/release).
      "matching.evaluate",
      "match.read",
      "match.list",
      // earlier: cross-org, all ten, including schedule.manage — see the
      // allowedActions block above for why this role alone holds it.
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
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: true,
  },

  // p.4: "Curate supply/demand, resolve next steps... Create invite
  // sets; limited override with reason" — cross-org read + membership
  // operations, but NOT role grants (update_role stays Platform-Owner-
  // only) and NOT organization/person profile edits.
  // earlier additions grounded in the spec ("7-day MVP || Invite-only
  // operator-assisted market") + p.4's own "Create invite sets; limited
  // override with reason": in this operator-ASSISTED model, the operator
  // — not the merchant — creates the RFQ/invite-set (rfq.create), and
  // broad cross-org read visibility across opportunity/capacity/rfq/deal
  // lets them curate the loop end to end. "Limited override with reason"
  // maps to deal.post_condition/resolve_condition/record_decision (every
  // DealDecision requires a `reason`, structurally). Deliberately NOT
  // granted: opportunity.create (submitting the underlying opportunity is
  // the merchant's own act), capacity.create (the provider's own act),
  // or rfq.decline/submit_quote/withdraw_quote/select_quote (the
  // operator facilitates, it never impersonates a counterparty's own
  // commercial commitment or selection).
  MARKETPLACE_OPERATOR: {
    allowedActions: set<Action>(
      "organization.read",
      "organization.list",
      "membership.read",
      "membership.list",
      "membership.create",
      "membership.update_status",
      "person.read",
      "audit.read",
      "opportunity.read",
      "opportunity.list",
      "capacity.read",
      "capacity.list",
      "rfq.create",
      "rfq.read",
      "rfq.list",
      "deal.read",
      "deal.list",
      "deal.post_condition",
      "deal.resolve_condition",
      "deal.record_decision",
      // ---- earlier: Lockbox — the operator side of the escrowed/threshold
      // release model (ADR-0001/ADR-0009): this is the role that
      // actually TRIGGERS a release (the crypto-layer 2-of-3 Shamir
      // threshold is the deeper enforcement; this authz grant is "who may
      // even attempt it" — matches this role's existing "limited override
      // with reason" authority, p.4). NOT granted lockbox.seal/withdraw —
      // the operator facilitates release under controlled conditions, it
      // never impersonates a sealer's own act of sealing or withdrawing,
      // same reasoning as this role's existing omission of
      // rfq.decline/submit_quote/select_quote. read_receipt included for
      // the same oversight-visibility reason as its existing rfq.read/
      // deal.read cross-org grants. ----
      "lockbox.read_receipt",
      "lockbox.release",
      // earlier: Journey A's own named reviewer ("operator verifies
      // relationship... claim becomes VERIFIED, PARTIAL, DISPUTED or
      // REJECTED") — cross-org read/list/decide, matching this role's
      // existing "curate, resolve next steps" authority. Deliberately NOT
      // granted claim.create/dispute — the operator facilitates/reviews,
      // it never files or challenges a claim as if it were a claimant
      // counterparty, same reasoning as this role's existing omission of
      // rfq.decline/submit_quote/select_quote and lockbox.seal/withdraw.
      "claim.read",
      "claim.list",
      "claim.decide",
      // earlier: p.4's own "Curate supply/demand" is close to a verbatim
      // description of P5 Marketplace curation — cross-org
      // opportunity/capacity.browse_market matches this role's existing
      // opportunity.read/capacity.read cross-org grants (it already sees
      // full records; browse_market is additionally how it sees the
      // SAME data through the redacted card view apps/web's /app/market
      // renders). passport.read/list/verify: Journey B's readiness
      // review is squarely this role's "resolve next steps" authority,
      // same reviewer-tier shape as its existing claim.decide/
      // lockbox.release grants. No passport.create/update — the
      // operator facilitates/reviews, it never authors another org's
      // Passport content, matching this role's consistent "reviewer, not
      // party" ceiling across every earlier phases resource.
      "passport.read",
      "passport.list",
      "passport.verify",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: p.4's OWN literal words — "Create invite sets" — cannot
      // happen without first seeing ranked/eligible matches; this is the
      // PRIMARY persona the spec/p.20's matching engine exists to
      // serve. Cross-org evaluate + read/list, matching this role's
      // existing "curate, resolve next steps" authority across every
      // other resource above.
      "matching.evaluate",
      "match.read",
      "match.list",
    ),
    crossOrgActions: set<Action>(
      "organization.read",
      "organization.list",
      "membership.read",
      "membership.list",
      "membership.create",
      "membership.update_status",
      "person.read",
      "audit.read",
      "opportunity.read",
      "opportunity.list",
      "capacity.read",
      "capacity.list",
      "rfq.create",
      "rfq.read",
      "rfq.list",
      "deal.read",
      "deal.list",
      "deal.post_condition",
      "deal.resolve_condition",
      "deal.record_decision",
      "lockbox.read_receipt",
      "lockbox.release",
      "claim.read",
      "claim.list",
      "claim.decide",
      "passport.read",
      "passport.list",
      "passport.verify",
      "opportunity.browse_market",
      "capacity.browse_market",
      "matching.evaluate",
      "match.read",
      "match.list",
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Recruit and maintain provider relationships... Capacity
  // profile updates; relationship provenance" — own-org only; can
  // maintain OTHER people's contact records in its own org (relationship
  // provenance is inherently about other parties' contacts).
  // earlier: p.4 "Capacity profile updates" is an internal-facilitation
  // capability exercised ON BEHALF OF providers this role supports — the
  // same cross-org shape as their existing relationship-provenance
  // authority, not an own-org-only grant.
  // earlier: p.4's own "relationship provenance" SPECIAL AUTHORITY column
  // (not just the primary-job description) is the most direct scope
  // citation of any persona for Attribution — this role reviews/decides
  // claims, the SAME cross-org authority shape as its existing
  // capacity.* grants. Deliberately NOT granted claim.create/dispute
  // (same "reviewer, not claimant" reasoning as MARKETPLACE_OPERATOR) —
  // "recruit and maintain provider relationships" is this role acting
  // FOR the platform, not AS a claimant counterparty org.
  PARTNERSHIP_LEAD: {
    allowedActions: set<Action>(
      "organization.read",
      "membership.read",
      "membership.list",
      "person.read",
      "person.update",
      "capacity.create",
      "capacity.read",
      "capacity.list",
      "claim.read",
      "claim.list",
      "claim.decide",
      // earlier: cross-org read/list, matching this role's existing
      // capacity.*/claim.* cross-org pattern — "relationship provenance"
      // extends naturally to reading a Passport's provenance trail.
      // Deliberately NO passport.verify (unlike MARKETPLACE_OPERATOR/
      // COMPLIANCE_REVIEWER/PLATFORM_OWNER) — Partnership Lead's own p.4
      // job is provider relationships/claims, not readiness review; a
      // narrower cut than its claim.decide grant, not an oversight.
      "passport.read",
      "passport.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: "maintain provider relationships" naturally extends to
      // seeing how those recruited providers actually perform in
      // matching — cross-org read/list, matching this role's existing
      // capacity.*/claim.* cross-org pattern. Deliberately NO
      // matching.evaluate (unlike MARKETPLACE_OPERATOR) — triggering a
      // match run is the curation/invite-set authority p.4 assigns
      // specifically to Marketplace Operator, not this role's own job.
      "match.read",
      "match.list",
    ),
    crossOrgActions: set<Action>(
      "capacity.create",
      "capacity.read",
      "capacity.list",
      "claim.read",
      "claim.list",
      "claim.decide",
      "passport.read",
      "passport.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      "match.read",
      "match.list",
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: true,
  },

  // p.4: "Normalize merchant/PSP evidence... Mark evidence
  // complete/incomplete; cannot approve provider" — read-oriented, own
  // org only. Evidence itself isn't an earlier resource yet.
  // earlier: "Normalize merchant/PSP evidence" is a cross-org reviewing
  // function (an internal analyst reviews ANY merchant's opportunity
  // readiness, not just their own org's) — read-only, matching this
  // role's existing "cannot approve provider" ceiling (no writes).
  // earlier: "Normalize merchant/PSP evidence" extends naturally to claim
  // evidence too — cross-org READ only (claim.read/list), matching this
  // role's existing "cannot approve provider" ceiling: no claim.decide
  // (this role reviews/normalizes evidence, it does not render the
  // attribution decision itself — the same "read but not the final
  // approver" shape p.4 already assigns it for opportunities).
  UNDERWRITING_ANALYST: {
    allowedActions: set<Action>(
      "organization.read",
      "person.read",
      "opportunity.read",
      "opportunity.list",
      "claim.read",
      "claim.list",
      // earlier: p.4's OWN literal words — "Normalize merchant/PSP
      // evidence... Mark evidence complete/incomplete" — is about as
      // direct a scope citation for reading Passport readiness as any
      // persona gets. Cross-org read/list, matching this role's existing
      // opportunity.*/claim.* pattern. Deliberately NO passport.verify —
      // "cannot approve provider" (p.4) is this role's own explicit
      // ceiling, the same "reviews/normalizes, does not render the
      // final decision" shape claim.decide's own comment already
      // established for this exact role in earlier.
      "passport.read",
      "passport.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: this role's evidence-normalization work directly feeds
      // the EVIDENCE_LICENSE eligibility rule (packages/matching) — a
      // Passport it's reviewing readiness for is the exact input a
      // matching run gates on. Cross-org read/list, matching this
      // role's existing opportunity.*/passport.* pattern. No
      // matching.evaluate — "cannot approve provider" (p.4) is this
      // role's own explicit ceiling, same "reviews/normalizes, does not
      // trigger/decide" shape as its existing claim.read-only grant.
      "match.read",
      "match.list",
    ),
    crossOrgActions: set<Action>(
      "opportunity.read",
      "opportunity.list",
      "claim.read",
      "claim.list",
      "passport.read",
      "passport.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      "match.read",
      "match.list",
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Review restricted claims and exceptions... Approve
  // templates/disclosures; place holds" — a compliance function
  // necessarily needs cross-org READ visibility (including audit) even
  // though earlier has no claims/disclosures to approve yet.
  // earlier: broad cross-org READ visibility for compliance oversight
  // (reviewing disclosure packets, deal exceptions) — matches this
  // role's existing audit.read cross-org grant. No writes this pass:
  // "Approve templates/disclosures; place holds" (p.4) isn't a concrete
  // earlier action (no DisclosureGrant/hold entity exists yet).
  COMPLIANCE_REVIEWER: {
    allowedActions: set<Action>(
      "organization.read",
      "organization.list",
      "membership.read",
      "membership.list",
      "person.read",
      "audit.read",
      "opportunity.read",
      "opportunity.list",
      "capacity.read",
      "capacity.list",
      "rfq.read",
      "rfq.list",
      "deal.read",
      "deal.list",
      // earlier: compliance oversight visibility, matching its existing
      // cross-org READ pattern for everything else — no seal/withdraw/
      // release authority (this role approves/holds, per p.4, it doesn't
      // act as a sealer or trigger release itself this pass).
      "lockbox.read_receipt",
      // earlier: p.4's OWN literal words — "Review restricted claims and
      // exceptions" — is about as direct a scope citation for
      // claim.decide as any persona gets. This role is a THIRD plausible
      // reviewer alongside MARKETPLACE_OPERATOR/PARTNERSHIP_LEAD,
      // specifically for the RESTRICTED-tier/exception cases its own job
      // description names. Deliberately NOT granted claim.create/dispute
      // — same "reviewer, not claimant" reasoning as every other
      // internal/oversight role above.
      "claim.read",
      "claim.list",
      "claim.decide",
      // earlier: p.4's OWN literal words — "Review restricted claims and
      // exceptions" — extends to Passport review the same direct way it
      // already grounded this role's claim.decide grant in earlier. A
      // THIRD plausible passport.verify reviewer alongside
      // MARKETPLACE_OPERATOR/PLATFORM_OWNER, specifically for the
      // RESTRICTED-tier/exception cases p.4 names. Market browsing
      // matches this role's existing cross-org read pattern.
      "passport.read",
      "passport.list",
      "passport.verify",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: p.4's OWN literal words — "Review restricted claims and
      // exceptions" — extends to matching review the same direct way it
      // already grounded this role's claim.decide/passport.verify
      // grants. Cross-org read/list. No matching.evaluate — this role
      // reviews/approves, per p.4, it doesn't curate/trigger, same
      // reviewer-not-operator ceiling as its passport.verify-but-not-
      // update pattern.
      "match.read",
      "match.list",
    ),
    crossOrgActions: set<Action>(
      "organization.read",
      "organization.list",
      "membership.read",
      "membership.list",
      "person.read",
      "audit.read",
      "opportunity.read",
      "opportunity.list",
      "capacity.read",
      "capacity.list",
      "rfq.read",
      "rfq.list",
      "deal.read",
      "deal.list",
      "lockbox.read_receipt",
      "claim.read",
      "claim.list",
      "claim.decide",
      "passport.read",
      "passport.list",
      "passport.verify",
      "opportunity.browse_market",
      "capacity.browse_market",
      "match.read",
      "match.list",
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Reconcile attribution and economics... Commission status;
  // payout evidence; no rate editing without authority" — economics
  // doesn't exist yet; own-org read only in earlier.
  // earlier: no changes — Economics (p.23) is P15 scope, not built this
  // day; this role's own domain (commission status, payout evidence)
  // doesn't exist yet. participantActions added (empty) only because the
  // field is now required on every RoleGrant.
  // earlier: p.4's OWN literal words — "Reconcile ATTRIBUTION and
  // economics" — names this gate directly. Cross-org read/list only (no
  // claim.decide — this role reconciles ALREADY-decided attribution
  // against economics, matching "no rate editing without authority"; it
  // does not render the attribution decision itself, that stays with
  // MARKETPLACE_OPERATOR/PARTNERSHIP_LEAD/COMPLIANCE_REVIEWER/
  // PLATFORM_OWNER).
  FINANCE_OPERATOR: {
    allowedActions: set<Action>(
      "organization.read",
      "membership.read",
      "membership.list",
      "claim.read",
      "claim.list",
      // earlier: no passport.* grant — no p.4 scope tie to Passport review
      // for this role (its domain is economics/reconciliation, not
      // readiness). Market browsing IS granted — the spec's "Members
      // can see market depth" is a blanket platform-wide capability, not
      // graduated by role; no scope reason excludes Finance Operator
      // specifically from basic, always-redacted market visibility.
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: deliberately NO matching.evaluate/match.read/match.list —
      // same "no p.4 scope tie" reasoning as the missing passport.*
      // grant above. This role's domain is economics/reconciliation
      // (P15, not yet built); matching feeds INTO a future economics
      // picture but this role's own job description names nothing about
      // reviewing match results themselves. Revisit once P15 exists and
      // names a real dependency.
      // earlier: P15 now exists, and this is the MOST DIRECT scope citation
      // any earlier grant gets — p.4's own literal words, verbatim, for
      // THIS role: "Reconcile attribution and economics... Commission
      // status; payout evidence; no rate editing without authority."
      // schedule.read/list (reconcile against the split rule, read-only),
      // economics.read/list/record (the revenue side of reconciliation —
      // "commission status" needs real revenue facts on file), ledger.
      // read/list (the ledger IS the reconciliation surface), ledger.
      // record_payment ("payout evidence" — literally this), ledger.
      // adjust (a correction is a controlled, authorized override this
      // role's job exists to make). Deliberately, explicitly NOT granted:
      // schedule.manage — "no rate editing without authority" (p.4,
      // verbatim) is this role's own stated ceiling; only PLATFORM_OWNER
      // holds schedule.manage. Cross-org (see crossOrgActions below) —
      // reconciliation spans every deal, not just this org's own.
      "schedule.read",
      "schedule.list",
      "economics.read",
      "economics.list",
      "economics.record",
      "ledger.read",
      "ledger.list",
      "ledger.record_payment",
      "ledger.adjust",
    ),
    crossOrgActions: set<Action>(
      "claim.read",
      "claim.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      "schedule.read",
      "schedule.list",
      "economics.read",
      "economics.list",
      "economics.record",
      "ledger.read",
      "ledger.list",
      "ledger.record_payment",
      "ledger.adjust",
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Deposit relationships and opportunities... See own
  // claims/economics; cannot inspect private competing records" —
  // deliberately narrow: own org read, own person only.
  // earlier: p.4 "Deposit relationships and opportunities" — own-org only,
  // matching this role's existing deliberately-narrow ceiling.
  // earlier: this is the scope's OWN named persona for sealing (Journey A,
  // p.5: "Contributor creates a RelationshipClaim... creates Lockbox
  // payload if sensitive... receives timestamp/hash receipt") —
  // "Deposit relationships" IS "seal a Lockbox". Own-org only (no
  // crossOrgActions, matching this role's existing ceiling): a
  // contributor seals/withdraws its OWN sealed relationships, never
  // another org's. No lockbox.release — matches this role's existing
  // "cannot inspect private competing records" ceiling; release is
  // operator-triggered under the escrow model (ADR-0001/ADR-0009), a
  // contributor's own seal never unilaterally releases itself.
  // earlier: p.4's OWN literal words — "See own claims... cannot inspect
  // private competing records" — is the scope's most explicit privacy
  // rule for Attribution, and the exact mechanism this build's `can()`
  // already provides for free: claim.create/read/list are own-org only
  // (NOT in crossOrgActions), so this role can only ever see claims where
  // Claim.claimantOrgId === its own organizationId — a competing org's
  // claim about the SAME relationship is structurally invisible, not
  // merely filtered client-side. claim.dispute is granted through
  // `participantActions`, NOT crossOrgActions (see actions.ts's
  // AuthContext.isParticipant comment) — disputing is inherently a
  // cross-org act (challenging SOMEONE ELSE's claim), but a blanket
  // cross-org grant would let any org dispute any claim with zero
  // standing; the service layer (this stage) verifies real standing (an own
  // competing claim on the same subject/opportunity, or being the
  // subjectOrg) before setting isParticipant=true.
  CONTRIBUTOR_AGENT: {
    allowedActions: set<Action>(
      "organization.read",
      "person.read",
      "person.update",
      "opportunity.create",
      "opportunity.update",
      "opportunity.read",
      "opportunity.list",
      "lockbox.seal",
      "lockbox.read_receipt",
      "lockbox.withdraw",
      "claim.create",
      "claim.read",
      "claim.list",
      "claim.dispute",
      // earlier: "Deposit relationships" (p.4) IS building institutional
      // trust state — own-org passport.create/read/update, symmetric to
      // this role's own-org opportunity/claim/lockbox pattern. Market
      // browsing is this role's FIRST-EVER cross-org grant (every other
      // action above is deliberately own-org-only, p.4: "cannot inspect
      // private competing records") — the spec's "Members can see
      // market depth" is explicit that this applies even to the
      // narrowest-scoped persona; the redacted card view is exactly
      // what "cannot inspect private... records" still permits.
      "passport.create",
      "passport.read",
      "passport.update",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: deliberately NO matching.evaluate/match.read/match.list.
      // p.4's own explicit ceiling for this role — "cannot inspect
      // private competing records" — is squarely what a match's
      // per-factor breakdown/eligibility findings would expose about
      // OTHER orgs' capacity/opportunity fit; this role's job (deposit
      // relationships and opportunities, hold attribution claims) has no
      // scope tie to reviewing how its deposited opportunities actually
      // match, matching this role's existing narrow ceiling throughout.
      // earlier: p.4's OWN literal words for THIS role — "See own
      // claims/economics; cannot inspect private competing records" — is
      // the most direct scope citation any persona gets for P15.
      // ledger.read/list ONLY (no schedule.*/economics.* — this role
      // never sees a schedule's full split or a deal's whole revenue
      // picture, only the ledger entries where IT is the recipient),
      // granted via participantActions (below), NOT crossOrgActions —
      // the service layer verifies `recipientOrgId === actor.
      // organizationId` before setting isParticipant, same mechanism as
      // claim.dispute's own standing check (D10), never a blanket grant
      // to browse every recipient's ledger.
      "ledger.read",
      "ledger.list",
    ),
    crossOrgActions: set<Action>("opportunity.browse_market", "capacity.browse_market"),
    participantActions: set<Action>("claim.dispute", "ledger.read", "ledger.list"),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Maintain Passport and submit opportunity... Grant/revoke
  // disclosure before freeze; view own RFQs" — own org profile
  // maintenance included (organization.update was the nearest earlier
  // analog to "maintain our org's record" before Passport existed;
  // earlier adds the real thing — see that section below).
  // earlier: the primary demand-side actor. p.4 "submit opportunity" ->
  // opportunity.create; "view own RFQs" -> rfq.read/list; selecting among
  // submitted quotes is the merchant's own commercial decision ->
  // rfq.select_quote. All own-org — the merchant IS the natural resource
  // owner for its own Opportunity/RFQ/DealRoom (opportunity.ownerOrgId /
  // dealRoom.merchantOrgId), so the standard same-org ownerOrgId check
  // covers this role; no participantActions needed (contrast
  // ACQUIRER_PROVIDER_USER below, which DOES need them). Deliberately NOT
  // granted rfq.create — see MARKETPLACE_OPERATOR's comment on why RFQ
  // creation sits with the operator in this operator-assisted MVP model.
  MERCHANT_PSP_USER: {
    allowedActions: set<Action>(
      "organization.read",
      "organization.update",
      "membership.read",
      "membership.list",
      "person.read",
      "person.update",
      "opportunity.create",
      "opportunity.update",
      "opportunity.read",
      "opportunity.list",
      "rfq.read",
      "rfq.list",
      "rfq.select_quote",
      "deal.read",
      "deal.list",
      "deal.post_condition",
      "deal.resolve_condition",
      "deal.record_decision",
      // earlier: a merchant can also seal/withdraw its own relationship
      // evidence into a Lockbox (scope's LockboxView thesis: "Your
      // relationships are already assets" applies to any org, not only
      // CONTRIBUTOR_AGENT) — own-org only, no lockbox.release (same
      // operator-triggered-release reasoning as every non-operator role).
      "lockbox.seal",
      "lockbox.read_receipt",
      "lockbox.withdraw",
      // earlier: symmetric to CONTRIBUTOR_AGENT — a merchant/PSP can also
      // file/read/dispute claims about relationships relevant to its own
      // opportunities, own-org create/read/list, dispute via
      // participantActions (see CONTRIBUTOR_AGENT's comment for the
      // standing-verification reasoning).
      "claim.create",
      "claim.read",
      "claim.list",
      "claim.dispute",
      // earlier: p.4's OWN literal words, verbatim — "Maintain Passport" —
      // is this role's most direct scope citation of any earlier grant.
      // Own-org create/read/update, matching this role's consistent
      // own-org pattern for everything except market browsing (below).
      "passport.create",
      "passport.read",
      "passport.update",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: `/app/matches/[opportunityId]` (the spec) is squarely
      // "view own [matching results]", the direct extension of this
      // role's own p.4 "view own RFQs" grant one step earlier in the
      // pipeline (matching happens BEFORE the RFQ that invites a
      // provider even exists). Own-org only (NOT crossOrgActions,
      // NOT participantActions) — the merchant IS the natural resource
      // owner (MatchResult's authz ownerOrgId is always the underlying
      // Opportunity's owner, same convention DealRoom already uses), so
      // the standard same-org ownerOrgId check in can() covers this
      // without any extra mechanism. Deliberately NOT granted
      // matching.evaluate — same "operator triggers, merchant views"
      // reasoning as this role's existing omission of rfq.create.
      "match.read",
      "match.list",
      // earlier: symmetric to CONTRIBUTOR_AGENT — a merchant can also be a
      // named CommissionComponent recipient (e.g. a volume-tier rebate),
      // and p.1's general "see your own economics, not the whole
      // network's" framing applies identically regardless of persona.
      // ledger.read/list ONLY, via participantActions — NOT an ordinary
      // own-org grant even though this role IS the underlying deal's
      // ownerOrgId for every OTHER earlier resource, because
      // `commission_accrual`'s own ownerOrgId is always passed as `null`
      // by the service layer (see actions.ts's Resource.ownerOrgId
      // comment) — the merchant sees its OWN accrual entries only, never
      // the whole deal's commission split, by the exact same mechanism
      // as CONTRIBUTOR_AGENT/ACQUIRER_PROVIDER_USER.
      "ledger.read",
      "ledger.list",
    ),
    crossOrgActions: set<Action>("opportunity.browse_market", "capacity.browse_market"),
    participantActions: set<Action>("claim.dispute", "ledger.read", "ledger.list"),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Maintain private capacity and quote invited files... See only
  // invited packets and own history" — symmetric to Merchant/PSP User for
  // the org-level actions, but genuinely DIFFERENT for RFQ/deal actions:
  // a provider is never the resource's ownerOrgId (RFQ.ownerOrgId /
  // dealRoom.merchantOrgId are always the MERCHANT's org) — every
  // rfq.*/deal.* action below is granted through `participantActions`,
  // not crossOrgActions, so the caller (apps/api's rfqs/deals services)
  // MUST verify a real RFQRecipient/DealRoomParticipant row exists before
  // can() will allow it (ADR-0008) — this is p.4's "See only
  // invited packets" made structural, not just a query-side filter.
  // capacity.* stays a normal own-org grant (CapacityProfile.ownerOrgId
  // IS the provider's own org).
  ACQUIRER_PROVIDER_USER: {
    allowedActions: set<Action>(
      "organization.read",
      "organization.update",
      "membership.read",
      "membership.list",
      "person.read",
      "person.update",
      "capacity.create",
      "capacity.read",
      "capacity.list",
      "rfq.read",
      "rfq.list",
      "rfq.decline",
      "rfq.submit_quote",
      "rfq.withdraw_quote",
      "deal.read",
      "deal.list",
      "deal.post_condition",
      "deal.resolve_condition",
      "deal.record_decision",
      // earlier: symmetric to Merchant/PSP User — a provider can seal/
      // withdraw its own relationship evidence, own-org only. No
      // lockbox.release (operator-triggered under the escrow model).
      "lockbox.seal",
      "lockbox.read_receipt",
      "lockbox.withdraw",
      // earlier: symmetric to Merchant/PSP User — a provider can also
      // file/read/dispute claims, own-org create/read/list, dispute via
      // participantActions.
      "claim.create",
      "claim.read",
      "claim.list",
      "claim.dispute",
      // earlier: symmetric to Merchant/PSP User — a provider's
      // institutional trust state is exactly as real as a merchant's
      // (p.1: "Two-sided inventory... Passport" — Passport is not a
      // demand-side-only concept). Own-org create/read/update.
      "passport.create",
      "passport.read",
      "passport.update",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: p.4's OWN "See only invited packets and own history" —
      // a provider's OWN capacity being ranked/found-ineligible is
      // squarely "own history". Granted via participantActions (below),
      // NOT crossOrgActions — same "never the resource's ownerOrgId"
      // shape as this role's existing rfq.read/deal.read grants: a
      // MatchResult's authz ownerOrgId is always the OPPORTUNITY's
      // merchant org, never the provider's, so the caller (the
      // matching service) MUST verify the MatchResult's capacityId
      // actually belongs to this provider's own org before setting
      // context.isParticipant — the exact same mechanism DECISIONS.md
      // D8 established for RFQRecipient/DealRoomParticipant, applied to
      // a new instance-verification shape (capacity ownership instead
      // of an explicit invite row). No matching.evaluate — a provider
      // never triggers a match run, only the operator does.
      "match.read",
      "match.list",
      // earlier: the SCOPE'S OWN worked example (this build's seed
      // fixtures included) — an acquirer/provider is very often the
      // party a Claim's `claimantOrgId` names and a CommissionComponent's
      // `recipientOrgId` pays, for exactly the introduction/relationship
      // it filed a claim over. Same participantActions mechanism as
      // CONTRIBUTOR_AGENT/MERCHANT_PSP_USER (below) — "own accruals
      // only," verified by `recipientOrgId === actor.organizationId`,
      // never a blanket grant.
      "ledger.read",
      "ledger.list",
    ),
    crossOrgActions: set<Action>("opportunity.browse_market", "capacity.browse_market"),
    participantActions: set<Action>(
      "rfq.read",
      "rfq.list",
      "rfq.decline",
      "rfq.submit_quote",
      "rfq.withdraw_quote",
      "deal.read",
      "deal.list",
      "deal.post_condition",
      "deal.resolve_condition",
      "deal.record_decision",
      "claim.dispute",
      "match.read",
      "match.list",
      "ledger.read",
      "ledger.list",
    ),
    managesOtherPeopleInOwnOrg: false,
  },

  // p.4: "Inspect immutable history... No mutation" — cross-org READ of
  // everything, zero write actions. The absence of any create/update
  // action here (not a special-cased exception in can.ts) is what makes
  // "no mutation" a structural guarantee instead of a comment.
  // earlier: same "read everything, cross-org, zero writes" pattern
  // extended to the new resources — "No mutation" (p.4) stays a
  // structural guarantee (no rfq.decline/submit_quote/select_quote/
  // deal.post_condition/etc anywhere in this grant), not a convention.
  AUDITOR_READONLY: {
    allowedActions: set<Action>(
      "organization.read",
      "organization.list",
      "membership.read",
      "membership.list",
      "person.read",
      "audit.read",
      "opportunity.read",
      "opportunity.list",
      "capacity.read",
      "capacity.list",
      "rfq.read",
      "rfq.list",
      "deal.read",
      "deal.list",
      // earlier: "Inspect immutable history... No mutation" (p.4) extends
      // naturally to Lockbox receipts (tamper-evident, historical proof-
      // of-existence records) — read-only, cross-org, matching this
      // role's existing pattern for everything else. No seal/withdraw/
      // release — the structural "no mutation" guarantee stays intact.
      "lockbox.read_receipt",
      // earlier: "Inspect immutable history... No mutation" extends to
      // claims the same way — read-only, cross-org. No claim.decide
      // (that's a mutation) and no claim.create/dispute (this role never
      // acts as a claimant/challenger).
      "claim.read",
      "claim.list",
      // earlier: "Inspect immutable history... No mutation" extends to
      // Passport and the marketplace the same way — read-only, cross-
      // org. No passport.create/update/verify (all mutations); market
      // browsing is this role's own analog of "inspect the visible
      // market" rather than a mutation concern.
      "passport.read",
      "passport.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      // earlier: "Inspect immutable history... No mutation" extends to
      // match evaluations the same way — read-only, cross-org. No
      // matching.evaluate (that WRITES a new MatchResult row — a
      // mutation, per this role's own structural "no mutation"
      // guarantee, even though it's an append-only derived output
      // rather than an edit to an existing record).
      "match.read",
      "match.list",
      // earlier: "Inspect immutable history... No mutation" extends to
      // economics the same way — read-only, cross-org, across all THREE
      // resources (schedule/economics/ledger). No schedule.manage/
      // economics.record/ledger.record_payment/ledger.adjust — every one
      // of those is a real mutation (a new schedule version, a recorded
      // revenue fact, a payment, a correction), so this role's structural
      // "no mutation" guarantee excludes all four, the same way it
      // excludes matching.evaluate/passport.verify/claim.decide above.
      "schedule.read",
      "schedule.list",
      "economics.read",
      "economics.list",
      "ledger.read",
      "ledger.list",
    ),
    crossOrgActions: set<Action>(
      "organization.read",
      "organization.list",
      "membership.read",
      "membership.list",
      "person.read",
      "audit.read",
      "opportunity.read",
      "opportunity.list",
      "capacity.read",
      "capacity.list",
      "rfq.read",
      "rfq.list",
      "deal.read",
      "deal.list",
      "lockbox.read_receipt",
      "claim.read",
      "claim.list",
      "passport.read",
      "passport.list",
      "opportunity.browse_market",
      "capacity.browse_market",
      "match.read",
      "match.list",
      "schedule.read",
      "schedule.list",
      "economics.read",
      "economics.list",
      "ledger.read",
      "ledger.list",
    ),
    participantActions: set<Action>(),
    managesOtherPeopleInOwnOrg: false,
  },
};

// Fails loudly at import time (not silently at first use) if a role is
// ever added to PERSONA_ROLES without a matching matrix entry, or vice
// versa — the authority matrix and the persona list can never drift
// apart without the whole package failing to load.
for (const role of PERSONA_ROLES) {
  if (!(role in AUTHORITY_MATRIX)) {
    throw new Error(`packages/authz: PersonaRole "${role}" has no AUTHORITY_MATRIX entry`);
  }
}
const matrixKeys = Object.keys(AUTHORITY_MATRIX);
if (matrixKeys.length !== PERSONA_ROLES.length) {
  throw new Error(
    `packages/authz: AUTHORITY_MATRIX has ${matrixKeys.length} entries but PERSONA_ROLES has ${PERSONA_ROLES.length} — they must match exactly`,
  );
}

// earlier addition (review,
// IDEA "add a runtime invariant check that crossOrgActions must also be
// in allowedActions"): the three structural invariants matrix.test.ts
// has always proven — crossOrgActions ⊆ allowedActions,
// participantActions ⊆ allowedActions, and crossOrgActions ∩
// participantActions = ∅ (RoleGrant's own doc comments state all three)
// — now ALSO fail loudly at module load, not only under `pnpm test`.
// Same "deny-by-default enforced structurally, not merely tested"
// discipline as this file's own PERSONA_ROLES-vs-AUTHORITY_MATRIX
// completeness check above, and the same reasoning @tol/attribution's
// assertWeightsSumToOne() / @tol/matching's assertRankingWeightsSumToOne()
// already established: a future edit that breaks one of these three
// relationships fails EVERY environment that imports this module, not
// just a CI run that happened to execute the test suite.
for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
  for (const action of grant.crossOrgActions) {
    if (!grant.allowedActions.has(action)) {
      throw new Error(`packages/authz: ${role}'s crossOrgActions has "${action}" not in allowedActions`);
    }
  }
  for (const action of grant.participantActions) {
    if (!grant.allowedActions.has(action)) {
      throw new Error(`packages/authz: ${role}'s participantActions has "${action}" not in allowedActions`);
    }
    if (grant.crossOrgActions.has(action)) {
      throw new Error(`packages/authz: ${role}'s "${action}" is in BOTH crossOrgActions and participantActions — the two must be mutually exclusive access paths`);
    }
  }
}
