import { describe, expect, it } from "vitest";
import { AUTHORITY_MATRIX } from "./matrix.js";
import { PERSONA_ROLES } from "./roles.js";
import { ACTIONS } from "./actions.js";

describe("AUTHORITY_MATRIX — structural invariants", () => {
  it("has exactly one entry per PersonaRole, no more, no fewer", () => {
    expect(Object.keys(AUTHORITY_MATRIX).sort()).toEqual([...PERSONA_ROLES].sort());
  });

  it("only ever grants actions that exist in the Action vocabulary", () => {
    const validActions = new Set(ACTIONS);
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.allowedActions) {
        expect(validActions.has(action), `${role} grants unknown action "${action}"`).toBe(true);
      }
    }
  });

  it("never grants a crossOrgAction that isn't also in allowedActions", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.crossOrgActions) {
        expect(grant.allowedActions.has(action), `${role}: crossOrgActions has "${action}" not in allowedActions`).toBe(
          true,
        );
      }
    }
  });

  it("earlier: never grants a participantAction that isn't also in allowedActions (same invariant as crossOrgActions)", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.participantActions) {
        expect(
          grant.allowedActions.has(action),
          `${role}: participantActions has "${action}" not in allowedActions`,
        ).toBe(true);
      }
    }
  });

  it("earlier update of the earlier invariant: exactly ACQUIRER_PROVIDER_USER, CONTRIBUTOR_AGENT, and MERCHANT_PSP_USER have any participantActions — every other role's access is either cross-org or ordinary same-org", () => {
    const rolesWithParticipantActions = new Set(["ACQUIRER_PROVIDER_USER", "CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER"]);
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (rolesWithParticipantActions.has(role)) {
        expect(grant.participantActions.size, `${role} should have participantActions`).toBeGreaterThan(0);
      } else {
        expect(grant.participantActions.size, `${role} should have zero participantActions`).toBe(0);
      }
    }
  });

  it("earlier phases: only ACQUIRER_PROVIDER_USER's participantActions cover the earlier rfq.*/deal.* set — CONTRIBUTOR_AGENT and MERCHANT_PSP_USER's participantActions are claim.dispute + ledger.read/list (own accruals, earlier), not an earlier regression and not a broader grant than that", () => {
    expect(AUTHORITY_MATRIX["CONTRIBUTOR_AGENT"]!.participantActions).toEqual(new Set(["claim.dispute", "ledger.read", "ledger.list"]));
    expect(AUTHORITY_MATRIX["MERCHANT_PSP_USER"]!.participantActions).toEqual(new Set(["claim.dispute", "ledger.read", "ledger.list"]));
    expect(AUTHORITY_MATRIX["ACQUIRER_PROVIDER_USER"]!.participantActions.has("claim.dispute")).toBe(true);
    expect(AUTHORITY_MATRIX["ACQUIRER_PROVIDER_USER"]!.participantActions.has("rfq.read")).toBe(true);
  });

  it("earlier: claim.dispute is in EVERY claimant-side role's participantActions, never in crossOrgActions (standing must be service-verified, not a blanket grant — see actions.ts's AuthContext.isParticipant comment)", () => {
    for (const role of ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"] as const) {
      expect(AUTHORITY_MATRIX[role].participantActions.has("claim.dispute")).toBe(true);
      expect(AUTHORITY_MATRIX[role].crossOrgActions.has("claim.dispute")).toBe(false);
    }
  });

  it("earlier: rfq.create is granted to exactly PLATFORM_OWNER and MARKETPLACE_OPERATOR — operator-assisted model, not merchant self-service", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("rfq.create"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["MARKETPLACE_OPERATOR", "PLATFORM_OWNER"]);
  });

  it("AUDITOR_READONLY has zero write actions — 'No mutation' (p.4) verified structurally", () => {
    const writeActions = new Set([
      "organization.update",
      "membership.create",
      "membership.update_role",
      "membership.update_status",
      "person.update",
      // earlier
      "lockbox.seal",
      "lockbox.withdraw",
      "lockbox.release",
    ]);
    const auditorActions = AUTHORITY_MATRIX["AUDITOR_READONLY"]!.allowedActions;
    for (const action of auditorActions) {
      expect(writeActions.has(action), `AUDITOR_READONLY should not have write action "${action}"`).toBe(false);
    }
  });

  it("membership.update_role is granted to exactly one role (PLATFORM_OWNER)", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("membership.update_role"))
      .map(([role]) => role);
    expect(rolesWithGrant).toEqual(["PLATFORM_OWNER"]);
  });

  // ================================================================
  // earlier: Lockbox structural invariants — the matrix-level proof
  // backing can.test.ts's behavioral tests. These check EVERY role's
  // matrix entry directly, which is a stronger guarantee than testing
  // can() against a handful of sampled (role, action) pairs.
  // ================================================================

  it("lockbox.release is granted to exactly PLATFORM_OWNER and MARKETPLACE_OPERATOR — the escrowed-release model is operator-triggered, never self-service (ADR-0001/ADR-0009)", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("lockbox.release"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["MARKETPLACE_OPERATOR", "PLATFORM_OWNER"]);
  });

  it("lockbox.withdraw is NEVER in any role's crossOrgActions — 'only the sealer org can withdraw' is a structural guarantee across the WHOLE matrix, not just the roles exercised in can.test.ts", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      expect(grant.crossOrgActions.has("lockbox.withdraw"), `${role} must not have lockbox.withdraw in crossOrgActions`).toBe(
        false,
      );
    }
  });

  it("lockbox.seal is granted to exactly the four 'has a relationship to seal' personas", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("lockbox.seal"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["ACQUIRER_PROVIDER_USER", "CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "PLATFORM_OWNER"]);
  });

  it("every role granted lockbox.seal is ALSO granted lockbox.withdraw (a sealer must always be able to withdraw its own act — never a party that can seal but is then structurally stuck)", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("lockbox.seal")) {
        expect(grant.allowedActions.has("lockbox.withdraw"), `${role} can seal but not withdraw`).toBe(true);
      }
    }
  });

  it("no ORG-LEVEL role (the ones a sealer actually is) has lockbox.seal/withdraw AND lockbox.release together — the escrow model's core separation of authority. PLATFORM_OWNER is the sole, deliberate exception: its broad 'can do everything' pattern already applies identically to every other action pair in this matrix (e.g. it alone also holds membership.update_role), and having every lockbox action too still doesn't let it release WITHOUT the crypto-layer 2-of-3 threshold — this test asserts the separation holds for every role where it's the actual security boundary, not the one role that's a deliberate superuser everywhere else too.", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (role === "PLATFORM_OWNER") continue;
      const canSealOrWithdraw = grant.allowedActions.has("lockbox.seal") || grant.allowedActions.has("lockbox.withdraw");
      const canRelease = grant.allowedActions.has("lockbox.release");
      expect(canSealOrWithdraw && canRelease, `${role} should not have both seal/withdraw AND release`).toBe(false);
    }
  });

  it("no role has any lockbox.* action in participantActions — Lockbox is single-sided (sealerOrgId is the only ownerOrgId), unlike RFQ/DealRoom", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.participantActions) {
        expect(action.startsWith("lockbox."), `${role} should not have a lockbox.* participantAction ("${action}")`).toBe(
          false,
        );
      }
    }
  });

  // ================================================================
  // earlier: Attribution (P10) structural invariants
  // ================================================================

  it("claim.decide is granted to exactly the four decider personas (the spec: Journey A's reviewer + 'relationship provenance' [Partnership Lead] + 'review restricted claims' [Compliance Reviewer])", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("claim.decide"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["COMPLIANCE_REVIEWER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "PLATFORM_OWNER"]);
  });

  it("claim.decide is ALWAYS cross-org for every role that holds it — a reviewer deciding its OWN org's claim would be self-certification, never intended", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("claim.decide")) {
        expect(grant.crossOrgActions.has("claim.decide"), `${role} has claim.decide but not cross-org`).toBe(true);
      }
    }
  });

  it("no role holds BOTH claim.create and claim.decide cross-org — the claimant/reviewer separation is structural, not just convention (PLATFORM_OWNER is the interesting case: it holds both, but create is deliberately own-org-only while decide is cross-org, so it can never decide its OWN claim through the cross-org grant — see the next test)", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      const createsCrossOrg = grant.crossOrgActions.has("claim.create");
      const decidesCrossOrg = grant.crossOrgActions.has("claim.decide");
      expect(createsCrossOrg && decidesCrossOrg, `${role} should never hold both claim.create AND claim.decide cross-org`).toBe(false);
    }
  });

  it("PLATFORM_OWNER's claim.create/claim.dispute are absent from crossOrgActions — same 'own-org even for the superuser role' carve-out shape as lockbox.withdraw (ADR-0001), now applied to claim filing/disputing", () => {
    const owner = AUTHORITY_MATRIX["PLATFORM_OWNER"]!;
    expect(owner.allowedActions.has("claim.create")).toBe(true);
    expect(owner.crossOrgActions.has("claim.create")).toBe(false);
    expect(owner.allowedActions.has("claim.dispute")).toBe(true);
    expect(owner.crossOrgActions.has("claim.dispute")).toBe(false);
  });

  it("claim.create is granted to exactly the three claimant-side personas plus PLATFORM_OWNER (own-org anti-squatting seeding, the spec)", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("claim.create"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["ACQUIRER_PROVIDER_USER", "CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "PLATFORM_OWNER"]);
  });

  it("every role granted claim.create is ALSO granted claim.read and claim.list — a claimant must always be able to see what it just filed", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("claim.create")) {
        expect(grant.allowedActions.has("claim.read"), `${role} can create but not read`).toBe(true);
        expect(grant.allowedActions.has("claim.list"), `${role} can create but not list`).toBe(true);
      }
    }
  });

  it("no role has any claim.* action in participantActions except claim.dispute — read/list/create/decide are all plain same-org-or-cross-org, only dispute needs verified per-instance standing", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.participantActions) {
        if (action.startsWith("claim.")) {
          expect(action, `${role}'s only claim.* participantAction should be claim.dispute, got "${action}"`).toBe("claim.dispute");
        }
      }
    }
  });

  it("no role ever grants the SAME action through both crossOrgActions and participantActions at once — the two are mutually exclusive access paths for every action, not just claim.*, consolidating 10 near-duplicate review findings (review) into one general structural proof", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.crossOrgActions) {
        expect(grant.participantActions.has(action), `${role}: "${action}" is in BOTH crossOrgActions and participantActions`).toBe(false);
      }
    }
  });

  // ================================================================
  // earlier: P6 Passport + P5 Marketplace structural invariants.
  // ================================================================

  it("passport.verify is granted to exactly the three verifier personas (PLATFORM_OWNER, MARKETPLACE_OPERATOR, COMPLIANCE_REVIEWER) — a NARROWER set than claim.decide's four deciders (PARTNERSHIP_LEAD is deliberately excluded, see matrix.ts's own comment)", () => {
    const rolesWithVerify = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("passport.verify"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithVerify).toEqual(["COMPLIANCE_REVIEWER", "MARKETPLACE_OPERATOR", "PLATFORM_OWNER"]);
  });

  it("passport.verify is ALWAYS cross-org for every role that holds it — self-verification would defeat the reviewer step entirely", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("passport.verify")) {
        expect(grant.crossOrgActions.has("passport.verify"), `${role} holds passport.verify but not cross-org`).toBe(true);
      }
    }
  });

  it("opportunity.browse_market and capacity.browse_market are granted to EVERY ONE of the 10 personas, always cross-org — the spec's blanket 'Members can see market depth' verified structurally across the whole matrix, not just the personas exercised in can.test.ts", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      expect(grant.allowedActions.has("opportunity.browse_market"), `${role} missing opportunity.browse_market`).toBe(true);
      expect(grant.allowedActions.has("capacity.browse_market"), `${role} missing capacity.browse_market`).toBe(true);
      expect(grant.crossOrgActions.has("opportunity.browse_market"), `${role}'s opportunity.browse_market is not cross-org`).toBe(true);
      expect(grant.crossOrgActions.has("capacity.browse_market"), `${role}'s capacity.browse_market is not cross-org`).toBe(true);
    }
  });

  it("every role granted passport.create is ALSO granted passport.read and passport.update — a maintainer must always be able to see and edit what it just created (same 'create implies read' shape as claim.create -> claim.read/list)", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("passport.create")) {
        expect(grant.allowedActions.has("passport.read"), `${role} has passport.create but not passport.read`).toBe(true);
        expect(grant.allowedActions.has("passport.update"), `${role} has passport.create but not passport.update`).toBe(true);
      }
    }
  });

  it("passport.create/update are NEVER in any role's crossOrgActions, not even PLATFORM_OWNER's — maintaining a Passport's factual content is always an act taken AS that org, same 'own-org even for the superuser role' carve-out shape as lockbox.withdraw (ADR-0001) and claim.create/dispute", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      expect(grant.crossOrgActions.has("passport.create"), `${role}: passport.create should never be cross-org`).toBe(false);
      expect(grant.crossOrgActions.has("passport.update"), `${role}: passport.update should never be cross-org`).toBe(false);
    }
  });

  it("no role has any passport.* or *_browse_market action in participantActions — both are single-sided (an ordinary owner-or-cross-org resource), unlike RFQ/DealRoom's genuinely two-sided isParticipant mechanism", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.participantActions) {
        expect(action.startsWith("passport.") || action.includes("browse_market"), `${role}'s participantActions unexpectedly includes "${action}"`).toBe(false);
      }
    }
  });

  it("FINANCE_OPERATOR holds zero passport.* actions — the one deliberate persona-wide exclusion, verified structurally rather than only in a single can.test.ts case", () => {
    const financeGrant = AUTHORITY_MATRIX["FINANCE_OPERATOR"];
    const financePassportActions = [...financeGrant.allowedActions].filter((a) => a.startsWith("passport."));
    expect(financePassportActions).toEqual([]);
  });

  // ================================================================
  // earlier: Matching (P11 Eligibility + P12 Ranking) structural invariants.
  // ================================================================

  it("matching.evaluate is granted to exactly PLATFORM_OWNER and MARKETPLACE_OPERATOR — same operator-assisted shape as rfq.create/lockbox.release, verified structurally", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("matching.evaluate"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["MARKETPLACE_OPERATOR", "PLATFORM_OWNER"]);
  });

  it("matching.evaluate is ALWAYS cross-org for every role that holds it", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("matching.evaluate")) {
        expect(grant.crossOrgActions.has("matching.evaluate"), `${role} holds matching.evaluate but not cross-org`).toBe(true);
      }
    }
  });

  it("every role granted matching.evaluate is ALSO granted match.read AND match.list — an evaluator must always be able to see what it just triggered", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("matching.evaluate")) {
        expect(grant.allowedActions.has("match.read"), `${role} can evaluate but not read`).toBe(true);
        expect(grant.allowedActions.has("match.list"), `${role} can evaluate but not list`).toBe(true);
      }
    }
  });

  it("match.read/match.list cross-org role set is exactly the six reviewer/oversight personas", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.crossOrgActions.has("match.read") && grant.crossOrgActions.has("match.list"))
      .map(([role]) => role)
      .sort();
    expect(rolesWithGrant).toEqual(["COMPLIANCE_REVIEWER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "PLATFORM_OWNER", "UNDERWRITING_ANALYST", "AUDITOR_READONLY"].sort());
  });

  it("ACQUIRER_PROVIDER_USER's match.read/match.list are in participantActions, NOT crossOrgActions — a provider is never the resource's ownerOrgId, same shape as its rfq.read/deal.read grants", () => {
    const provider = AUTHORITY_MATRIX["ACQUIRER_PROVIDER_USER"]!;
    expect(provider.participantActions.has("match.read")).toBe(true);
    expect(provider.participantActions.has("match.list")).toBe(true);
    expect(provider.crossOrgActions.has("match.read")).toBe(false);
    expect(provider.crossOrgActions.has("match.list")).toBe(false);
    expect(provider.allowedActions.has("matching.evaluate")).toBe(false);
  });

  it("MERCHANT_PSP_USER's match.read/match.list are plain own-org (neither crossOrgActions nor participantActions) — the ordinary resource-owner path, no extra mechanism needed", () => {
    const merchant = AUTHORITY_MATRIX["MERCHANT_PSP_USER"]!;
    expect(merchant.allowedActions.has("match.read")).toBe(true);
    expect(merchant.allowedActions.has("match.list")).toBe(true);
    expect(merchant.crossOrgActions.has("match.read")).toBe(false);
    expect(merchant.participantActions.has("match.read")).toBe(false);
    expect(merchant.allowedActions.has("matching.evaluate")).toBe(false);
  });

  it("FINANCE_OPERATOR and CONTRIBUTOR_AGENT hold zero match.* actions — deliberate persona-wide exclusions (no scope tie), verified structurally", () => {
    for (const role of ["FINANCE_OPERATOR", "CONTRIBUTOR_AGENT"] as const) {
      const matchActions = [...AUTHORITY_MATRIX[role].allowedActions].filter((a) => a.startsWith("match") || a === "matching.evaluate");
      expect(matchActions, `${role} should hold zero match.* actions`).toEqual([]);
    }
  });

  it("matching.evaluate is NEVER in any role's participantActions — triggering a match run is operator-only (crossOrgActions or nothing), never a per-instance participant grant, same class of proof as lockbox.withdraw's own crossOrgActions exclusion (review, adopted)", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      expect(grant.participantActions.has("matching.evaluate"), `${role} must not have matching.evaluate in participantActions`).toBe(false);
    }
  });

  // ================================================================
  // earlier: Economics (P15) structural invariants.
  // ================================================================

  it("schedule.manage is granted to EXACTLY PLATFORM_OWNER — p.4's own verbatim 'no rate editing without authority' ceiling for FINANCE_OPERATOR, verified structurally across every role, not just FINANCE_OPERATOR", () => {
    const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
      .filter(([, grant]) => grant.allowedActions.has("schedule.manage"))
      .map(([role]) => role);
    expect(rolesWithGrant).toEqual(["PLATFORM_OWNER"]);
  });

  it("FINANCE_OPERATOR holds schedule.read/list, economics.read/list/record, and ledger.read/list/record_payment/adjust — but NOT schedule.manage", () => {
    const finance = AUTHORITY_MATRIX["FINANCE_OPERATOR"]!;
    for (const action of ["schedule.read", "schedule.list", "economics.read", "economics.list", "economics.record", "ledger.read", "ledger.list", "ledger.record_payment", "ledger.adjust"] as const) {
      expect(finance.allowedActions.has(action), `FINANCE_OPERATOR should hold "${action}"`).toBe(true);
      expect(finance.crossOrgActions.has(action), `FINANCE_OPERATOR's "${action}" should be cross-org`).toBe(true);
    }
    expect(finance.allowedActions.has("schedule.manage")).toBe(false);
  });

  it("ledger.record_payment and ledger.adjust are granted to EXACTLY PLATFORM_OWNER and FINANCE_OPERATOR — payout evidence and corrections are an authority-restricted mutation, never available to an ordinary party even for its own accrual", () => {
    for (const action of ["ledger.record_payment", "ledger.adjust"] as const) {
      const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
        .filter(([, grant]) => grant.allowedActions.has(action))
        .map(([role]) => role)
        .sort();
      expect(rolesWithGrant, `${action} role set`).toEqual(["FINANCE_OPERATOR", "PLATFORM_OWNER"]);
    }
  });

  it("ledger.read/ledger.list cross-org role set is exactly the three named oversight personas (PLATFORM_OWNER, FINANCE_OPERATOR, AUDITOR_READONLY)", () => {
    for (const action of ["ledger.read", "ledger.list"] as const) {
      const rolesWithGrant = Object.entries(AUTHORITY_MATRIX)
        .filter(([, grant]) => grant.crossOrgActions.has(action))
        .map(([role]) => role)
        .sort();
      expect(rolesWithGrant, `${action} cross-org role set`).toEqual(["AUDITOR_READONLY", "FINANCE_OPERATOR", "PLATFORM_OWNER"]);
    }
  });

  it("ledger.read/ledger.list via participantActions ('own accruals only') is exactly the three party-side personas (CONTRIBUTOR_AGENT, MERCHANT_PSP_USER, ACQUIRER_PROVIDER_USER) — never crossOrgActions for any of the three, matching the claim.dispute standing-verification precedent", () => {
    for (const role of ["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"] as const) {
      const grant = AUTHORITY_MATRIX[role];
      expect(grant.participantActions.has("ledger.read"), `${role} should have ledger.read via participantActions`).toBe(true);
      expect(grant.participantActions.has("ledger.list"), `${role} should have ledger.list via participantActions`).toBe(true);
      expect(grant.crossOrgActions.has("ledger.read"), `${role}'s ledger.read must NOT be cross-org`).toBe(false);
      expect(grant.crossOrgActions.has("ledger.list"), `${role}'s ledger.list must NOT be cross-org`).toBe(false);
    }
  });

  it("AUDITOR_READONLY holds zero economics MUTATION actions — 'No mutation' (p.4) extends to schedule.manage/economics.record/ledger.record_payment/ledger.adjust, the same structural guarantee as every other resource", () => {
    const auditor = AUTHORITY_MATRIX["AUDITOR_READONLY"]!;
    for (const action of ["schedule.manage", "economics.record", "ledger.record_payment", "ledger.adjust"] as const) {
      expect(auditor.allowedActions.has(action), `AUDITOR_READONLY should not hold "${action}"`).toBe(false);
    }
    // But it DOES hold every read-shaped economics action, cross-org, same as every other resource.
    for (const action of ["schedule.read", "schedule.list", "economics.read", "economics.list", "ledger.read", "ledger.list"] as const) {
      expect(auditor.allowedActions.has(action), `AUDITOR_READONLY should hold "${action}"`).toBe(true);
      expect(auditor.crossOrgActions.has(action), `AUDITOR_READONLY's "${action}" should be cross-org`).toBe(true);
    }
  });

  it("MARKETPLACE_OPERATOR, PARTNERSHIP_LEAD, UNDERWRITING_ANALYST, and COMPLIANCE_REVIEWER hold ZERO economics actions — deliberate persona-wide exclusions (no p.4 scope tie to economics, that role is FINANCE_OPERATOR/PLATFORM_OWNER), same 'no scope tie, don't grant' discipline as FINANCE_OPERATOR's own zero match.*/passport.* actions", () => {
    const economicsPrefixes = ["schedule.", "economics.", "ledger."];
    for (const role of ["MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "UNDERWRITING_ANALYST", "COMPLIANCE_REVIEWER"] as const) {
      const economicsActions = [...AUTHORITY_MATRIX[role].allowedActions].filter((a) => economicsPrefixes.some((p) => a.startsWith(p)));
      expect(economicsActions, `${role} should hold zero economics actions`).toEqual([]);
    }
  });

  it("every role granted economics.record is ALSO granted economics.read AND economics.list — a recorder must always be able to see what it just recorded", () => {
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      if (grant.allowedActions.has("economics.record")) {
        expect(grant.allowedActions.has("economics.read"), `${role} can record but not read`).toBe(true);
        expect(grant.allowedActions.has("economics.list"), `${role} can record but not list`).toBe(true);
      }
    }
  });

  it("no role ever grants schedule.*/economics.*/ledger.* through both crossOrgActions and participantActions at once — same mutual-exclusivity invariant as every other action family (review's general proof, re-verified for the three new earlier resources specifically)", () => {
    const economicsPrefixes = ["schedule.", "economics.", "ledger."];
    for (const [role, grant] of Object.entries(AUTHORITY_MATRIX)) {
      for (const action of grant.crossOrgActions) {
        if (economicsPrefixes.some((p) => action.startsWith(p))) {
          expect(grant.participantActions.has(action), `${role}: "${action}" is in BOTH crossOrgActions and participantActions`).toBe(false);
        }
      }
    }
  });
});
