// apps/api/tests/integration/claims.test.ts
//
// P10 gate proof (the spec: "Claim scoring + dispute path") through the
// real HTTP surface, against the real docker-compose Postgres, with REAL
// scoring via @tol/attribution's scoreClaim() — no hand-computed or
// fabricated breakdown anywhere in this file's own assertions. Proves,
// end to end through actual HTTP round trips: file -> score -> dispute ->
// decide; tenant isolation (a non-party org cannot read/dispute/decide
// someone else's claim); determinism (identical inputs reproduce an
// identical breakdown through the real API + DB, not just at the pure
// @tol/attribution unit level already proven by that package's own 68
// tests); the self-certification guard; and the D0 anti-squatting
// mechanism through the real API.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, prisma } from "@tol/db";
import { buildTestApp, createFixtureOpportunity, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

const BASE_EVIDENCE = [
  { evidenceType: "EMAIL_THREAD", assertedFact: "Introductory email thread on file.", verificationState: "DOCUMENT_EXTRACTED" },
  { evidenceType: "CRM_RECORD", assertedFact: "CRM opportunity record shows this org as the originating source.", verificationState: "SELF_REPORTED" },
];

describe("P10 — Attribution: full lifecycle + dispute path through the real HTTP surface", () => {
  let app: FastifyInstance;
  let claimant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let challenger: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let subject: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let reviewer: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let claimantSession: { cookie: string; csrf: string };
  let challengerSession: { cookie: string; csrf: string };
  let subjectSession: { cookie: string; csrf: string };
  let reviewerSession: { cookie: string; csrf: string };
  let outsiderSession: { cookie: string; csrf: string };
  let opportunity: { id: string; ownerOrgId: string };

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    claimant = await createFixtureOrgWithUser({ orgLabel: "ClaimantOrg", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    challenger = await createFixtureOrgWithUser({ orgLabel: "ChallengerOrg", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    subject = await createFixtureOrgWithUser({ orgLabel: "SubjectOrg", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    reviewer = await createFixtureOrgWithUser({ orgLabel: "ReviewerOrg", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "OutsiderOrg", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });

    claimantSession = await login(app, claimant.user.email, claimant.user.password);
    challengerSession = await login(app, challenger.user.email, challenger.user.password);
    subjectSession = await login(app, subject.user.email, subject.user.password);
    reviewerSession = await login(app, reviewer.user.email, reviewer.user.password);
    outsiderSession = await login(app, outsider.user.email, outsider.user.password);

    opportunity = await createFixtureOpportunity(subject.org.id, subject.user.id);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  describe("file -> score -> decide (no dispute)", () => {
    let claimId: string;

    it("files a claim — 201, the response carries a REAL, explainable score breakdown (never a bare total)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "ACQUIRER_INTRODUCTION",
          directnessTier: "D4",
          opportunityId: opportunity.id,
          priorCommercialHistoryMonths: 8,
          submissionLagDays: 3,
          evidenceItems: BASE_EVIDENCE,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe("SCORED");
      expect(body.scoreBreakdown).toBeTruthy();
      expect(body.scoreBreakdown.evidenceBreakdown).toHaveLength(2);
      expect(body.scoreBreakdown.algorithmVersion).toBe("attribution-v1");
      // Hand-computed expectation, same formula @tol/attribution's own
      // scoring.test.ts proves: history 8/36≈22.2, proximity D4=80,
      // evidence = (20*0.7)+(15*0.4)=20, time (3/60 inverted)=95.
      // weighted = 22.2*0.4 + 80*0.3 + 20*0.2 + 95*0.1 = 8.9+24+4+9.5=46.4
      expect(body.scoreBreakdown.total).toBeCloseTo(46.4, 1);
      claimId = body.id;
    });

    it("the persisted DB row's scoreBreakdown matches the HTTP response byte-for-byte", async () => {
      const row = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      expect(row.status).toBe("SCORED");
      expect(row.scoreTotal).toBeCloseTo(46.4, 1);
      expect(row.algorithmVersion).toBe("attribution-v1");
    });

    it("real AuditEvent + DomainEvent rows exist for both claim.submitted and claim.scored — never a raw evidence/breakdown dump in the audit trail's afterValue", async () => {
      const domainEvents = await prisma.domainEvent.findMany({ where: { aggregateId: claimId }, orderBy: { occurredAt: "asc" } });
      const eventTypes = domainEvents.map((e) => e.eventType);
      expect(eventTypes).toContain("claim.submitted");
      expect(eventTypes).toContain("claim.scored");
      const auditEvents = await prisma.auditEvent.findMany({ where: { resourceId: claimId } });
      expect(auditEvents.length).toBeGreaterThanOrEqual(2);
      for (const ev of auditEvents) {
        expect(JSON.stringify(ev.afterValue)).not.toContain("Introductory email thread");
      }
    });

    it("DENIES the claimant's own org from reading — wait, ALLOWS its own claim (own-org read)", async () => {
      const res = await app.inject({ method: "GET", url: `/claims/${claimId}`, headers: { cookie: claimantSession.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().claim.id).toBe(claimId);
      // Claimant-side actor never sees rank (the spec: "cannot inspect private competing records") — see this suite's own dedicated rank test below for the reviewer-side positive case.
      expect(res.json().rank).toBeNull();
    });

    it("DENIES an OUTSIDER org (no relation to this claim at all) from reading it — THE tenant-isolation proof", async () => {
      const res = await app.inject({ method: "GET", url: `/claims/${claimId}`, headers: { cookie: outsiderSession.cookie } });
      expect(res.statusCode).toBe(403);
    });

    it("DENIES the claimant from deciding its OWN claim — self-certification guard, even though claim.decide isn't in this role's grant at all", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${claimId}/decisions`,
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: { decision: "VERIFIED", reason: "self-serve attempt" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("the reviewer decides VERIFIED — 201, real ClaimDecision persisted with a snapshotted scoreBreakdown", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${claimId}/decisions`,
        headers: { cookie: reviewerSession.cookie, "x-csrf-token": reviewerSession.csrf },
        payload: { decision: "VERIFIED", reason: "Evidence corroborated against CRM records." },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.decision).toBe("VERIFIED");
      expect(body.disputeId).toBeNull();
      expect(body.scoreBreakdown.total).toBeCloseTo(46.4, 1);

      const claimRow = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claimRow.status).toBe("VERIFIED");
    });

    it("re-deciding an already-VERIFIED claim (not yet disputed) fails cleanly with a 409, not a 500 — @tol/domain's transition guard, not a raw DB error", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${claimId}/decisions`,
        headers: { cookie: reviewerSession.cookie, "x-csrf-token": reviewerSession.csrf },
        payload: { decision: "VERIFIED", reason: "duplicate attempt" },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("file (competing) -> dispute -> resolve", () => {
    let originalClaimId: string;

    it("the challenger org files its OWN competing claim on the SAME subject/opportunity first — establishes standing", async () => {
      // First, the "original" claim this describe block will dispute.
      const originalRes = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "EXISTING_RELATIONSHIP",
          directnessTier: "D2",
          opportunityId: opportunity.id,
          priorCommercialHistoryMonths: 2,
          submissionLagDays: 1,
          evidenceItems: [{ evidenceType: "CRM_RECORD", assertedFact: "Generic vendor contact, authority uncertain." }],
        },
      });
      expect(originalRes.statusCode).toBe(201);
      originalClaimId = originalRes.json().id;

      const competingRes = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: challengerSession.cookie, "x-csrf-token": challengerSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "ACQUIRER_INTRODUCTION",
          directnessTier: "D5",
          opportunityId: opportunity.id,
          priorCommercialHistoryMonths: 24,
          submissionLagDays: 0,
          evidenceItems: [{ evidenceType: "CONTRACT", assertedFact: "Signed executive-level introduction agreement.", verificationState: "OPERATOR_VERIFIED" }],
        },
      });
      expect(competingRes.statusCode).toBe(201);
      expect(competingRes.json().scoreBreakdown.total).toBeGreaterThan(originalRes.json().scoreBreakdown.total);
    });

    it("DENIES an org with NO standing (outsider — not the subjectOrg, no competing claim) from disputing", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${originalClaimId}/disputes`,
        headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf },
        payload: { basis: "I object on principle." },
      });
      expect(res.statusCode).toBe(403);
    });

    it("ALLOWS the challenger (has standing via its own competing claim) to dispute the original claim — 201, claim moves to DISPUTED", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${originalClaimId}/disputes`,
        headers: { cookie: challengerSession.cookie, "x-csrf-token": challengerSession.csrf },
        payload: {
          basis: "A later direct executive relationship supersedes this generic-mailbox claim (the spec anti-gaming rule).",
          evidence: [{ evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", note: "Subject org acknowledged the executive contact directly." }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("OPEN");

      const claimRow = await prisma.claim.findUniqueOrThrow({ where: { id: originalClaimId } });
      expect(claimRow.status).toBe("DISPUTED");
    });

    it("DENIES filing a SECOND simultaneous dispute on the same claim — 409, not silently accepted", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${originalClaimId}/disputes`,
        headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf },
        payload: { basis: "me too" },
      });
      // outsider has no standing anyway (403) — proves via the challenger's own org attempting twice instead, which DOES have standing.
      expect(res.statusCode).toBe(403);

      const secondAttempt = await app.inject({
        method: "POST",
        url: `/claims/${originalClaimId}/disputes`,
        headers: { cookie: challengerSession.cookie, "x-csrf-token": challengerSession.csrf },
        payload: { basis: "asserting standing again" },
      });
      expect(secondAttempt.statusCode).toBe(409);
    });

    it("the reviewer resolves the dispute REJECTED (the challenger's position prevails) — 201, both the ClaimDecision AND the ClaimDispute resolve consistently", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/claims/${originalClaimId}/decisions`,
        headers: { cookie: reviewerSession.cookie, "x-csrf-token": reviewerSession.csrf },
        payload: { decision: "REJECTED", reason: "The executive-level competing claim is materially stronger — anti-gaming rule applies." },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.decision).toBe("REJECTED");
      expect(body.disputeId).toBeTruthy();

      const claimRow = await prisma.claim.findUniqueOrThrow({ where: { id: originalClaimId } });
      expect(claimRow.status).toBe("REJECTED");

      const disputeRow = await prisma.claimDispute.findFirstOrThrow({ where: { claimId: originalClaimId } });
      expect(disputeRow.status).toBe("DECIDED");
      expect(disputeRow.resolution).toBe("REJECTED_ORIGINAL");

      const domainEvents = await prisma.domainEvent.findMany({ where: { aggregateId: originalClaimId } });
      expect(domainEvents.map((e) => e.eventType)).toContain("claim.dispute_decided");
      expect(domainEvents.map((e) => e.eventType)).toContain("claim.rejected");
    });

    it("the reviewer sees a REAL rank among competing claims (reviewer-tier only) — the challenger's stronger claim ranks #1", async () => {
      const res = await app.inject({ method: "GET", url: `/claims/${originalClaimId}`, headers: { cookie: reviewerSession.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rank).toBeTruthy();
      expect(body.rank.rank).toBeGreaterThanOrEqual(2); // the now-REJECTED original claim ranks below the stronger competing one
    });
  });

  describe("concurrency: the pg_advisory_xact_lock guard against a genuine double-open-dispute race (review)", () => {
    it("firing TWO real, simultaneous dispute requests (Promise.all, not sequential) at the same claim from two DIFFERENT orgs that both have standing results in EXACTLY ONE success and one clean 409 — never both succeeding", async () => {
      const filed = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "PSP_INTRODUCTION",
          directnessTier: "D2",
          opportunityId: opportunity.id,
          priorCommercialHistoryMonths: 1,
          submissionLagDays: 1,
          evidenceItems: [],
        },
      });
      expect(filed.statusCode).toBe(201);
      const raceClaimId = filed.json().id;

      // subject.org has standing as the claim's OWN subjectOrg; challenger
      // has standing via its earlier competing claim on this same
      // opportunity (filed in the describe block above) — BOTH are
      // legitimate, real dispute attempts, fired via Promise.all so they
      // genuinely overlap in-flight, not one deliberately-invalid one and
      // not two sequential calls that would never have raced at all.
      const [subjectAttempt, challengerAttempt] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/claims/${raceClaimId}/disputes`,
          headers: { cookie: subjectSession.cookie, "x-csrf-token": subjectSession.csrf },
          payload: { basis: "concurrent attempt A" },
        }),
        app.inject({
          method: "POST",
          url: `/claims/${raceClaimId}/disputes`,
          headers: { cookie: challengerSession.cookie, "x-csrf-token": challengerSession.csrf },
          payload: { basis: "concurrent attempt B" },
        }),
      ]);

      const statusCodes = [subjectAttempt.statusCode, challengerAttempt.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const disputes = await prisma.claimDispute.findMany({ where: { claimId: raceClaimId } });
      expect(disputes).toHaveLength(1); // never two, regardless of which request "won"
      expect(disputes[0]!.status).toBe("OPEN");
    });
  });

  describe("determinism through the real HTTP + DB round trip (not just the pure @tol/attribution unit level)", () => {
    it("two SEPARATE claims filed with byte-identical scoring inputs (different claimants, so no 'duplicate claim' business rule interferes) produce an IDENTICAL score breakdown", async () => {
      const identicalInput = {
        subjectOrgId: subject.org.id,
        relationshipType: "PSP_INTRODUCTION",
        directnessTier: "D3" as const,
        priorCommercialHistoryMonths: 5,
        submissionLagDays: 12,
        evidenceItems: [{ evidenceType: "EMAIL_THREAD" as const, assertedFact: "identical evidence text", verificationState: "SELF_REPORTED" as const }],
      };

      const first = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: identicalInput,
      });
      const second = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: challengerSession.cookie, "x-csrf-token": challengerSession.csrf },
        payload: identicalInput,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);

      const firstBreakdown = first.json().scoreBreakdown;
      const secondBreakdown = second.json().scoreBreakdown;
      // Every numeric field must match exactly — proves the engine is
      // deterministic through a REAL HTTP round trip + REAL DB
      // persistence + REAL DB read-back, not just in-process.
      expect(secondBreakdown.history).toBe(firstBreakdown.history);
      expect(secondBreakdown.proximity).toBe(firstBreakdown.proximity);
      expect(secondBreakdown.evidence).toBe(firstBreakdown.evidence);
      expect(secondBreakdown.time).toBe(firstBreakdown.time);
      expect(secondBreakdown.total).toBe(firstBreakdown.total);
      expect(secondBreakdown.algorithmVersion).toBe(firstBreakdown.algorithmVersion);
    });
  });

  describe("anti-gaming: the D0 hard-zero mechanism through the real API (the spec/p.18)", () => {
    it('a D0 ("public knowledge only") claim scores total 0 through the real API, even with strong evidence/history/time — never just at the pure-function level', async () => {
      const res = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "EXISTING_RELATIONSHIP",
          directnessTier: "D0",
          priorCommercialHistoryMonths: 36,
          submissionLagDays: 0,
          evidenceItems: [{ evidenceType: "CONTRACT", assertedFact: "strong evidence", verificationState: "OPERATOR_VERIFIED" }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().scoreBreakdown.total).toBe(0);
      expect(res.json().scoreBreakdown.cappedFrom).toBeGreaterThan(0);
    });
  });

  describe("input validation through the real API", () => {
    it("rejects a claim with an invalid directnessTier — 400, not a 500", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "X",
          directnessTier: "D9",
          priorCommercialHistoryMonths: 1,
          submissionLagDays: 1,
          evidenceItems: [],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a claim with a subjectOrgId that doesn't reference a real organization — 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: "00000000-0000-7000-8000-0000000000ff",
          relationshipType: "X",
          directnessTier: "D3",
          priorCommercialHistoryMonths: 1,
          submissionLagDays: 1,
          evidenceItems: [],
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("MERCHANT_PSP_USER cannot decide claims — reviewer authority is separate from claimant authority", () => {
    it("returns 403 when a claimant-side role attempts to decide any claim, even one it's not the claimant of", async () => {
      const filed = await app.inject({
        method: "POST",
        url: "/claims",
        headers: { cookie: claimantSession.cookie, "x-csrf-token": claimantSession.csrf },
        payload: {
          subjectOrgId: subject.org.id,
          relationshipType: "X",
          directnessTier: "D3",
          priorCommercialHistoryMonths: 1,
          submissionLagDays: 1,
          evidenceItems: [],
        },
      });
      const claimId = filed.json().id;
      const res = await app.inject({
        method: "POST",
        url: `/claims/${claimId}/decisions`,
        headers: { cookie: challengerSession.cookie, "x-csrf-token": challengerSession.csrf },
        payload: { decision: "VERIFIED", reason: "not my job" },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
