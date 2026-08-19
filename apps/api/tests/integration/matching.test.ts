// apps/api/tests/integration/matching.test.ts
//
// P11/P12 gate proof (the spec: "Hard-rule determinism" / "Explainable
// factors + versions") through the real HTTP surface, against the real
// docker-compose Postgres, with REAL eligibility/ranking via
// @tol/matching's evaluateEligibility()/rankMatches() — no hand-computed
// or fabricated breakdown anywhere in this file's own assertions. Proves,
// end to end through actual HTTP round trips: evaluate -> rank -> read;
// determinism (identical inputs reproduce an identical per-candidate
// breakdown through the real API + DB, not just at the pure
// @tol/matching unit level already proven by that package's own 104
// tests); tenant isolation (an outsider org cannot evaluate/read matches
// for an opportunity it has no rights to; a provider's list view is
// scoped to ONLY its own capacity's row).
//
// NOTE ON GLOBAL STATE: `capacityProfileRepository.list()` (the
// candidate pool matchingService.evaluate() queries) is genuinely
// cross-org/cross-test-file — other integration test files' own
// CapacityProfile fixtures are real rows in the SAME shared Postgres and
// DO enter this file's own evaluate() calls as additional candidates.
// Every assertion below is written to stay true regardless of that
// (>= / contains / per-entity-by-id checks, never an exact total count
// or an assumed #1 rank) — same discipline the rest of this codebase's
// integration suites already use for any query that isn't scoped to one
// fixture's own id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, matchResultRepository, newId, prisma } from "@tol/db";
import { buildTestApp, createFixtureOpportunity, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

/** A READY Passport, created directly (fixture setup, not via the passport service's own transition chain — same "direct prisma create" convention as createFixtureOpportunity/createFixtureCapacityProfile in build-test-app.ts). */
async function createFixtureReadyPassport(organizationId: string, userId: string): Promise<{ id: string }> {
  const passport = await prisma.passport.create({
    data: { id: newId(), organizationId, status: "READY", privacyClass: "MEMBER_MARKET", createdByUserId: userId, createdByOrgId: organizationId },
  });
  return { id: passport.id };
}

/** A fresh, ELIGIBLE CapacityProfile — jurisdiction/MCC/currency chosen to overlap createFixtureOpportunity's own US/5411/USD defaults, with ample headroom (opportunity's own movable30dMinor default is well under this profile's monthlyCapacityMinor). */
async function createFixtureEligibleCapacity(providerOrgId: string, userId: string): Promise<{ id: string; providerOrgId: string }> {
  const profile = await prisma.capacityProfile.create({
    data: {
      id: newId(),
      providerOrgId,
      asOf: new Date(),
      freshnessClass: "FRESH",
      acceptingNewVolume: true,
      jurisdictions: ["US"],
      mccsAccepted: ["5411"],
      mccsExcluded: [],
      currency: "USD",
      monthlyCapacityMinor: 50_000_000_00n,
      minTicketMinor: 100,
      maxTicketMinor: 500_000,
      maxChargebackBps: 200,
      maxFraudBps: 200,
      maxRefundBps: 500,
      settlementRail: "ACH",
      settlementCadenceDays: 2,
      commercialTerms: { mdrBps: 250, fixedFeeMinor: 20, model: "blended" },
      privacyClass: "RESTRICTED",
      createdByUserId: userId,
      createdByOrgId: providerOrgId,
    },
  });
  return { id: profile.id, providerOrgId: profile.providerOrgId };
}

/** A deliberately INELIGIBLE CapacityProfile — mismatched jurisdiction/MCC/currency, no overlap with the fixture opportunity at all. */
async function createFixtureIneligibleCapacity(providerOrgId: string, userId: string): Promise<{ id: string }> {
  const profile = await prisma.capacityProfile.create({
    data: {
      id: newId(),
      providerOrgId,
      asOf: new Date(),
      freshnessClass: "FRESH",
      acceptingNewVolume: true,
      jurisdictions: ["DE"],
      mccsAccepted: ["7995"],
      mccsExcluded: [],
      currency: "EUR",
      monthlyCapacityMinor: 10_000_000_00n,
      minTicketMinor: 100,
      maxTicketMinor: 100_000,
      settlementRail: "SEPA",
      settlementCadenceDays: 3,
      privacyClass: "RESTRICTED",
      createdByUserId: userId,
      createdByOrgId: providerOrgId,
    },
  });
  return { id: profile.id };
}

describe("P11/P12 — Matching: evaluate -> rank -> read through the real HTTP surface", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let eligibleProvider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let ineligibleProvider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let merchantSession: { cookie: string; csrf: string };
  let operatorSession: { cookie: string; csrf: string };
  let eligibleProviderSession: { cookie: string; csrf: string };
  let outsiderSession: { cookie: string; csrf: string };
  let opportunity: { id: string; ownerOrgId: string };
  let eligibleCapacity: { id: string; providerOrgId: string };
  let ineligibleCapacity: { id: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstPassMatches: any[];

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "MatchMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    operator = await createFixtureOrgWithUser({ orgLabel: "MatchOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    eligibleProvider = await createFixtureOrgWithUser({ orgLabel: "EligibleProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    ineligibleProvider = await createFixtureOrgWithUser({ orgLabel: "IneligibleProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "MatchOutsider", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });

    merchantSession = await login(app, merchant.user.email, merchant.user.password);
    operatorSession = await login(app, operator.user.email, operator.user.password);
    eligibleProviderSession = await login(app, eligibleProvider.user.email, eligibleProvider.user.password);
    outsiderSession = await login(app, outsider.user.email, outsider.user.password);

    opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);

    await createFixtureReadyPassport(eligibleProvider.org.id, eligibleProvider.user.id);
    eligibleCapacity = await createFixtureEligibleCapacity(eligibleProvider.org.id, eligibleProvider.user.id);
    ineligibleCapacity = await createFixtureIneligibleCapacity(ineligibleProvider.org.id, ineligibleProvider.user.id);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  describe("authz: matching.evaluate is operator-only (the spec 'Create invite sets', operator-assisted framing)", () => {
    it("DENIES the merchant (opportunity owner) from evaluating its own opportunity — operator-triggered only", async () => {
      const res = await app.inject({ method: "POST", url: `/opportunities/${opportunity.id}/matches/evaluate`, headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf } });
      expect(res.statusCode).toBe(403);
    });

    it("DENIES a provider from evaluating", async () => {
      const res = await app.inject({ method: "POST", url: `/opportunities/${opportunity.id}/matches/evaluate`, headers: { cookie: eligibleProviderSession.cookie, "x-csrf-token": eligibleProviderSession.csrf } });
      expect(res.statusCode).toBe(403);
    });

    it("DENIES an outsider org entirely", async () => {
      const res = await app.inject({ method: "POST", url: `/opportunities/${opportunity.id}/matches/evaluate`, headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("evaluate -> rank (the real engine, through real HTTP)", () => {
    it("ALLOWS the operator to evaluate — 201, returns both the eligible+ranked and the ineligible candidate", async () => {
      const res = await app.inject({ method: "POST", url: `/opportunities/${opportunity.id}/matches/evaluate`, headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf } });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      firstPassMatches = body.matches;
      expect(Array.isArray(firstPassMatches)).toBe(true);
      // >= 2, not exactly 2 — the candidate pool is genuinely cross-org
      // (see this file's header comment); other test files' own
      // CapacityProfile fixtures may also appear here.
      expect(firstPassMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("the eligible capacity is ranked (a real positive integer, never null) with a real, explainable 9-factor breakdown — never a bare total", () => {
      const row = firstPassMatches.find((m) => m.capacityId === eligibleCapacity.id);
      expect(row).toBeTruthy();
      expect(row.eligible).toBe(true);
      expect(row.rank).toBeGreaterThan(0);
      expect(row.rankingBreakdown).toBeTruthy();
      expect(row.rankingBreakdown.factors).toHaveLength(9);
      expect(new Set(row.rankingBreakdown.factors.map((f: { factor: string }) => f.factor)).size).toBe(9);
      expect(row.rankingBreakdown.algorithmVersion).toBeTruthy();
      expect(typeof row.totalScore).toBe("number");
      expect(row.totalScore).toBe(row.rankingBreakdown.total);
    });

    it("the ineligible capacity carries real blockers and a null ranking breakdown — eligibility runs first, structurally, through the real API", () => {
      const row = firstPassMatches.find((m) => m.capacityId === ineligibleCapacity.id);
      expect(row).toBeTruthy();
      expect(row.eligible).toBe(false);
      expect(row.rank).toBeNull();
      expect(row.rankingBreakdown).toBeNull();
      expect(row.totalScore).toBeNull();
      expect(row.algorithmVersion).toBeNull();
      expect(row.blockers.length).toBeGreaterThan(0);
      expect(row.blockers.some((b: { code: string }) => b.code === "JURISDICTION_NO_OVERLAP")).toBe(true);
    });

    it("every rule family appears in the eligible row's results trace, PASS or not — full transparency, not just failures", () => {
      const row = firstPassMatches.find((m) => m.capacityId === eligibleCapacity.id);
      const families = new Set(row.results.map((r: { rule: string }) => r.rule));
      for (const family of ["ROLE", "JURISDICTION", "MCC_PRODUCT", "VOLUME_TICKET", "EVIDENCE_LICENSE", "RISK", "SETTLEMENT", "TECHNICAL", "FRESHNESS", "COMPLIANCE_HOLD"]) {
        expect(families.has(family), `results trace missing rule family ${family}`).toBe(true);
      }
    });

    it("stamps ruleVersion/algorithmVersion/inputVersions on every row — the spec's 'record inputVersion(s), ruleVersion, algorithmVersion so historical decisions can be reproduced'", () => {
      const row = firstPassMatches.find((m) => m.capacityId === eligibleCapacity.id);
      expect(row.ruleVersion).toBeTruthy();
      expect(row.algorithmVersion).toBeTruthy();
      expect(row.inputVersions.length).toBeGreaterThan(0);
      expect(row.inputVersions.some((v: string) => v.startsWith(`opportunity:${opportunity.id}`))).toBe(true);
      expect(row.inputVersions.some((v: string) => v.startsWith(`capacity:${eligibleCapacity.id}`))).toBe(true);
    });
  });

  describe("GET matches — read the persisted results, scoped by role (tenant isolation)", () => {
    it("the operator reads the full list for this opportunity", async () => {
      const res = await app.inject({ method: "GET", url: `/opportunities/${opportunity.id}/matches`, headers: { cookie: operatorSession.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().matches.length).toBeGreaterThanOrEqual(2);
    });

    it("the merchant (opportunity owner) reads its own opportunity's matches — own-org ownerOrgId path, no participantActions needed", async () => {
      const res = await app.inject({ method: "GET", url: `/opportunities/${opportunity.id}/matches`, headers: { cookie: merchantSession.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().matches.length).toBeGreaterThanOrEqual(2);
    });

    it("THE PROOF: an outsider org (no rights to this SPECIFIC opportunity) gets a clean 403, not a 200 — this endpoint is nested under one opportunityId (unlike the blanket GET /rfqs collection rfqsService.list's own isParticipant:true-unconditional pattern serves), so it behaves like rfqsService.getById's instance-scoped tenant-isolation check, not like a 'list my own stuff' collection query where an empty result is the normal answer for an unrelated org. A real review-caught test-authoring mistake this file's own first run surfaced: the test originally asserted 200-empty here and failed against the real API, which was CORRECT — the test's own assumption was wrong, fixed here rather than loosening the service", async () => {
      const res = await app.inject({ method: "GET", url: `/opportunities/${opportunity.id}/matches`, headers: { cookie: outsiderSession.cookie } });
      expect(res.statusCode).toBe(403);
    });

    it("THE PROOF: the eligible provider sees ONLY its own capacity's match row for this opportunity, never the ineligible candidate's — p.4 'See only invited packets and own history' extended to matching", async () => {
      const res = await app.inject({ method: "GET", url: `/opportunities/${opportunity.id}/matches`, headers: { cookie: eligibleProviderSession.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.matches).toHaveLength(1);
      expect(body.matches[0].capacityId).toBe(eligibleCapacity.id);
    });

    it("404s reading matches for a nonexistent opportunity", async () => {
      const res = await app.inject({ method: "GET", url: "/opportunities/00000000-0000-7000-8000-0000000000ff/matches", headers: { cookie: operatorSession.cookie } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("determinism — identical inputs reproduce an identical per-candidate breakdown through the real API + DB (the spec/p.20)", () => {
    it("re-evaluating the SAME opportunity produces byte-identical eligibility results and ranking factors for the eligible capacity — a NEW row (append-only), not an update, but the SAME computed content", async () => {
      const res = await app.inject({ method: "POST", url: `/opportunities/${opportunity.id}/matches/evaluate`, headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf } });
      expect(res.statusCode).toBe(201);
      const secondPassMatches = res.json().matches;

      const first = firstPassMatches.find((m) => m.capacityId === eligibleCapacity.id);
      const second = secondPassMatches.find((m: { capacityId: string }) => m.capacityId === eligibleCapacity.id);

      // Genuinely per-pair, pure values — independent of what ELSE exists
      // in the shared candidate pool at either moment, so safe to assert
      // exact equality even though this test file shares Postgres with
      // every other integration suite.
      expect(second.eligible).toBe(first.eligible);
      expect(second.results).toEqual(first.results);
      expect(second.blockers).toEqual(first.blockers);
      expect(second.totalScore).toBe(first.totalScore);
      expect(second.rankingBreakdown.factors).toEqual(first.rankingBreakdown.factors);
      expect(second.rankingBreakdown.total).toBe(first.rankingBreakdown.total);
      expect(second.rankingBreakdown.algorithmVersion).toBe(first.rankingBreakdown.algorithmVersion);
      expect(second.ruleVersion).toBe(first.ruleVersion);
      // Append-only: a genuinely NEW row, never an update to the first.
      expect(second.id).not.toBe(first.id);
    });

    it("the same real determinism holds for the ineligible capacity too — identical blockers, still null ranking data", async () => {
      const res = await app.inject({ method: "POST", url: `/opportunities/${opportunity.id}/matches/evaluate`, headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf } });
      const matches = res.json().matches;
      const row = matches.find((m: { capacityId: string }) => m.capacityId === ineligibleCapacity.id);
      const original = firstPassMatches.find((m) => m.capacityId === ineligibleCapacity.id);
      expect(row.eligible).toBe(false);
      expect(row.blockers).toEqual(original.blockers);
      expect(row.rankingBreakdown).toBeNull();
    });
  });

  describe("idempotency — a retried evaluate call does not create a second batch (the spec: 'Idempotency-Key when duplicate network retries could create a second record')", () => {
    it("the SAME Idempotency-Key on two evaluate calls returns the identical response body, replayed not recomputed", async () => {
      const idempotencyKey = `test-matching-evaluate-${newId()}`;
      const firstRes = await app.inject({
        method: "POST",
        url: `/opportunities/${opportunity.id}/matches/evaluate`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf, "idempotency-key": idempotencyKey },
      });
      const secondRes = await app.inject({
        method: "POST",
        url: `/opportunities/${opportunity.id}/matches/evaluate`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf, "idempotency-key": idempotencyKey },
      });
      expect(firstRes.statusCode).toBe(201);
      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.json()).toEqual(firstRes.json());
    });
  });

  describe("input validation", () => {
    it("400s when evaluating an opportunity that isn't MATCH_READY/INVITED", async () => {
      const closedOpp = await createFixtureOpportunity(merchant.org.id, merchant.user.id);
      await prisma.opportunity.update({ where: { id: closedOpp.id }, data: { status: "CLOSED" } });
      const res = await app.inject({ method: "POST", url: `/opportunities/${closedOpp.id}/matches/evaluate`, headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf } });
      expect(res.statusCode).toBe(400);
    });

    it("404s when evaluating a nonexistent opportunity", async () => {
      const res = await app.inject({ method: "POST", url: "/opportunities/00000000-0000-7000-8000-0000000000ff/matches/evaluate", headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("repository tie-break determinism (Follow-up fix — packages/db/src/repositories/match-result.repository.ts)", () => {
    it("when two MatchResult rows for the SAME capacity share the exact same evaluatedAt millisecond, listLatestByOpportunity's de-dup picks the SAME row every call — never flapping — and picks it BY the documented rule (smallest id), not by incidental DB row order", async () => {
      // Manufactures the exact race the repository's own comment
      // describes: "two rows for the SAME capacity could legitimately
      // share the exact same evaluatedAt millisecond (e.g. a batch
      // evaluation run sharing one `now` reference)". Before the fix,
      // findMany had no orderBy, so which of these two rows won the
      // in-memory de-dup Map was whatever unspecified order Postgres
      // returned them in — not guaranteed stable across calls/plans.
      const tiedAt = new Date();
      const tieA = await matchResultRepository.create(prisma, {
        opportunityId: opportunity.id,
        capacityId: eligibleCapacity.id,
        eligible: true,
        eligibilityResults: [{ rule: "TEST_TIE", code: "TEST_TIE_A", status: "PASS" }],
        ruleVersion: "test-tie-v1",
        rankingBreakdown: { factors: [], total: 11.1, algorithmVersion: "test-tie-v1" },
        rank: 1,
        totalScore: 11.1,
        algorithmVersion: "test-tie-v1",
        inputVersions: ["test:tie-a"],
        evaluatedAt: tiedAt,
      });
      const tieB = await matchResultRepository.create(prisma, {
        opportunityId: opportunity.id,
        capacityId: eligibleCapacity.id,
        eligible: true,
        eligibilityResults: [{ rule: "TEST_TIE", code: "TEST_TIE_B", status: "PASS" }],
        ruleVersion: "test-tie-v1",
        rankingBreakdown: { factors: [], total: 22.2, algorithmVersion: "test-tie-v1" },
        rank: 1,
        totalScore: 22.2,
        algorithmVersion: "test-tie-v1",
        inputVersions: ["test:tie-b"],
        evaluatedAt: tiedAt,
      });

      // Confirm the manufactured tie is real (genuinely the same instant,
      // genuinely two distinct rows) before trusting the assertions below.
      expect(tieA.evaluatedAt.getTime()).toBe(tieB.evaluatedAt.getTime());
      expect(tieA.id).not.toBe(tieB.id);
      const expectedWinnerId = tieA.id < tieB.id ? tieA.id : tieB.id;

      for (let i = 0; i < 5; i++) {
        const all = await matchResultRepository.listLatestByOpportunity(prisma, opportunity.id);
        const winner = all.find((m) => m.capacityId === eligibleCapacity.id);
        expect(winner).toBeTruthy();
        expect(winner!.id).toBe(expectedWinnerId);
      }
    });
  });
});
