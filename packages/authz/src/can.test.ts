import { describe, expect, it } from "vitest";
import { can } from "./can.js";
import { AUTHORITY_MATRIX } from "./matrix.js";
import type { Actor, Resource } from "./actions.js";

const ORG_A = "00000000-0000-7000-8000-00000000000a";
const ORG_B = "00000000-0000-7000-8000-00000000000b";
const USER_1 = "00000000-0000-7000-8000-000000000001";
const USER_2 = "00000000-0000-7000-8000-000000000002";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: USER_1,
    organizationId: ORG_A,
    role: "MERCHANT_PSP_USER",
    membershipId: "membership-1",
    ...overrides,
  };
}

function orgResource(ownerOrgId: string | null): Resource {
  return { type: "organization", id: "org-resource-1", ownerOrgId };
}

describe("can() — P4 tenant isolation (the core proof)", () => {
  it("ALLOWS a same-org actor to read their own organization", () => {
    const decision = can(actor({ organizationId: ORG_A }), "organization.read", orgResource(ORG_A));
    expect(decision.allowed).toBe(true);
  });

  it("DENIES a same-role actor from a DIFFERENT organization reading org A's data — the P4 boundary", () => {
    // Same role, same action, only the org differs.
    const orgBActor = actor({ organizationId: ORG_B, userId: USER_2 });
    const decision = can(orgBActor, "organization.read", orgResource(ORG_A));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/tenant isolation/i);
  });

  it("DENIES cross-org membership.read for a non-cross-org role even when the action is otherwise granted", () => {
    const orgBActor = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(orgBActor, "membership.read", { type: "membership", ownerOrgId: ORG_A });
    expect(decision.allowed).toBe(false);
  });

  it("ALLOWS cross-org access for roles the matrix explicitly grants it to (PLATFORM_OWNER)", () => {
    const platformOwner = actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" });
    const decision = can(platformOwner, "organization.read", orgResource(ORG_A));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/cross-org/i);
  });

  it("ALLOWS cross-org read for AUDITOR_READONLY (p.4: 'Inspect immutable history')", () => {
    const auditor = actor({ organizationId: ORG_B, role: "AUDITOR_READONLY" });
    expect(can(auditor, "organization.read", orgResource(ORG_A)).allowed).toBe(true);
    expect(can(auditor, "audit.read", { type: "audit_event", ownerOrgId: ORG_A }).allowed).toBe(true);
  });
});

describe("can() — P2 deny-by-default (unlisted combinations)", () => {
  it("DENIES AUDITOR_READONLY any mutation — 'No mutation' (p.4) is structural, not a special case", () => {
    const auditor = actor({ role: "AUDITOR_READONLY" });
    expect(can(auditor, "organization.update", orgResource(ORG_A)).allowed).toBe(false);
    expect(can(auditor, "membership.create", { type: "membership", ownerOrgId: ORG_A }).allowed).toBe(false);
    expect(can(auditor, "membership.update_role", { type: "membership", ownerOrgId: ORG_A }).allowed).toBe(false);
    expect(can(auditor, "person.update", { type: "person", ownerOrgId: ORG_A }, { isSelf: true }).allowed).toBe(
      false,
    );
  });

  it("DENIES membership.update_role to every role except PLATFORM_OWNER", () => {
    const nonOwnerRoles = [
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
    for (const role of nonOwnerRoles) {
      const decision = can(actor({ role }), "membership.update_role", { type: "membership", ownerOrgId: ORG_A });
      expect(decision.allowed, `role ${role} should NOT be granted membership.update_role`).toBe(false);
      expect(decision.reason).toMatch(/deny-by-default|not granted/i);
    }
  });

  it("DENIES an actor with no active membership (role/org null) — nothing is grantable without one", () => {
    const noMembership = actor({ role: null, organizationId: null });
    expect(can(noMembership, "organization.read", orgResource(ORG_A)).allowed).toBe(false);
  });

  it("DENIES when the resource type doesn't match the action's expected type", () => {
    const decision = can(actor(), "organization.read", { type: "person", ownerOrgId: ORG_A });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/resource type/i);
  });

  it("DENIES a same-org-scoped action when the resource has no ownerOrgId at all", () => {
    const decision = can(actor(), "organization.update", orgResource(null));
    expect(decision.allowed).toBe(false);
  });
});

describe("can() — person.update self-vs-others rule", () => {
  it("ALLOWS a role with only isSelf permission to update its OWN person record", () => {
    const contributor = actor({ role: "CONTRIBUTOR_AGENT" });
    const decision = can(contributor, "person.update", { type: "person", ownerOrgId: ORG_A }, { isSelf: true });
    expect(decision.allowed).toBe(true);
  });

  it("DENIES that same role updating SOMEONE ELSE's person record, even same org", () => {
    const contributor = actor({ role: "CONTRIBUTOR_AGENT" });
    const decision = can(contributor, "person.update", { type: "person", ownerOrgId: ORG_A }, { isSelf: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/own person record/i);
  });

  it("ALLOWS PARTNERSHIP_LEAD to update another member's person record in its OWN org (managesOtherPeopleInOwnOrg)", () => {
    const lead = actor({ role: "PARTNERSHIP_LEAD" });
    const decision = can(lead, "person.update", { type: "person", ownerOrgId: ORG_A }, { isSelf: false });
    expect(decision.allowed).toBe(true);
  });

  it("still DENIES PARTNERSHIP_LEAD updating another org's person record (managesOtherPeopleInOwnOrg is not cross-org)", () => {
    const lead = actor({ role: "PARTNERSHIP_LEAD", organizationId: ORG_B });
    const decision = can(lead, "person.update", { type: "person", ownerOrgId: ORG_A }, { isSelf: false });
    expect(decision.allowed).toBe(false);
  });
});

describe("can() — every decision carries a reason, allow or deny", () => {
  it("populates `reason` on an ALLOW decision, not just on deny", () => {
    const decision = can(actor(), "organization.read", orgResource(ORG_A));
    expect(decision.allowed).toBe(true);
    expect(typeof decision.reason).toBe("string");
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

// ================================================================
// earlier: isParticipant — the RFQ/DealRoom non-owning-counterparty path
// (ADR-0008). RFQ.ownerOrgId / DealRoom.ownerOrgId are always the
// MERCHANT's org (opportunity.ownerOrgId / dealRoom.merchantOrgId) — an
// invited PROVIDER is never the resource owner, so these tests are the
// actual proof that a provider can act on a resource it's genuinely
// invited to, and CANNOT act on one it isn't, mirroring can.test.ts's
// existing P4 tenant-isolation proof but for the two-sided case.
// ================================================================

function rfqResource(ownerOrgId: string): Resource {
  return { type: "rfq", id: "rfq-1", ownerOrgId };
}

function dealRoomResource(merchantOrgId: string): Resource {
  return { type: "deal_room", id: "deal-1", ownerOrgId: merchantOrgId };
}

describe("can() — earlier isParticipant (RFQ)", () => {
  it("ALLOWS an invited provider (isParticipant: true) to submit a quote on a merchant-owned RFQ it does NOT own", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "rfq.submit_quote", rfqResource(ORG_A), { isParticipant: true });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/participant/i);
  });

  it("DENIES the SAME provider acting on the SAME RFQ when isParticipant is false — not actually invited", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "rfq.submit_quote", rfqResource(ORG_A), { isParticipant: false });
    expect(decision.allowed).toBe(false);
  });

  it("DENIES when isParticipant is omitted entirely — the safe default (undefined is falsy, same discipline as isSelf)", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "rfq.submit_quote", rfqResource(ORG_A));
    expect(decision.allowed).toBe(false);
  });

  it("DENIES rfq.select_quote to a provider even WITH isParticipant — that action is merchant-only (not in ACQUIRER_PROVIDER_USER's participantActions)", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "rfq.select_quote", rfqResource(ORG_A), { isParticipant: true });
    expect(decision.allowed).toBe(false);
  });

  it("ALLOWS the merchant (the actual RFQ owner) to select a quote via the ORDINARY ownerOrgId path — no isParticipant needed", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    const decision = can(merchant, "rfq.select_quote", rfqResource(ORG_A));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).not.toMatch(/participant/i); // took the ordinary same-org path, not the participant path
  });

  it("DENIES a THIRD, uninvited org's provider even with an (incorrectly) claimed isParticipant — the caller-side lookup, not the flag itself, is the real guard; but at the can() layer, a true isParticipant for the wrong role/action combination still correctly denies", () => {
    // MERCHANT_PSP_USER has no rfq.submit_quote in participantActions at all (or allowedActions) — proves the grant is role-scoped, not just flag-scoped.
    const wrongRole = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    const decision = can(wrongRole, "rfq.submit_quote", rfqResource(ORG_A), { isParticipant: true });
    expect(decision.allowed).toBe(false);
  });

  it("ALLOWS cross-org rfq.create for MARKETPLACE_OPERATOR (p.1: 'operator-assisted market'; p.4: 'Create invite sets')", () => {
    const operator = actor({ organizationId: ORG_B, role: "MARKETPLACE_OPERATOR" });
    const decision = can(operator, "rfq.create", rfqResource(ORG_A));
    expect(decision.allowed).toBe(true);
  });

  it("DENIES rfq.create to MERCHANT_PSP_USER even for their OWN RFQ — operator-assisted model, not self-service, this pass", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    const decision = can(merchant, "rfq.create", rfqResource(ORG_A));
    expect(decision.allowed).toBe(false);
  });
});

describe("can() — earlier isParticipant (DealRoom)", () => {
  it("ALLOWS the invited provider (participant) to post a condition on a deal room it does not own", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "deal.post_condition", dealRoomResource(ORG_A), { isParticipant: true });
    expect(decision.allowed).toBe(true);
  });

  it("DENIES a provider with NO participant row (isParticipant: false) from even READING the deal room", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "deal.read", dealRoomResource(ORG_A), { isParticipant: false });
    expect(decision.allowed).toBe(false);
  });

  it("ALLOWS the merchant to read/record decisions via the ordinary ownerOrgId path (merchantOrgId IS the resource owner)", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    expect(can(merchant, "deal.read", dealRoomResource(ORG_A)).allowed).toBe(true);
    expect(can(merchant, "deal.record_decision", dealRoomResource(ORG_A)).allowed).toBe(true);
  });

  it("ALLOWS cross-org deal.read for COMPLIANCE_REVIEWER and AUDITOR_READONLY without needing isParticipant", () => {
    const compliance = actor({ organizationId: ORG_B, role: "COMPLIANCE_REVIEWER" });
    const auditor = actor({ organizationId: ORG_B, role: "AUDITOR_READONLY" });
    expect(can(compliance, "deal.read", dealRoomResource(ORG_A)).allowed).toBe(true);
    expect(can(auditor, "deal.read", dealRoomResource(ORG_A)).allowed).toBe(true);
  });

  it("DENIES AUDITOR_READONLY any deal.* write even cross-org — 'No mutation' extends to earlier resources", () => {
    const auditor = actor({ organizationId: ORG_B, role: "AUDITOR_READONLY" });
    expect(can(auditor, "deal.post_condition", dealRoomResource(ORG_A)).allowed).toBe(false);
    expect(can(auditor, "deal.record_decision", dealRoomResource(ORG_A)).allowed).toBe(false);
  });
});

// ================================================================
// earlier: Lockbox (P9). sealerOrgId IS Resource.ownerOrgId for a
// Lockbox — a genuinely single-sided resource (unlike RFQ/DealRoom),
// so no isParticipant mechanism applies here; every test below is a
// plain same-org-vs-cross-org proof, plus the two deliberately
// asymmetric rules the earlier brief and ADR-0001 require: ONLY
// the sealer org can withdraw (not even PLATFORM_OWNER cross-org), and
// ONLY the operator roles can release (not even the sealer itself).
// ================================================================

function lockboxResource(sealerOrgId: string): Resource {
  return { type: "lockbox", id: "lockbox-1", ownerOrgId: sealerOrgId };
}

describe("can() — earlier Lockbox: seal", () => {
  it("ALLOWS each of the three 'has a relationship to seal' personas to seal their OWN org's Lockbox", () => {
    for (const role of ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"] as const) {
      const sealer = actor({ organizationId: ORG_A, role });
      const decision = can(sealer, "lockbox.seal", lockboxResource(ORG_A));
      expect(decision.allowed, `role ${role} should be able to seal its own Lockbox`).toBe(true);
    }
  });

  it("DENIES sealing on behalf of a DIFFERENT org — tenant isolation applies to Lockbox exactly like every other resource", () => {
    const wrongOrg = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    const decision = can(wrongOrg, "lockbox.seal", lockboxResource(ORG_A));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/tenant isolation/i);
  });

  it("ALLOWS PLATFORM_OWNER to seal cross-org (broadest authority, matches its existing pattern for every other action)", () => {
    const owner = actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" });
    expect(can(owner, "lockbox.seal", lockboxResource(ORG_A)).allowed).toBe(true);
  });

  it("DENIES roles with no relationship to seal (PARTNERSHIP_LEAD, UNDERWRITING_ANALYST, FINANCE_OPERATOR, MARKETPLACE_OPERATOR, COMPLIANCE_REVIEWER, AUDITOR_READONLY) from sealing even their own org's Lockbox", () => {
    const noSealRoles = [
      "PARTNERSHIP_LEAD",
      "UNDERWRITING_ANALYST",
      "FINANCE_OPERATOR",
      "MARKETPLACE_OPERATOR",
      "COMPLIANCE_REVIEWER",
      "AUDITOR_READONLY",
    ] as const;
    for (const role of noSealRoles) {
      const decision = can(actor({ organizationId: ORG_A, role }), "lockbox.seal", lockboxResource(ORG_A));
      expect(decision.allowed, `role ${role} should NOT be able to seal`).toBe(false);
    }
  });
});

describe("can() — earlier Lockbox: withdraw (only the sealer org, EVER — not even Platform Owner cross-org)", () => {
  it("ALLOWS the sealer org itself to withdraw its own Lockbox", () => {
    const sealer = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    const decision = can(sealer, "lockbox.withdraw", lockboxResource(ORG_A));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).not.toMatch(/cross-org/i); // took the ordinary same-org path
  });

  it("DENIES a different org (same role) from withdrawing — the P4-style tenant-isolation proof for Lockbox", () => {
    const otherOrg = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    expect(can(otherOrg, "lockbox.withdraw", lockboxResource(ORG_A)).allowed).toBe(false);
  });

  it("DENIES PLATFORM_OWNER from withdrawing a DIFFERENT org's Lockbox — the one deliberate exception to this role's otherwise-universal cross-org authority (ADR-0001: 'only the sealer org can withdraw')", () => {
    const owner = actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" });
    const decision = can(owner, "lockbox.withdraw", lockboxResource(ORG_A));
    expect(decision.allowed).toBe(false);
  });

  it("ALLOWS PLATFORM_OWNER to withdraw when it genuinely IS the sealer org (own-org path still works — the exclusion is only from crossOrgActions)", () => {
    const owner = actor({ organizationId: ORG_A, role: "PLATFORM_OWNER" });
    expect(can(owner, "lockbox.withdraw", lockboxResource(ORG_A)).allowed).toBe(true);
  });

  it("DENIES MARKETPLACE_OPERATOR from withdrawing ANY Lockbox, even cross-org, even for facilitation — withdraw was never granted to this role at all", () => {
    const operator = actor({ organizationId: ORG_B, role: "MARKETPLACE_OPERATOR" });
    expect(can(operator, "lockbox.withdraw", lockboxResource(ORG_A)).allowed).toBe(false);
    const sameOrgOperator = actor({ organizationId: ORG_A, role: "MARKETPLACE_OPERATOR" });
    expect(can(sameOrgOperator, "lockbox.withdraw", lockboxResource(ORG_A)).allowed).toBe(false);
  });
});

describe("can() — earlier Lockbox: release (operator-triggered only — ADR-0001/ADR-0009's escrow model)", () => {
  it("ALLOWS PLATFORM_OWNER and MARKETPLACE_OPERATOR to release cross-org — the escrowed-release model doesn't need the sealer's own org to call this action", () => {
    for (const role of ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR"] as const) {
      const operator = actor({ organizationId: ORG_B, role });
      const decision = can(operator, "lockbox.release", lockboxResource(ORG_A));
      expect(decision.allowed, `role ${role} should be able to release cross-org`).toBe(true);
      expect(decision.reason).toMatch(/cross-org/i);
    }
  });

  it("DENIES the SEALER itself from releasing its own Lockbox — release is never a unilateral act by the party who sealed it, even on their own resource", () => {
    for (const role of ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"] as const) {
      const sealer = actor({ organizationId: ORG_A, role });
      const decision = can(sealer, "lockbox.release", lockboxResource(ORG_A));
      expect(decision.allowed, `role ${role} should NOT be able to release, even its own Lockbox`).toBe(false);
    }
  });

  it("DENIES COMPLIANCE_REVIEWER and AUDITOR_READONLY from releasing — oversight/read roles, not release-triggering ones", () => {
    expect(can(actor({ organizationId: ORG_B, role: "COMPLIANCE_REVIEWER" }), "lockbox.release", lockboxResource(ORG_A)).allowed).toBe(false);
    expect(can(actor({ organizationId: ORG_B, role: "AUDITOR_READONLY" }), "lockbox.release", lockboxResource(ORG_A)).allowed).toBe(false);
  });
});

describe("can() — earlier Lockbox: read_receipt (proof-of-existence, distinct from ever reading contents)", () => {
  it("ALLOWS the sealer org to read its own Lockbox's receipt", () => {
    const sealer = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    expect(can(sealer, "lockbox.read_receipt", lockboxResource(ORG_A)).allowed).toBe(true);
  });

  it("ALLOWS every oversight role (PLATFORM_OWNER, MARKETPLACE_OPERATOR, COMPLIANCE_REVIEWER, AUDITOR_READONLY) to read a receipt cross-org", () => {
    for (const role of ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"] as const) {
      const overseer = actor({ organizationId: ORG_B, role });
      expect(can(overseer, "lockbox.read_receipt", lockboxResource(ORG_A)).allowed, `role ${role} should read cross-org`).toBe(true);
    }
  });

  it("DENIES a DIFFERENT non-oversight org from reading another org's receipt — receipts are not globally readable, only sealer + oversight", () => {
    const otherMerchant = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    expect(can(otherMerchant, "lockbox.read_receipt", lockboxResource(ORG_A)).allowed).toBe(false);
  });
});

// ================================================================
// earlier: Attribution (P10) — Claim.ownerOrgId is claimantOrgId (p.13:
// "See own claims... cannot inspect private competing records"). Three
// claimant-side roles (CONTRIBUTOR_AGENT/MERCHANT_PSP_USER/
// ACQUIRER_PROVIDER_USER) create/read/list own-org only, dispute via
// isParticipant (standing verified by the service layer, never a blanket
// cross-org grant — see actions.ts's AuthContext.isParticipant comment).
// Four reviewer/oversight roles (PLATFORM_OWNER/MARKETPLACE_OPERATOR/
// PARTNERSHIP_LEAD/COMPLIANCE_REVIEWER) can decide cross-org — matching
// the spec's "relationship provenance" (Partnership Lead) and "review
// restricted claims" (Compliance Reviewer) authority. Three more
// (UNDERWRITING_ANALYST/FINANCE_OPERATOR/AUDITOR_READONLY) get cross-org
// read/list only, never decide.
// ================================================================

const CLAIMANT_ROLES = ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"] as const;
const DECIDER_ROLES = ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "COMPLIANCE_REVIEWER"] as const;
const READ_ONLY_OVERSIGHT_ROLES = ["UNDERWRITING_ANALYST", "FINANCE_OPERATOR", "AUDITOR_READONLY"] as const;

function claimResource(claimantOrgId: string): Resource {
  return { type: "claim", id: "claim-1", ownerOrgId: claimantOrgId };
}

describe("can() — earlier Claim: create (filing a claim)", () => {
  it("ALLOWS each of the three claimant-side personas to create a claim for their OWN org", () => {
    for (const role of CLAIMANT_ROLES) {
      const claimant = actor({ organizationId: ORG_A, role });
      expect(can(claimant, "claim.create", claimResource(ORG_A)).allowed, `role ${role} should be able to create`).toBe(true);
    }
  });

  it("DENIES filing a claim 'as' a different org — tenant isolation applies exactly like every other resource", () => {
    const wrongOrg = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    const decision = can(wrongOrg, "claim.create", claimResource(ORG_A));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/tenant isolation/i);
  });

  it("ALLOWS PLATFORM_OWNER to create a claim for its OWN org only — NOT cross-org (the spec anti-squatting: platform-owned relationships are seeded by the platform's own org, not impersonating another)", () => {
    const owner = actor({ organizationId: ORG_A, role: "PLATFORM_OWNER" });
    expect(can(owner, "claim.create", claimResource(ORG_A)).allowed).toBe(true);
    const crossOrgOwner = actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" });
    expect(can(crossOrgOwner, "claim.create", claimResource(ORG_A)).allowed).toBe(false);
  });

  it("DENIES every reviewer/oversight role from creating a claim — they review, they are never claimants (matches Lockbox's operator-never-seals precedent)", () => {
    for (const role of [...DECIDER_ROLES.filter((r) => r !== "PLATFORM_OWNER"), ...READ_ONLY_OVERSIGHT_ROLES] as const) {
      const reviewer = actor({ organizationId: ORG_A, role });
      expect(can(reviewer, "claim.create", claimResource(ORG_A)).allowed, `role ${role} should NOT be able to create`).toBe(false);
    }
  });
});

describe("can() — earlier Claim: read / list (own claims only for claimants; cross-org for reviewers/oversight)", () => {
  it("ALLOWS a claimant-side role to read its OWN org's claim", () => {
    const claimant = actor({ organizationId: ORG_A, role: "CONTRIBUTOR_AGENT" });
    expect(can(claimant, "claim.read", claimResource(ORG_A)).allowed).toBe(true);
    expect(can(claimant, "claim.list", claimResource(ORG_A)).allowed).toBe(true);
  });

  it("DENIES a claimant-side role from reading a DIFFERENT org's claim — p.13: 'cannot inspect private competing records', enforced structurally (no crossOrgActions grant), not just a query filter", () => {
    for (const role of CLAIMANT_ROLES) {
      const otherOrgClaimant = actor({ organizationId: ORG_B, role });
      const decision = can(otherOrgClaimant, "claim.read", claimResource(ORG_A));
      expect(decision.allowed, `role ${role} should NOT read another org's claim`).toBe(false);
      expect(decision.reason).toMatch(/tenant isolation/i);
    }
  });

  it("ALLOWS every decider role (PLATFORM_OWNER, MARKETPLACE_OPERATOR, PARTNERSHIP_LEAD, COMPLIANCE_REVIEWER) to read/list cross-org", () => {
    for (const role of DECIDER_ROLES) {
      const reviewer = actor({ organizationId: ORG_B, role });
      expect(can(reviewer, "claim.read", claimResource(ORG_A)).allowed, `role ${role} should read cross-org`).toBe(true);
      expect(can(reviewer, "claim.list", claimResource(ORG_A)).allowed, `role ${role} should list cross-org`).toBe(true);
    }
  });

  it("ALLOWS every read-only oversight role (UNDERWRITING_ANALYST, FINANCE_OPERATOR, AUDITOR_READONLY) to read/list cross-org", () => {
    for (const role of READ_ONLY_OVERSIGHT_ROLES) {
      const overseer = actor({ organizationId: ORG_B, role });
      expect(can(overseer, "claim.read", claimResource(ORG_A)).allowed, `role ${role} should read cross-org`).toBe(true);
    }
  });
});

describe("can() — earlier Claim: dispute (isParticipant — standing verified by the service layer, never a blanket cross-org grant)", () => {
  it("ALLOWS a claimant-side role to dispute a DIFFERENT org's claim when isParticipant is true (the service already verified real standing)", () => {
    for (const role of CLAIMANT_ROLES) {
      const challenger = actor({ organizationId: ORG_B, role });
      const decision = can(challenger, "claim.dispute", claimResource(ORG_A), { isParticipant: true });
      expect(decision.allowed, `role ${role} should be able to dispute with verified standing`).toBe(true);
    }
  });

  it("DENIES the SAME challenger on the SAME claim when isParticipant is false — no verified standing (checked for ALL THREE claimant-side roles, not just one — review, correctly noted the original test only exercised MERCHANT_PSP_USER in this direction while the ALLOWS case above already looped over all three)", () => {
    for (const role of CLAIMANT_ROLES) {
      const challenger = actor({ organizationId: ORG_B, role });
      const decision = can(challenger, "claim.dispute", claimResource(ORG_A), { isParticipant: false });
      expect(decision.allowed, `role ${role} should be denied without verified standing`).toBe(false);
    }
  });

  it("DENIES when isParticipant is omitted entirely — the safe default, same discipline as RFQ/DealRoom's isParticipant checks (all three claimant-side roles)", () => {
    for (const role of CLAIMANT_ROLES) {
      const challenger = actor({ organizationId: ORG_B, role });
      expect(can(challenger, "claim.dispute", claimResource(ORG_A)).allowed, `role ${role} should be denied with no context at all`).toBe(false);
    }
  });

  it("ALLOWS disputing via the ORDINARY own-org path too (a claimant can dispute a competing claim ABOUT their own org's subject — not every dispute needs isParticipant if the claim itself happens to be own-org, though in practice challengerOrgId almost always differs from claimantOrgId)", () => {
    const sameOrgActor = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    expect(can(sameOrgActor, "claim.dispute", claimResource(ORG_A)).allowed).toBe(true);
  });

  it("DENIES every reviewer/oversight role from disputing — reviewers decide disputes, they never file them (symmetric to claim.create's denial)", () => {
    for (const role of [...DECIDER_ROLES, ...READ_ONLY_OVERSIGHT_ROLES] as const) {
      const reviewer = actor({ organizationId: ORG_B, role });
      const decision = can(reviewer, "claim.dispute", claimResource(ORG_A), { isParticipant: true });
      expect(decision.allowed, `role ${role} should NOT be able to dispute even with isParticipant true (never granted the action at all)`).toBe(false);
    }
  });

  it("claim.dispute is never in any claimant-side role's crossOrgActions — a true isParticipant flag is required, not a blanket grant (structural proof, not just a can() call)", () => {
    for (const role of CLAIMANT_ROLES) {
      expect(AUTHORITY_MATRIX[role].crossOrgActions.has("claim.dispute")).toBe(false);
    }
  });
});

describe("can() — earlier Claim: decide (the reviewer's recorded outcome — cross-org, never a claimant's own act)", () => {
  it("ALLOWS every decider role (PLATFORM_OWNER, MARKETPLACE_OPERATOR, PARTNERSHIP_LEAD, COMPLIANCE_REVIEWER) to decide cross-org", () => {
    for (const role of DECIDER_ROLES) {
      const reviewer = actor({ organizationId: ORG_B, role });
      const decision = can(reviewer, "claim.decide", claimResource(ORG_A));
      expect(decision.allowed, `role ${role} should be able to decide cross-org`).toBe(true);
      expect(decision.reason).toMatch(/cross-org/i);
    }
  });

  it("DENIES every claimant-side role from deciding its OWN claim — filing and deciding are never the same actor (the spec: scoring/review is never automatic or self-certified)", () => {
    for (const role of CLAIMANT_ROLES) {
      const claimant = actor({ organizationId: ORG_A, role });
      expect(can(claimant, "claim.decide", claimResource(ORG_A)).allowed, `role ${role} should NOT be able to decide`).toBe(false);
    }
  });

  it("DENIES the read-only oversight roles (UNDERWRITING_ANALYST, FINANCE_OPERATOR, AUDITOR_READONLY) from deciding — read/list visibility does not imply decision authority", () => {
    for (const role of READ_ONLY_OVERSIGHT_ROLES) {
      const overseer = actor({ organizationId: ORG_B, role });
      expect(can(overseer, "claim.decide", claimResource(ORG_A)).allowed, `role ${role} should NOT be able to decide`).toBe(false);
    }
  });
});

// ================================================================
// earlier: P6 Passport + P5 Marketplace. Passport reuses the SAME
// claimant/decider/oversight role shape claim.* already established:
// three own-org maintainer roles (CONTRIBUTOR_AGENT/MERCHANT_PSP_USER/
// ACQUIRER_PROVIDER_USER — same set as CLAIMANT_ROLES, reused directly)
// create/read/update their OWN Passport only; PLATFORM_OWNER/
// MARKETPLACE_OPERATOR/COMPLIANCE_REVIEWER read/list/verify cross-org;
// PARTNERSHIP_LEAD/UNDERWRITING_ANALYST/AUDITOR_READONLY read/list
// cross-org WITHOUT verify (narrower than the claim.decide DECIDER_ROLES
// set — passport.verify has only 3 grantees, not 4); FINANCE_OPERATOR
// gets no passport.* grant at all. Market browsing
// (opportunity.browse_market/capacity.browse_market) is granted to
// EVERY persona, cross-org — the spec's "Members can see market depth"
// is explicitly a blanket, not graduated, capability.
// ================================================================

const PASSPORT_VERIFIER_ROLES = ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER"] as const;
const PASSPORT_READ_ONLY_ROLES = ["PARTNERSHIP_LEAD", "UNDERWRITING_ANALYST", "AUDITOR_READONLY"] as const;
const ALL_PERSONA_ROLES = [
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

function passportResource(organizationId: string): Resource {
  return { type: "passport", id: "passport-1", ownerOrgId: organizationId };
}

function marketResource(type: "opportunity" | "capacity_profile", ownerOrgId: string): Resource {
  return { type, id: "market-card-1", ownerOrgId };
}

describe("can() — earlier addendum: opportunity.update (P7 VolumeSlice sub-resource, granted alongside opportunity.create)", () => {
  it("ALLOWS the two own-org opportunity-owning roles (CONTRIBUTOR_AGENT, MERCHANT_PSP_USER) to update their OWN org's opportunity", () => {
    for (const role of ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER"] as const) {
      const owner = actor({ organizationId: ORG_A, role });
      expect(can(owner, "opportunity.update", marketResource("opportunity", ORG_A)).allowed, `role ${role} should update`).toBe(true);
    }
  });

  it("ALLOWS PLATFORM_OWNER to update cross-org, matching its existing opportunity.create cross-org grant", () => {
    const owner = actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" });
    expect(can(owner, "opportunity.update", marketResource("opportunity", ORG_A)).allowed).toBe(true);
  });

  it("DENIES an owning role from updating a DIFFERENT org's opportunity — tenant isolation", () => {
    const wrongOrg = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    expect(can(wrongOrg, "opportunity.update", marketResource("opportunity", ORG_A)).allowed).toBe(false);
  });

  it("DENIES MARKETPLACE_OPERATOR from updating an opportunity's volume breakdown — it curates/reads, it never edits a merchant's own submitted figures (matches its existing opportunity.create omission)", () => {
    const operator = actor({ organizationId: ORG_B, role: "MARKETPLACE_OPERATOR" });
    expect(can(operator, "opportunity.update", marketResource("opportunity", ORG_A)).allowed).toBe(false);
  });
});

describe("can() — earlier Passport: create/read/update (own-org maintainer roles)", () => {
  it("ALLOWS each of the three maintainer personas to create/read/update their OWN org's Passport", () => {
    for (const role of CLAIMANT_ROLES) {
      const maintainer = actor({ organizationId: ORG_A, role });
      expect(can(maintainer, "passport.create", passportResource(ORG_A)).allowed, `role ${role} should create`).toBe(true);
      expect(can(maintainer, "passport.read", passportResource(ORG_A)).allowed, `role ${role} should read`).toBe(true);
      expect(can(maintainer, "passport.update", passportResource(ORG_A)).allowed, `role ${role} should update`).toBe(true);
    }
  });

  it("DENIES a maintainer role from creating/updating a DIFFERENT org's Passport — tenant isolation, not just visibility", () => {
    for (const role of CLAIMANT_ROLES) {
      const wrongOrg = actor({ organizationId: ORG_B, role });
      const decision = can(wrongOrg, "passport.update", passportResource(ORG_A));
      expect(decision.allowed, `role ${role} should NOT update another org's passport`).toBe(false);
      expect(decision.reason).toMatch(/tenant isolation/i);
    }
  });

  it("DENIES FINANCE_OPERATOR from any passport.* action — no scope tie, unlike every other persona", () => {
    const finance = actor({ organizationId: ORG_A, role: "FINANCE_OPERATOR" });
    expect(can(finance, "passport.create", passportResource(ORG_A)).allowed).toBe(false);
    expect(can(finance, "passport.read", passportResource(ORG_A)).allowed).toBe(false);
  });
});

describe("can() — earlier Passport: read/list (cross-org reviewer/oversight visibility)", () => {
  it("ALLOWS every verifier role AND every read-only reviewer role to read/list cross-org", () => {
    for (const role of [...PASSPORT_VERIFIER_ROLES, ...PASSPORT_READ_ONLY_ROLES] as const) {
      const reviewer = actor({ organizationId: ORG_B, role });
      expect(can(reviewer, "passport.read", passportResource(ORG_A)).allowed, `role ${role} should read cross-org`).toBe(true);
      expect(can(reviewer, "passport.list", passportResource(ORG_A)).allowed, `role ${role} should list cross-org`).toBe(true);
    }
  });

  it("DENIES a maintainer role from reading a DIFFERENT org's Passport — own-org only, no cross-org grant at all", () => {
    for (const role of CLAIMANT_ROLES) {
      const otherOrg = actor({ organizationId: ORG_B, role });
      expect(can(otherOrg, "passport.read", passportResource(ORG_A)).allowed, `role ${role} should NOT read cross-org`).toBe(false);
    }
  });
});

describe("can() — earlier Passport: verify (the reviewer step, READY -> VERIFIED — a NARROWER set than claim.decide's DECIDER_ROLES)", () => {
  it("ALLOWS only PLATFORM_OWNER, MARKETPLACE_OPERATOR, and COMPLIANCE_REVIEWER to verify, cross-org", () => {
    for (const role of PASSPORT_VERIFIER_ROLES) {
      const verifier = actor({ organizationId: ORG_B, role });
      const decision = can(verifier, "passport.verify", passportResource(ORG_A));
      expect(decision.allowed, `role ${role} should be able to verify cross-org`).toBe(true);
      expect(decision.reason).toMatch(/cross-org/i);
    }
  });

  it("DENIES PARTNERSHIP_LEAD from verifying — read/list cross-org, but NOT verify (deliberately narrower than its own claim.decide grant)", () => {
    const partnershipLead = actor({ organizationId: ORG_B, role: "PARTNERSHIP_LEAD" });
    expect(can(partnershipLead, "passport.read", passportResource(ORG_A)).allowed).toBe(true);
    expect(can(partnershipLead, "passport.verify", passportResource(ORG_A)).allowed).toBe(false);
  });

  it("DENIES every maintainer role from verifying its OWN Passport — self-certification is never permitted, same discipline as claim.decide", () => {
    for (const role of CLAIMANT_ROLES) {
      const maintainer = actor({ organizationId: ORG_A, role });
      expect(can(maintainer, "passport.verify", passportResource(ORG_A)).allowed, `role ${role} should NOT self-verify`).toBe(false);
    }
  });

  it("DENIES the three read-only reviewer roles AND FINANCE_OPERATOR from verifying", () => {
    for (const role of [...PASSPORT_READ_ONLY_ROLES, "FINANCE_OPERATOR"] as const) {
      const nonVerifier = actor({ organizationId: ORG_B, role });
      expect(can(nonVerifier, "passport.verify", passportResource(ORG_A)).allowed, `role ${role} should NOT verify`).toBe(false);
    }
  });
});

describe("can() — earlier Marketplace: browse_market (blanket cross-org grant, the spec 'Members can see market depth')", () => {
  it("ALLOWS every one of the 10 personas to browse BOTH opportunity and capacity market inventory, cross-org", () => {
    for (const role of ALL_PERSONA_ROLES) {
      const member = actor({ organizationId: ORG_B, role });
      expect(can(member, "opportunity.browse_market", marketResource("opportunity", ORG_A)).allowed, `role ${role} should browse opportunity market`).toBe(true);
      expect(can(member, "capacity.browse_market", marketResource("capacity_profile", ORG_A)).allowed, `role ${role} should browse capacity market`).toBe(true);
    }
  });

  it("is granted cross-org even for CONTRIBUTOR_AGENT, whose every OTHER action is own-org-only — the one deliberate exception, per actions.ts's own comment", () => {
    const contributor = actor({ organizationId: ORG_B, role: "CONTRIBUTOR_AGENT" });
    expect(can(contributor, "opportunity.browse_market", marketResource("opportunity", ORG_A)).allowed).toBe(true);
    // Contrast: this SAME actor cannot read the full opportunity record cross-org.
    expect(can(contributor, "opportunity.read", marketResource("opportunity", ORG_A)).allowed).toBe(false);
  });

  it("does NOT grant the full opportunity.read/capacity.read action merely by having browse_market — these remain two separate, independently-checked actions", () => {
    const merchant = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    expect(can(merchant, "opportunity.browse_market", marketResource("opportunity", ORG_A)).allowed).toBe(true);
    expect(can(merchant, "opportunity.read", marketResource("opportunity", ORG_A)).allowed).toBe(false);
  });
});

// ================================================================
// earlier: Matching (P11 Eligibility + P12 Ranking)
// ================================================================

const MATCH_EVALUATOR_ROLES = ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR"] as const;
const MATCH_READ_CROSS_ORG_ROLES = ["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "UNDERWRITING_ANALYST", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"] as const;
const MATCH_NO_ACCESS_ROLES = ["FINANCE_OPERATOR", "CONTRIBUTOR_AGENT"] as const;

/** MatchResult's authz ownerOrgId is always the underlying Opportunity's owner (the merchant) — same two-sided-resource convention as DealRoom (D8). */
function matchResource(ownerOrgId: string | null): Resource {
  return { type: "match_result", id: "match-1", ownerOrgId };
}

describe("can() — earlier Matching: matching.evaluate (operator-only, cross-org — the spec 'Create invite sets', operator-assisted framing matching rfq.create's own precedent)", () => {
  it("ALLOWS PLATFORM_OWNER and MARKETPLACE_OPERATOR to evaluate matches cross-org", () => {
    for (const role of MATCH_EVALUATOR_ROLES) {
      const evaluator = actor({ organizationId: ORG_B, role });
      const decision = can(evaluator, "matching.evaluate", matchResource(ORG_A));
      expect(decision.allowed, `role ${role} should be able to evaluate cross-org`).toBe(true);
      expect(decision.reason).toMatch(/cross-org/i);
    }
  });

  it("DENIES every other persona, including MERCHANT_PSP_USER for its OWN opportunity — matching is operator-triggered, not self-serve, same reasoning as rfq.create", () => {
    for (const role of ALL_PERSONA_ROLES) {
      if ((MATCH_EVALUATOR_ROLES as readonly string[]).includes(role)) continue;
      const nonEvaluator = actor({ organizationId: ORG_A, role });
      expect(can(nonEvaluator, "matching.evaluate", matchResource(ORG_A)).allowed, `role ${role} should NOT evaluate, even own-org`).toBe(false);
    }
  });

  it("DENIES ACQUIRER_PROVIDER_USER from evaluating even with a verified participant context — evaluate is not in its participantActions set at all", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    expect(can(provider, "matching.evaluate", matchResource(ORG_A), { isParticipant: true }).allowed).toBe(false);
  });
});

describe("can() — earlier Matching: match.read / match.list (cross-org reviewer/oversight visibility)", () => {
  it("ALLOWS every cross-org reviewer role to read/list matches for ANY opportunity", () => {
    for (const role of MATCH_READ_CROSS_ORG_ROLES) {
      const reviewer = actor({ organizationId: ORG_B, role });
      expect(can(reviewer, "match.read", matchResource(ORG_A)).allowed, `role ${role} should read cross-org`).toBe(true);
      expect(can(reviewer, "match.list", matchResource(ORG_A)).allowed, `role ${role} should list cross-org`).toBe(true);
    }
  });

  it("DENIES FINANCE_OPERATOR and CONTRIBUTOR_AGENT entirely — no scope tie to reviewing match results (deny-by-default, not merely non-cross-org)", () => {
    for (const role of MATCH_NO_ACCESS_ROLES) {
      const noAccess = actor({ organizationId: ORG_A, role });
      expect(can(noAccess, "match.read", matchResource(ORG_A)).allowed, `role ${role} should NOT read even own-org`).toBe(false);
      const crossOrg = actor({ organizationId: ORG_B, role });
      expect(can(crossOrg, "match.read", matchResource(ORG_A)).allowed, `role ${role} should NOT read cross-org`).toBe(false);
    }
  });
});

describe("can() — earlier Matching: MERCHANT_PSP_USER (own-org only — the natural resource-owner path, no participantActions mechanism needed, same shape as its own rfq.read/deal.read grants)", () => {
  it("ALLOWS the merchant to read/list matches for its OWN opportunity", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    expect(can(merchant, "match.read", matchResource(ORG_A)).allowed).toBe(true);
    expect(can(merchant, "match.list", matchResource(ORG_A)).allowed).toBe(true);
  });

  it("DENIES the merchant from reading a DIFFERENT org's opportunity matches — tenant isolation, no cross-org grant at all", () => {
    const wrongOrg = actor({ organizationId: ORG_B, role: "MERCHANT_PSP_USER" });
    const decision = can(wrongOrg, "match.read", matchResource(ORG_A));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/tenant isolation/i);
  });

  it("regression (review): DENIES (fails CLOSED, not open) when the match_result resource has a null ownerOrgId — can()'s existing null-ownerOrgId guard, exercised for real against this new resource type", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    const decision = can(merchant, "match.read", matchResource(null));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no ownerOrgId/i);
  });

  it("DENIES matching.evaluate even for its own opportunity — operator-triggered only", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    expect(can(merchant, "matching.evaluate", matchResource(ORG_A)).allowed).toBe(false);
  });
});

describe("can() — earlier Matching: ACQUIRER_PROVIDER_USER via participantActions (a provider is never the resource's ownerOrgId — mirrors rfq.read/deal.read exactly, ADR-0008's mechanism applied to a new instance-verification shape)", () => {
  it("DENIES a plain cross-org read with no verified participant context — the SAME 'own capacity was evaluated' standing must be established by the caller first", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    expect(can(provider, "match.read", matchResource(ORG_A)).allowed).toBe(false);
  });

  it("ALLOWS read/list once context.isParticipant is true — the caller (the matching service) has verified this MatchResult's capacityId belongs to the provider's own org", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    const decision = can(provider, "match.read", matchResource(ORG_A), { isParticipant: true });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/participant/i);
    expect(can(provider, "match.list", matchResource(ORG_A), { isParticipant: true }).allowed).toBe(true);
  });

  it("does NOT grant match.read merely because the provider owns capacity in general — isParticipant must be explicitly asserted per call, never inferred by can() itself (can() has no database access)", () => {
    const provider = actor({ organizationId: ORG_B, role: "ACQUIRER_PROVIDER_USER" });
    expect(can(provider, "match.read", matchResource(ORG_A), { isParticipant: false }).allowed).toBe(false);
    expect(can(provider, "match.read", matchResource(ORG_A)).allowed).toBe(false);
  });
});

// ================================================================
// earlier: Economics (P15)
// ================================================================

function scheduleResource(ownerOrgId: string | null): Resource {
  return { type: "commission_schedule", id: "schedule-1", ownerOrgId };
}
function revenueEventResource(ownerOrgId: string | null): Resource {
  return { type: "revenue_event", id: "revenue-event-1", ownerOrgId };
}
/**
 * apps/api's economics service (this stage) MUST always pass `ownerOrgId:
 * null` for a commission_accrual resource check (actions.ts's own
 * Resource.ownerOrgId comment) — every test below constructs it that
 * way, proving the mechanism forces cross-org-or-participant-only access
 * even though a real CommissionAccrual row DOES have a real dealRoomId
 * (and, through it, a real merchant org) — that merchant org is
 * deliberately never used as this resource's authz ownerOrgId.
 */
function ledgerResource(): Resource {
  return { type: "commission_accrual", id: "accrual-1", ownerOrgId: null };
}

describe("can() — earlier Economics: schedule.manage (PLATFORM_OWNER only — p.4's verbatim 'no rate editing without authority')", () => {
  it("ALLOWS PLATFORM_OWNER to manage a schedule cross-org", () => {
    const owner = actor({ organizationId: ORG_B, role: "PLATFORM_OWNER" });
    const decision = can(owner, "schedule.manage", scheduleResource(ORG_A));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/cross-org/i);
  });

  it("DENIES FINANCE_OPERATOR schedule.manage entirely — deny-by-default, not merely non-cross-org, even for its OWN org's deal", () => {
    const finance = actor({ organizationId: ORG_A, role: "FINANCE_OPERATOR" });
    const decision = can(finance, "schedule.manage", scheduleResource(ORG_A));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/deny-by-default|not granted/i);
  });

  it("DENIES every other persona schedule.manage, own-org or cross-org", () => {
    for (const role of ALL_PERSONA_ROLES) {
      if (role === "PLATFORM_OWNER") continue;
      expect(can(actor({ organizationId: ORG_A, role }), "schedule.manage", scheduleResource(ORG_A)).allowed, `${role} own-org`).toBe(false);
      expect(can(actor({ organizationId: ORG_B, role }), "schedule.manage", scheduleResource(ORG_A)).allowed, `${role} cross-org`).toBe(false);
    }
  });
});

describe("can() — earlier Economics: schedule.read/list and economics.read/list/record (FINANCE_OPERATOR + PLATFORM_OWNER cross-org; AUDITOR_READONLY read-only cross-org)", () => {
  it("ALLOWS FINANCE_OPERATOR to read/list/record cross-org", () => {
    const finance = actor({ organizationId: ORG_B, role: "FINANCE_OPERATOR" });
    expect(can(finance, "schedule.read", scheduleResource(ORG_A)).allowed).toBe(true);
    expect(can(finance, "schedule.list", scheduleResource(ORG_A)).allowed).toBe(true);
    expect(can(finance, "economics.read", revenueEventResource(ORG_A)).allowed).toBe(true);
    expect(can(finance, "economics.list", revenueEventResource(ORG_A)).allowed).toBe(true);
    expect(can(finance, "economics.record", revenueEventResource(ORG_A)).allowed).toBe(true);
  });

  it("ALLOWS AUDITOR_READONLY to read/list cross-org, but DENIES economics.record — 'No mutation' is structural", () => {
    const auditor = actor({ organizationId: ORG_B, role: "AUDITOR_READONLY" });
    expect(can(auditor, "schedule.read", scheduleResource(ORG_A)).allowed).toBe(true);
    expect(can(auditor, "economics.read", revenueEventResource(ORG_A)).allowed).toBe(true);
    expect(can(auditor, "economics.record", revenueEventResource(ORG_A)).allowed).toBe(false);
  });

  it("DENIES MARKETPLACE_OPERATOR entirely — no p.4 scope tie to economics (that's FINANCE_OPERATOR/PLATFORM_OWNER's turf), even though it holds broad cross-org grants for almost everything else", () => {
    const marketOp = actor({ organizationId: ORG_B, role: "MARKETPLACE_OPERATOR" });
    expect(can(marketOp, "schedule.read", scheduleResource(ORG_A)).allowed).toBe(false);
    expect(can(marketOp, "economics.read", revenueEventResource(ORG_A)).allowed).toBe(false);
  });
});

describe("can() — earlier Economics: ledger.read/list — the traceable ledger's own access shape (cross-org oversight vs. own-accrual-only participant, NEVER an ordinary same-org owner path)", () => {
  const LEDGER_CROSS_ORG_ROLES = ["PLATFORM_OWNER", "FINANCE_OPERATOR", "AUDITOR_READONLY"] as const;
  const LEDGER_PARTICIPANT_ROLES = ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"] as const;

  it("ALLOWS every named oversight role to read/list the WHOLE ledger cross-org, even though the resource's own ownerOrgId is null", () => {
    for (const role of LEDGER_CROSS_ORG_ROLES) {
      const reviewer = actor({ organizationId: ORG_B, role });
      expect(can(reviewer, "ledger.read", ledgerResource()).allowed, `${role} read`).toBe(true);
      expect(can(reviewer, "ledger.list", ledgerResource()).allowed, `${role} list`).toBe(true);
    }
  });

  it("DENIES a plain read with no verified participant context, for every party-side role — this is the P15 privacy proof: nobody sees the whole ledger just by being A party to the deal", () => {
    for (const role of LEDGER_PARTICIPANT_ROLES) {
      const party = actor({ organizationId: ORG_A, role });
      const decision = can(party, "ledger.read", ledgerResource());
      expect(decision.allowed, `${role} without isParticipant`).toBe(false);
      expect(decision.reason).toMatch(/no ordinary same-org owner path/i);
    }
  });

  it("ALLOWS read/list once context.isParticipant is true — the caller (the economics service) has verified recipientOrgId === actor.organizationId on the SPECIFIC accrual being read", () => {
    for (const role of LEDGER_PARTICIPANT_ROLES) {
      const party = actor({ organizationId: ORG_A, role });
      const decision = can(party, "ledger.read", ledgerResource(), { isParticipant: true });
      expect(decision.allowed, `${role} with isParticipant`).toBe(true);
      expect(decision.reason).toMatch(/participant/i);
      expect(can(party, "ledger.list", ledgerResource(), { isParticipant: true }).allowed, `${role} list with isParticipant`).toBe(true);
    }
  });

  it("regression guard for the null-ownerOrgId-by-design shape: DENIES (fails CLOSED) rather than silently allowing when neither cross-org nor a verified participant context applies — proves ledgerResource()'s null ownerOrgId can never be satisfied by an ordinary same-org path, unlike every other resource type in this codebase", () => {
    const party = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    expect(can(party, "ledger.read", ledgerResource(), { isParticipant: false }).allowed).toBe(false);
  });

  it("DENIES ledger.record_payment and ledger.adjust for every party-side role, even with a verified participant context — payout evidence and corrections stay FINANCE_OPERATOR/PLATFORM_OWNER-only, never a party's own act even on its own accrual", () => {
    for (const role of LEDGER_PARTICIPANT_ROLES) {
      const party = actor({ organizationId: ORG_A, role });
      expect(can(party, "ledger.record_payment", ledgerResource(), { isParticipant: true }).allowed, `${role} record_payment`).toBe(false);
      expect(can(party, "ledger.adjust", ledgerResource(), { isParticipant: true }).allowed, `${role} adjust`).toBe(false);
    }
  });

  it("ALLOWS FINANCE_OPERATOR to record a payment and an adjustment cross-org", () => {
    const finance = actor({ organizationId: ORG_B, role: "FINANCE_OPERATOR" });
    expect(can(finance, "ledger.record_payment", ledgerResource()).allowed).toBe(true);
    expect(can(finance, "ledger.adjust", ledgerResource()).allowed).toBe(true);
  });

  it("DENIES CONTRIBUTOR_AGENT entirely from schedule.*/economics.* — its own accrual entries via ledger.read/list are the full extent of this role's earlier visibility, matching p.4's 'cannot inspect private competing records'", () => {
    const contributor = actor({ organizationId: ORG_A, role: "CONTRIBUTOR_AGENT" });
    expect(can(contributor, "schedule.read", scheduleResource(ORG_A)).allowed).toBe(false);
    expect(can(contributor, "economics.read", revenueEventResource(ORG_A)).allowed).toBe(false);
  });

  it("hardening (review): DENIES ledger.read even when a caller passes a REAL, matching ownerOrgId by mistake — proves the same-org fallback is categorically unreachable for commission_accrual, not merely conventionally avoided by always passing null", () => {
    const merchant = actor({ organizationId: ORG_A, role: "MERCHANT_PSP_USER" });
    // A hypothetical careless call site handing can() the deal's real
    // merchant org as ownerOrgId (exactly what actions.ts's own doc
    // comment says must never happen) — must still be denied.
    const misconfigured: Resource = { type: "commission_accrual", id: "accrual-1", ownerOrgId: ORG_A };
    const decision = can(merchant, "ledger.read", misconfigured);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no ordinary same-org owner path/i);
  });
});
