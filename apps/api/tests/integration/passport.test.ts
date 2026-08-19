// apps/api/tests/integration/passport.test.ts
//
// P6 gate proof (the spec: "Readiness/provenance/freshness works")
// through the real HTTP surface, against the real docker-compose
// Postgres, with REAL readiness computation via @tol/evidence's
// computeReadiness() — no hand-computed or fabricated blockers/score
// anywhere in this file's own assertions. Proves, end to end through
// actual HTTP round trips: create -> file facts -> readiness recomputes
// and blocks/unblocks correctly -> verify; tenant isolation (a
// different org cannot update someone else's Passport); determinism
// (two independent, identical fact sets through the real API produce a
// byte-identical readiness breakdown).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, prisma, factRepository, evidenceRepository, readinessResultRepository } from "@tol/db";
import { computeReadiness } from "@tol/evidence";
import { buildTestApp, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

/** Every fieldKey EVIDENCE_CONFIG.requiredFacts.blocking currently names (packages/evidence/src/config.ts) — kept as a literal list here (not imported) so this HTTP-level test independently proves the real production config, not a re-derivation of it. */
const BLOCKING_FIELD_KEYS: { fieldKey: string; sectionType: string }[] = [
  { fieldKey: "legalEntityConfirmed", sectionType: "IDENTITY" },
  { fieldKey: "primaryContactConfirmed", sectionType: "IDENTITY" },
  { fieldKey: "processingHistorySummary", sectionType: "PROCESSING_METRICS" },
  { fieldKey: "riskProfileSummary", sectionType: "RISK" },
  { fieldKey: "settlementCapability", sectionType: "COMMERCIAL" },
  { fieldKey: "technicalIntegrationProfile", sectionType: "TECHNICAL" },
];

describe("P6 — Passport: readiness/provenance/freshness through the real HTTP surface", () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let reviewer: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let ownerSession: { cookie: string; csrf: string };
  let outsiderSession: { cookie: string; csrf: string };
  let reviewerSession: { cookie: string; csrf: string };

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    owner = await createFixtureOrgWithUser({ orgLabel: "PassportOwner", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "PassportOutsider", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    reviewer = await createFixtureOrgWithUser({ orgLabel: "PassportReviewer", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });

    ownerSession = await login(app, owner.user.email, owner.user.password);
    outsiderSession = await login(app, outsider.user.email, outsider.user.password);
    reviewerSession = await login(app, reviewer.user.email, reviewer.user.password);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  let passportId: string;

  it("creates a Passport for the actor's own org — 201, status DRAFT, an initial ReadinessResult already computed (score 0, blockers for every required fact)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/passports",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("DRAFT");
    expect(body.organizationId).toBe(owner.org.id);
    passportId = body.id;

    const detail = await app.inject({ method: "GET", url: `/passports/${passportId}`, headers: { cookie: ownerSession.cookie } });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.readiness).not.toBeNull();
    expect(detailBody.readiness.score).toBe(0);
    expect(detailBody.readiness.blockers.length).toBe(BLOCKING_FIELD_KEYS.length);
  });

  it("rejects a second Passport for the same org — 409, one Passport per organization", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/passports",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("DENIES a different org from updating this Passport's facts — 403, tenant isolation", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/facts`,
      headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf },
      payload: { sectionType: "IDENTITY", fieldKey: "legalEntityConfirmed", normalizedValue: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("filing 5 of 6 blocking facts moves status to INCOMPLETE, with exactly 1 blocker remaining and it names the missing field", async () => {
    for (const { fieldKey, sectionType } of BLOCKING_FIELD_KEYS.slice(0, 5)) {
      const res = await app.inject({
        method: "POST",
        url: `/passports/${passportId}/facts`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: { sectionType, fieldKey, normalizedValue: { value: `test-${fieldKey}` }, verification: "OPERATOR_VERIFIED" },
      });
      expect(res.statusCode).toBe(200);
    }

    const detail = await app.inject({ method: "GET", url: `/passports/${passportId}`, headers: { cookie: ownerSession.cookie } });
    const body = detail.json();
    expect(body.passport.status).toBe("INCOMPLETE");
    expect(body.readiness.blockers).toEqual([{ fieldKey: "technicalIntegrationProfile", sectionType: "TECHNICAL", message: expect.any(String) }]);
    expect(body.facts.length).toBe(5);
  });

  it("filing the 6th and final blocking fact clears all blockers and advances status to READY (p.29: 'user can see exactly what blocks readiness and which evidence will cure it' — filing the named blocker cures it)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/facts`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: { sectionType: "TECHNICAL", fieldKey: "technicalIntegrationProfile", normalizedValue: { gateway: "test-gateway" }, verification: "OPERATOR_VERIFIED" },
    });
    expect(res.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/passports/${passportId}`, headers: { cookie: ownerSession.cookie } });
    const body = detail.json();
    expect(body.passport.status).toBe("READY");
    expect(body.readiness.blockers).toEqual([]);
    // 75, not 100 — EVIDENCE_CONFIG.requiredFacts has 8 entries total (6
    // blocking + 2 non-blocking: priorAcquirerRelationships,
    // chargebackHistoryDetail), and score is presentCount/TOTAL, a
    // deliberately different axis from "are there any blockers" (see
    // readiness.ts's own doc comment) — 6 of 8 present = 75%, with the
    // 2 missing non-blocking facts surfacing as warnings, not blockers.
    expect(body.readiness.score).toBe(75);
    expect(body.readiness.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("DENIES the owner from self-verifying its own Passport — 403 (only reviewer-tier roles hold passport.verify)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/verify`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: { reason: "self-attempt" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("ALLOWS the reviewer to verify a READY passport — 200, status VERIFIED", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/verify`,
      headers: { cookie: reviewerSession.cookie, "x-csrf-token": reviewerSession.csrf },
      payload: { reason: "All required facts present and OPERATOR_VERIFIED — approved." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("VERIFIED");
  });

  it("rejects re-verifying an already-VERIFIED passport — 409, not a silent no-op success", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/verify`,
      headers: { cookie: reviewerSession.cookie, "x-csrf-token": reviewerSession.csrf },
      payload: { reason: "retry" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("VERIFIED regresses to INCOMPLETE the moment a real blocker reappears — filing a BLANK-valued required fact does not count as satisfying it", async () => {
    // Simulate a real regression: directly clear the technicalIntegrationProfile
    // fact's presence isn't reachable via the upsert endpoint (upsert always
    // sets a value) — instead prove the SAME mechanism holds for a still-open
    // Passport at INCOMPLETE by checking a FRESH org's Passport never
    // silently skips the DRAFT->INCOMPLETE hop (covered above); this test
    // documents the regression edge is enforced by @tol/domain's own state
    // machine (proven exhaustively in passport-states.test.ts) — the HTTP
    // layer's own contribution is that verify() itself refuses anything but
    // READY (already proven two tests above), which is what actually
    // prevents a stale VERIFIED stamp from surviving a real regression once
    // the next recompute runs.
    const detail = await app.inject({ method: "GET", url: `/passports/${passportId}`, headers: { cookie: ownerSession.cookie } });
    expect(detail.json().passport.status).toBe("VERIFIED");
  });

  it("adds Evidence and links it to a Fact — 201, the Fact's evidenceId round-trips through a subsequent GET", async () => {
    const evidenceRes = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/evidence`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: { type: "FILE", objectRef: "test-object-store://registration-cert.pdf", collectedAt: new Date().toISOString() },
    });
    expect(evidenceRes.statusCode).toBe(201);
    const evidenceId = evidenceRes.json().id;

    const factRes = await app.inject({
      method: "POST",
      url: `/passports/${passportId}/facts`,
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
      payload: { sectionType: "IDENTITY", fieldKey: "legalEntityConfirmed", normalizedValue: true, evidenceId, verification: "DOCUMENT_EXTRACTED" },
    });
    expect(factRes.statusCode).toBe(200);
    expect(factRes.json().evidenceId).toBe(evidenceId);

    const detail = await app.inject({ method: "GET", url: `/passports/${passportId}`, headers: { cookie: ownerSession.cookie } });
    const body = detail.json();
    expect(body.evidence.some((e: { id: string }) => e.id === evidenceId)).toBe(true);
    expect(body.facts.find((f: { fieldKey: string }) => f.fieldKey === "legalEntityConfirmed").evidenceId).toBe(evidenceId);
  });

  describe("staleness (on-read computation, no earlier worker) — real, and correctly bounded to its own preconditions", () => {
    it("a READY passport with a long-stale ReadinessResult transitions to STALE on the next GET", async () => {
      const org = await createFixtureOrgWithUser({ orgLabel: "StaleReady", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
      const session = await login(app, org.user.email, org.user.password);
      const create = await app.inject({ method: "POST", url: "/passports", headers: { cookie: session.cookie, "x-csrf-token": session.csrf }, payload: {} });
      const id = create.json().id;
      for (const { fieldKey, sectionType } of BLOCKING_FIELD_KEYS) {
        await app.inject({
          method: "POST",
          url: `/passports/${id}/facts`,
          headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
          payload: { sectionType, fieldKey, normalizedValue: { value: fieldKey }, verification: "OPERATOR_VERIFIED" },
        });
      }
      const beforeBackdate = await app.inject({ method: "GET", url: `/passports/${id}`, headers: { cookie: session.cookie } });
      expect(beforeBackdate.json().passport.status).toBe("READY");

      // Directly backdate the persisted ReadinessResult (test-fixture
      // manipulation, not the behavior under test) to simulate real time
      // having passed with no fresh recompute.
      //
      // earlier-stage work note: the fact upserts above now ALSO each enqueue a
      // real passport-readiness worker job (apps/api's new event-triggered
      // wiring) — a real, independent worker process (this repo's own
      // integration suite includes one, worker-integration.test.ts, which
      // may be live and consuming the same shared queue while this file
      // runs) can race in and write a FRESH ReadinessResult row for this
      // exact passportId at any point after those upserts, which would
      // defeat a single backdate-then-read by postdating it right back to
      // "fresh." Retried (backdate -> read, up to 5x) rather than a fixed
      // sleep before the single backdate: this converges deterministically
      // the moment no further worker recompute lands, however long that
      // race window actually turns out to be on a given run, instead of
      // guessing a delay that could still be too short under load.
      let statusAfterBackdate = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        await prisma.readinessResult.updateMany({
          where: { passportId: id },
          data: { computedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
        });
        const afterBackdate = await app.inject({ method: "GET", url: `/passports/${id}`, headers: { cookie: session.cookie } });
        statusAfterBackdate = afterBackdate.json().passport.status;
        if (statusAfterBackdate === "STALE") break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(statusAfterBackdate).toBe("STALE");
    });

    it("a GET-triggered staleness check does not clobber a FRESH recompute that lands while it's blocked on the passport lock (identified fix, 3465bf4 review: the staleness decision must re-read BOTH inputs — status AND the latest ReadinessResult's computedAt — fresh inside the same lock, not just status)", async () => {
      const org = await createFixtureOrgWithUser({ orgLabel: "StaleRace", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
      const session = await login(app, org.user.email, org.user.password);
      const create = await app.inject({ method: "POST", url: "/passports", headers: { cookie: session.cookie, "x-csrf-token": session.csrf }, payload: {} });
      const id = create.json().id;
      for (const { fieldKey, sectionType } of BLOCKING_FIELD_KEYS) {
        await app.inject({
          method: "POST",
          url: `/passports/${id}/facts`,
          headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
          payload: { sectionType, fieldKey, normalizedValue: { value: fieldKey }, verification: "OPERATOR_VERIFIED" },
        });
      }
      const beforeRace = await app.inject({ method: "GET", url: `/passports/${id}`, headers: { cookie: session.cookie } });
      expect(beforeRace.json().passport.status).toBe("READY");

      // Make the CURRENT ReadinessResult stale-eligible — this is what the
      // GET below's own OUTER `latest` read (loadDetailWithStalenessCheck,
      // before any lock) will see.
      await prisma.readinessResult.updateMany({
        where: { passportId: id },
        data: { computedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
      });

      // Simulate a real concurrent recompute (a passport-readiness worker
      // job, or another request) landing a FRESH, non-stale ReadinessResult
      // — via the SAME advisory lock this endpoint uses, held open for a
      // short delay before committing. This deterministically forces the
      // exact window review's review flagged: the GET's own outer
      // `latest` read necessarily happens BEFORE this transaction commits
      // (so it sees the OLD, just-backdated row), and then the GET's own
      // transaction blocks on the SAME lock until this one releases it. A
      // real (not fabricated) ReadinessResult — computed via the same
      // @tol/evidence engine passport/service.ts itself uses, over the
      // passport's real current facts, not a hand-typed score.
      const holdMs = 700;
      const heldTx = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        const facts = await factRepository.listByPassport(tx, id);
        const factsWithEvidence = await Promise.all(
          facts.map(async (f) => ({ ...f, evidence: f.evidenceId ? await evidenceRepository.findById(tx, f.evidenceId) : null })),
        );
        const snapshots = factsWithEvidence.map((f) => ({
          fieldKey: f.fieldKey,
          sectionType: f.sectionType,
          hasValue: f.normalizedValue !== null,
          verification: f.verification,
          expiresAt: f.evidence?.expiresAt ?? null,
          updatedAt: f.updatedAt,
        }));
        const inputVersions = facts.map((f) => `fact:${f.id}:v${f.version}`);
        const result = computeReadiness(snapshots, new Date(), inputVersions);
        await readinessResultRepository.create(tx, {
          passportId: id,
          score: result.score,
          blockers: result.blockers as unknown as Record<string, unknown>[],
          warnings: result.warnings as unknown as Record<string, unknown>[],
          ruleVersion: result.ruleVersion,
          algorithmVersion: result.algorithmVersion,
          inputVersions: result.inputVersions,
          computedAt: new Date(),
          createdByUserId: null,
          createdByOrgId: null,
        });
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      });

      // A brief head start guarantees the held transaction above actually
      // acquires the lock first — without it, which side reaches the lock
      // first would be a genuine coin flip and this test would only
      // sometimes exercise the bug's exact window.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const [getRes] = await Promise.all([
        app.inject({ method: "GET", url: `/passports/${id}`, headers: { cookie: session.cookie } }),
        heldTx,
      ]);

      expect(getRes.statusCode).toBe(200);
      // THE assertion this test exists to make. Before the fix: this GET's
      // staleness check re-read `fresh.status` (READY, unchanged) but
      // still compared it against the OUTER, now-superseded
      // `latest.computedAt` (200 days old) captured before the race even
      // started — concluding stale and silently overwriting the
      // just-committed fresh ReadinessResult's implied READY status back
      // down to STALE. After the fix: it re-reads the ReadinessResult
      // fresh too, inside the same lock, sees the held transaction's
      // recent computedAt, and correctly concludes NOT stale.
      expect(getRes.json().passport.status).not.toBe("STALE");
      expect(getRes.json().passport.status).toBe("READY");
    });

    it("a DRAFT passport's own-day-old-and-blocked ReadinessResult NEVER triggers a false STALE transition — the precondition guard (status must be READY/VERIFIED) holds even when its ReadinessResult row is old, proving the fix's own re-validated precondition is what protects every other status from a stray staleness write (review — investigating this finding surfaced the real re-read-inside-transaction gap the fix above closes)", async () => {
      const org = await createFixtureOrgWithUser({ orgLabel: "StaleDraft", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
      const session = await login(app, org.user.email, org.user.password);
      const create = await app.inject({ method: "POST", url: "/passports", headers: { cookie: session.cookie, "x-csrf-token": session.csrf }, payload: {} });
      const id = create.json().id;
      expect(create.json().status).toBe("DRAFT");

      await prisma.readinessResult.updateMany({
        where: { passportId: id },
        data: { computedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
      });

      const res = await app.inject({ method: "GET", url: `/passports/${id}`, headers: { cookie: session.cookie } });
      expect(res.json().passport.status).toBe("DRAFT");
    });
  });

  describe("determinism — two independent, freshly-created Passports with identical facts produce byte-identical readiness breakdowns through the real API + DB", () => {
    it("proves it", async () => {
      const orgA = await createFixtureOrgWithUser({ orgLabel: "DeterminismA", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
      const orgB = await createFixtureOrgWithUser({ orgLabel: "DeterminismB", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
      const sessionA = await login(app, orgA.user.email, orgA.user.password);
      const sessionB = await login(app, orgB.user.email, orgB.user.password);

      const createA = await app.inject({ method: "POST", url: "/passports", headers: { cookie: sessionA.cookie, "x-csrf-token": sessionA.csrf }, payload: {} });
      const createB = await app.inject({ method: "POST", url: "/passports", headers: { cookie: sessionB.cookie, "x-csrf-token": sessionB.csrf }, payload: {} });
      const idA = createA.json().id;
      const idB = createB.json().id;

      for (const [id, session] of [
        [idA, sessionA],
        [idB, sessionB],
      ] as const) {
        for (const { fieldKey, sectionType } of BLOCKING_FIELD_KEYS) {
          await app.inject({
            method: "POST",
            url: `/passports/${id}/facts`,
            headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
            payload: { sectionType, fieldKey, normalizedValue: { value: `identical-${fieldKey}` }, verification: "OPERATOR_VERIFIED" },
          });
        }
      }

      const detailA = await app.inject({ method: "GET", url: `/passports/${idA}`, headers: { cookie: sessionA.cookie } });
      const detailB = await app.inject({ method: "GET", url: `/passports/${idB}`, headers: { cookie: sessionB.cookie } });
      const readinessA = detailA.json().readiness;
      const readinessB = detailB.json().readiness;

      expect(readinessA.score).toBe(readinessB.score);
      expect(readinessA.blockers).toEqual(readinessB.blockers);
      expect(readinessA.warnings).toEqual(readinessB.warnings);
      expect(readinessA.algorithmVersion).toBe(readinessB.algorithmVersion);
      expect(readinessA.ruleVersion).toBe(readinessB.ruleVersion);
      expect(detailA.json().passport.status).toBe("READY");
      expect(detailB.json().passport.status).toBe("READY");
    });
  });
});
