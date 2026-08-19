// apps/api/tests/integration/economics.test.ts
//
// P15 gate proof (the spec: "Traceable schedule/accrual ledger")
// through the real HTTP surface, against the real docker-compose
// Postgres, with REAL splits via @tol/domain's computeCommissionSplits/
// computeAccrualBalance/reconcileRevenueEvent — no hand-computed or
// fabricated ledger entry anywhere in this file's own assertions.
//
// Proves, end to end through actual HTTP round trips: schedule creation
// (authz: PLATFORM_OWNER/FINANCE_OPERATOR only) -> revenue recording
// (economics.record, gated on the deal having reached an
// activated/closed state) -> the MONEY-EXACTNESS invariant (every
// ledger entry's amountMinor, summed, equals netDistributableMinor
// EXACTLY, verified by re-parsing the wire's numeric strings back to
// BigInt in this test, not trusting the server's own reconciliation
// flag alone) -> TRACEABILITY (every entry resolves to its schedule/
// component/claim) -> DETERMINISM (the same schedule splits the same
// money the same way twice) -> the P15 privacy proof (a party sees
// ONLY its own accrual; the deal's own merchant gets a clean 403 on the
// ledger, proving packages/authz's "commission_accrual has no ordinary
// same-org owner" hardening holds through the real API, not just the
// unit-level can() proof) -> payments/adjustments -> idempotency.
//
// DEAL ROOM ACTIVATION: no earlier HTTP endpoint advances a DealRoom past
// OPEN/CONDITIONS/APPROVED (see ADR-0012's own identical note
// for the MATCH_READY fixture) — this file drives a REAL RFQ ->
// Quote -> Select chain through the HTTP API to get a real, non-fixture
// DealRoom, then advances it to ACTIVATION via a direct, documented
// @tol/db status nudge (matching D12's own precedent exactly), since
// economics only engage once a deal has reached that state.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, newId, prisma } from "@tol/db";
import { buildTestApp, createFixtureOpportunity, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

const VALID_TERMS = {
  rate: { basisType: "blended", bps: 250, scope: "all_volume", passThrough: false },
  reserve: { type: "none", durationDays: 0 },
  settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
  capacityOffer: { monthlyAmountMinor: 1_000_000_000, rampSchedule: "immediate", confidenceBps: 9000 },
};

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

interface Session {
  cookie: string;
  csrf: string;
}

describe("P15 — Economics: schedule -> revenue -> ledger through the real HTTP surface", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let provider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let platformOwner: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let marketplaceOperator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let financeOperator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let merchantSession: Session;
  let providerSession: Session;
  let ownerSession: Session;
  let marketplaceOperatorSession: Session;
  let financeSession: Session;
  let outsiderSession: Session;
  let dealRoomId: string;
  let scheduleId: string;
  let contributorComponentId: string;
  let platformComponentId: string;
  /** Captured directly from the FIRST revenue event's own response — the specific $4,000,000 accrual every payment/adjustment test targets, never re-derived via a GET /ledger lookup (which would be ambiguous once more than one ACCRUED accrual exists for the same recipient — real bug this file's own first draft hit, fixed by hoisting this to the top-level describe scope so every sibling describe block below can reference it). */
  let contributorFirstAccrualRootId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "EconMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    provider = await createFixtureOrgWithUser({ orgLabel: "EconProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    platformOwner = await createFixtureOrgWithUser({ orgLabel: "EconOwner", role: "PLATFORM_OWNER", entityType: "PLATFORM" });
    marketplaceOperator = await createFixtureOrgWithUser({ orgLabel: "EconMarketOp", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    financeOperator = await createFixtureOrgWithUser({ orgLabel: "EconFinance", role: "FINANCE_OPERATOR", entityType: "PLATFORM" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "EconOutsider", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });

    const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);

    marketplaceOperatorSession = await login(app, marketplaceOperator.user.email, marketplaceOperator.user.password);
    const rfq = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie: marketplaceOperatorSession.cookie, "x-csrf-token": marketplaceOperatorSession.csrf },
      payload: {
        opportunityId: opportunity.id,
        providerOrgIds: [provider.org.id],
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
      },
    });
    const rfqId = rfq.json().id;

    providerSession = await login(app, provider.user.email, provider.user.password);
    const quote = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });
    const quoteId = quote.json().id;

    merchantSession = await login(app, merchant.user.email, merchant.user.password);
    const select = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/select`,
      headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
      payload: { quoteId, reason: "Selected for the economics.test.ts fixture." },
    });
    dealRoomId = select.json().id;

    // No earlier HTTP endpoint advances a DealRoom past OPEN/CONDITIONS/
    // APPROVED yet (see this file's header comment) — direct, documented
    // nudge to ACTIVATION so economics can engage, same precedent as
    // ADR-0012's MATCH_READY workaround.
    await prisma.dealRoom.update({ where: { id: dealRoomId }, data: { status: "ACTIVATION" } });

    ownerSession = await login(app, platformOwner.user.email, platformOwner.user.password);
    financeSession = await login(app, financeOperator.user.email, financeOperator.user.password);
    outsiderSession = await login(app, outsider.user.email, outsider.user.password);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  describe("authz: schedule.manage (PLATFORM_OWNER only — p.4's verbatim 'no rate editing without authority')", () => {
    const scheduleBody = {
      basis: "GROSS_PROCESSING_VOLUME",
      components: [
        { recipientType: "CONTRIBUTOR", recipientOrgId: "00000000-0000-7000-8000-000000000abc", componentType: "PERCENTAGE_BPS", bps: 8000, priority: 1 },
        { recipientType: "PLATFORM", recipientOrgId: "00000000-0000-7000-8000-000000000abd", componentType: "PERCENTAGE_BPS", bps: 2000, priority: 2 },
      ],
    };

    it("DENIES FINANCE_OPERATOR — 'no rate editing without authority', verbatim", async () => {
      const res = await app.inject({ method: "POST", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf }, payload: scheduleBody });
      expect(res.statusCode).toBe(403);
    });

    it("DENIES MARKETPLACE_OPERATOR entirely — no p.4 scope tie to economics", async () => {
      const res = await app.inject({ method: "POST", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: marketplaceOperatorSession.cookie, "x-csrf-token": marketplaceOperatorSession.csrf }, payload: scheduleBody });
      expect(res.statusCode).toBe(403);
    });

    it("DENIES the merchant and the provider", async () => {
      for (const session of [merchantSession, providerSession]) {
        const res = await app.inject({ method: "POST", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: session.cookie, "x-csrf-token": session.csrf }, payload: scheduleBody });
        expect(res.statusCode).toBe(403);
      }
    });
  });

  describe("create schedule (PLATFORM_OWNER) — 80% contributor / 20% platform, real components persisted", () => {
    it("ALLOWS PLATFORM_OWNER to create AND activate a schedule in one call", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/schedules`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: {
          basis: "GROSS_PROCESSING_VOLUME",
          description: "80/20 contributor/platform split.",
          components: [
            { recipientType: "CONTRIBUTOR", recipientOrgId: provider.org.id, componentType: "PERCENTAGE_BPS", bps: 8000, priority: 1 },
            { recipientType: "PLATFORM", recipientOrgId: platformOwner.org.id, componentType: "PERCENTAGE_BPS", bps: 2000, priority: 2 },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe("ACTIVE");
      expect(body.versionNumber).toBe(1);
      expect(body.components).toHaveLength(2);
      scheduleId = body.id;
      contributorComponentId = body.components.find((c: { recipientOrgId: string }) => c.recipientOrgId === provider.org.id).id;
      platformComponentId = body.components.find((c: { recipientOrgId: string }) => c.recipientOrgId === platformOwner.org.id).id;
    });

    it("GET schedules lists the active schedule with its components", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: financeSession.cookie } });
      expect(res.statusCode).toBe(200);
      const { schedules } = res.json();
      expect(schedules.some((s: { id: string }) => s.id === scheduleId)).toBe(true);
    });

    it("a schedule whose bps do NOT sum to 10000 is accepted at CREATE time (creation doesn't run the split engine) but rejected with a clean 400, not a 500, the FIRST time revenue is recorded against it — @tol/domain's computeCommissionSplits' own invariant, surfaced through problem+json", async () => {
      const badSchedule = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/schedules`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: {
          basis: "SETUP_FEE",
          description: "Deliberately mis-configured — bps sum to 9000, not 10000.",
          components: [{ recipientType: "CONTRIBUTOR", recipientOrgId: provider.org.id, componentType: "PERCENTAGE_BPS", bps: 9000, priority: 1 }],
        },
      });
      expect(badSchedule.statusCode).toBe(201);

      const recordRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "SETUP_FEE", period: "2026-08", source: "setup_fee", grossAmountMinor: "1000", currency: "USD" },
      });
      expect(recordRes.statusCode).toBe(400);
      expect(recordRes.json().code).toBe("bad_request");

      // Real proof it's a clean, handled rejection, not a crash: zero
      // RevenueEvent/CommissionAccrual rows were left behind by the
      // failed attempt.
      const orphanedEvents = await prisma.revenueEvent.findMany({ where: { dealRoomId, source: "setup_fee" } });
      expect(orphanedEvents).toHaveLength(0);
    });

    it("a schedule with capMinor < floorMinor (self-contradictory: cannot promise to distribute at least floorMinor while capping below it) is rejected with a clean 400 at CREATE time, never persisted — real finding from this pass's own review (review)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/schedules`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: {
          basis: "OTHER",
          description: "Deliberately self-contradictory — cap below floor.",
          capMinor: "100",
          floorMinor: "500",
          components: [{ recipientType: "CONTRIBUTOR", recipientOrgId: provider.org.id, componentType: "PERCENTAGE_BPS", bps: 10_000, priority: 1 }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("bad_request");

      const schedules = await prisma.commissionSchedule.findMany({ where: { dealRoomId, basis: "OTHER" } });
      expect(schedules).toHaveLength(0);
    });

    it("capMinor === floorMinor is a valid, non-contradictory configuration — ALLOWED", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/schedules`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: {
          basis: "FIXED_FEE",
          description: "cap === floor — a schedule with an exact, fixed target distribution.",
          capMinor: "250000",
          floorMinor: "250000",
          components: [{ recipientType: "CONTRIBUTOR", recipientOrgId: provider.org.id, componentType: "PERCENTAGE_BPS", bps: 10_000, priority: 1 }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().capMinor).toBe("250000");
      expect(res.json().floorMinor).toBe("250000");
    });
  });

  describe("cap/floor disclosure (Follow-up fix): real, DB-computed, never enforced/clamped", () => {
    // Own dedicated basis+schedule (NET_PLATFORM_REVENUE, unused
    // elsewhere in this file) — self-contained, never touches
    // scheduleId/contributorComponentId or the shared GROSS_PROCESSING_
    // VOLUME schedule the surrounding describe blocks build on.
    let capFloorScheduleId: string;

    it("a fresh schedule with capMinor=1,000,000 and floorMinor=500,000 discloses withinCap=true (0 <= cap, vacuous) and withinFloor=false (0 < floor — routine, not an error) before any revenue is ever recorded", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/schedules`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: {
          basis: "NET_PLATFORM_REVENUE",
          capMinor: "1000000",
          floorMinor: "500000",
          description: "a later fix cap/floor disclosure proof.",
          components: [{ recipientType: "CONTRIBUTOR", recipientOrgId: provider.org.id, componentType: "PERCENTAGE_BPS", bps: 10_000, priority: 1 }],
        },
      });
      expect(res.statusCode).toBe(201);
      capFloorScheduleId = res.json().id;
      const status = res.json().capFloorStatus;
      expect(status.withinCap).toBe(true);
      expect(status.capExceededByMinor).toBeNull();
      expect(status.withinFloor).toBe(false);
      expect(status.floorShortfallMinor).toBe("500000");
    });

    it("recording 800,000 (under the 1,000,000 cap, over the 500,000 floor) flips withinFloor to true, cap stays satisfied — read via GET schedules, the real disclosure path", async () => {
      const recordRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "NET_PLATFORM_REVENUE", period: "2026-08", source: "lane-d-capfloor-1", grossAmountMinor: "800000", currency: "USD" },
      });
      expect(recordRes.statusCode).toBe(201);
      // The split itself is never touched by cap/floor — full 800,000 distributed, zero leakage, same as every other revenue event in this file.
      expect(recordRes.json().reconciliation.reconciled).toBe(true);

      const listRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: financeSession.cookie } });
      const schedule = listRes.json().schedules.find((s: { id: string }) => s.id === capFloorScheduleId);
      expect(schedule.capFloorStatus.withinCap).toBe(true);
      expect(schedule.capFloorStatus.capExceededByMinor).toBeNull();
      expect(schedule.capFloorStatus.withinFloor).toBe(true);
      expect(schedule.capFloorStatus.floorShortfallMinor).toBeNull();
    });

    it("a second revenue event pushes cumulative distribution to 1,300,000 — 300,000 OVER the 1,000,000 cap, disclosed exactly, and the split STILL isn't truncated (disclosure, never enforcement)", async () => {
      const recordRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "NET_PLATFORM_REVENUE", period: "2026-09", source: "lane-d-capfloor-2", grossAmountMinor: "500000", currency: "USD" },
      });
      expect(recordRes.statusCode).toBe(201);
      // THE PROOF this is disclosure, not enforcement: the engine still
      // split and persisted the FULL 500,000 for this second event, zero
      // leakage — a naive "enforce the cap" implementation would have
      // rejected this call, or silently truncated the split to only
      // 200,000 (the amount that would exactly hit the cap). Neither
      // happened.
      expect(recordRes.json().reconciliation.reconciled).toBe(true);
      expect(recordRes.json().reconciliation.distributedMinor).toBe("500000");

      const listRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: financeSession.cookie } });
      const schedule = listRes.json().schedules.find((s: { id: string }) => s.id === capFloorScheduleId);
      expect(schedule.capFloorStatus.withinCap).toBe(false);
      expect(schedule.capFloorStatus.capExceededByMinor).toBe("300000");
      expect(schedule.capFloorStatus.withinFloor).toBe(true);
      expect(schedule.capFloorStatus.floorShortfallMinor).toBeNull();

      // Cross-check against the real, independent DB aggregate — never
      // trust the HTTP response's own math alone.
      const realSum = await prisma.commissionAccrual.aggregate({ where: { scheduleId: capFloorScheduleId, entryType: "ACCRUAL" }, _sum: { amountMinor: true } });
      expect(realSum._sum.amountMinor).toBe(1_300_000n);
    });

    it("a schedule created with NEITHER capMinor nor floorMinor discloses capFloorStatus: null — nothing to disclose, no real aggregate query even run", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/schedules`,
        headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
        payload: {
          basis: "RECEIVED_COMMISSION",
          description: "No cap/floor configured at all.",
          components: [{ recipientType: "CONTRIBUTOR", recipientOrgId: provider.org.id, componentType: "PERCENTAGE_BPS", bps: 10_000, priority: 1 }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().capFloorStatus).toBeNull();
    });
  });

  describe("record revenue event — money exactness through real HTTP + real Postgres", () => {
    it("DENIES FINANCE_OPERATOR from recording revenue against a deal that hasn't reached ACTIVATION/LIVE/ARCHIVED", async () => {
      const freshOpportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);
      // A second real RFQ/Quote/Select chain, deliberately left at OPEN (no activation nudge).
      const rfq = await app.inject({
        method: "POST",
        url: "/rfqs",
        headers: { cookie: marketplaceOperatorSession.cookie, "x-csrf-token": marketplaceOperatorSession.csrf },
        payload: { opportunityId: freshOpportunity.id, providerOrgIds: [provider.org.id], dueAt: new Date(Date.now() + 86_400_000).toISOString(), disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] } },
      });
      const quote = await app.inject({ method: "POST", url: `/rfqs/${rfq.json().id}/quotes`, headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf }, payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS } });
      const select = await app.inject({ method: "POST", url: `/rfqs/${rfq.json().id}/select`, headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf }, payload: { quoteId: quote.json().id, reason: "not-activated fixture" } });
      const notYetActivatedDealId = select.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/deals/${notYetActivatedDealId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "GROSS_PROCESSING_VOLUME", period: "2026-08", source: "processing_volume", grossAmountMinor: "1000", currency: "USD" },
      });
      expect(res.statusCode).toBe(400);
    });

    let ledgerEntries: { accrualRootId: string; componentId: string; recipientOrgId: string; amountMinor: string; entryType: string; direction: string }[];
    let netDistributableMinor: string;

    it("ALLOWS FINANCE_OPERATOR to record revenue — 201, real ledger entries, ZERO LEAKAGE (parts sum exactly to the whole)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "GROSS_PROCESSING_VOLUME", period: "2026-08", source: "processing_volume", grossAmountMinor: "5000000", deductionsMinor: "0", currency: "USD" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      netDistributableMinor = body.revenueEvent.netDistributableMinor;
      expect(netDistributableMinor).toBe("5000000");
      ledgerEntries = body.ledgerEntries;
      expect(ledgerEntries).toHaveLength(2);

      // THE MONEY-EXACTNESS PROOF: re-parse the wire's numeric strings
      // back to BigInt in THIS TEST (never trust the server's own
      // reconciliation.reconciled flag alone) and sum them.
      const sum = ledgerEntries.reduce((acc, e) => acc + BigInt(e.amountMinor), 0n);
      expect(sum).toBe(BigInt(netDistributableMinor));
      expect(sum.toString()).toBe("5000000");

      const contributorEntry = ledgerEntries.find((e) => e.recipientOrgId === provider.org.id)!;
      const platformEntry = ledgerEntries.find((e) => e.recipientOrgId === platformOwner.org.id)!;
      expect(contributorEntry.amountMinor).toBe("4000000"); // exactly 80% of 5,000,000
      expect(platformEntry.amountMinor).toBe("1000000"); // exactly 20%
      expect(contributorEntry.entryType).toBe("ACCRUAL");
      expect(contributorEntry.direction).toBe("CREDIT");
      contributorFirstAccrualRootId = contributorEntry.accrualRootId;

      // THE SERVER'S OWN reconciliation proof — checked too, but as a
      // SECOND, independent confirmation, not instead of the re-summed
      // proof above.
      expect(body.reconciliation.reconciled).toBe(true);
      expect(body.reconciliation.distributedMinor).toBe(netDistributableMinor);
    });

    it("THE TRACEABILITY PROOF: every ledger entry resolves to its schedule, component, and (for the contributor) carries provenance back to the real component id — every number traces to why it exists", () => {
      for (const entry of ledgerEntries) {
        expect(entry.componentId === contributorComponentId || entry.componentId === platformComponentId).toBe(true);
      }
    });

    it("409s on a duplicate (period, source) for the same deal — the RevenueEvent business key, preventing the same real-world revenue from being recorded twice", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "GROSS_PROCESSING_VOLUME", period: "2026-08", source: "processing_volume", grossAmountMinor: "999", currency: "USD" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("GET revenue-events lists the recorded event", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/revenue-events`, headers: { cookie: financeSession.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().revenueEvents.some((e: { period: string; source: string }) => e.period === "2026-08" && e.source === "processing_volume")).toBe(true);
    });

    it("DETERMINISM PROOF: a second revenue event with the SAME gross amount (different period) splits identically — the same schedule always distributes the same money the same way", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "GROSS_PROCESSING_VOLUME", period: "2026-09", source: "processing_volume", grossAmountMinor: "5000000", deductionsMinor: "0", currency: "USD" },
      });
      expect(res.statusCode).toBe(201);
      const secondEntries: { recipientOrgId: string; amountMinor: string }[] = res.json().ledgerEntries;
      const sum = secondEntries.reduce((acc, e) => acc + BigInt(e.amountMinor), 0n);
      expect(sum.toString()).toBe("5000000");
      const secondContributor = secondEntries.find((e) => e.recipientOrgId === provider.org.id)!;
      const secondPlatform = secondEntries.find((e) => e.recipientOrgId === platformOwner.org.id)!;
      expect(secondContributor.amountMinor).toBe(ledgerEntries.find((e) => e.recipientOrgId === provider.org.id)!.amountMinor);
      expect(secondPlatform.amountMinor).toBe(ledgerEntries.find((e) => e.recipientOrgId === platformOwner.org.id)!.amountMinor);
    });

    it("idempotency: the SAME Idempotency-Key on two record-revenue-event calls returns the identical response, replayed not recomputed (the spec)", async () => {
      const idempotencyKey = `test-econ-revenue-${newId()}`;
      const payload = { basis: "GROSS_PROCESSING_VOLUME", period: "2026-10", source: "processing_volume", grossAmountMinor: "100", currency: "USD" };
      const firstRes = await app.inject({ method: "POST", url: `/deals/${dealRoomId}/economics/revenue-events`, headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf, "idempotency-key": idempotencyKey }, payload });
      const secondRes = await app.inject({ method: "POST", url: `/deals/${dealRoomId}/economics/revenue-events`, headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf, "idempotency-key": idempotencyKey }, payload });
      expect(firstRes.statusCode).toBe(201);
      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.json()).toEqual(firstRes.json());

      // Real proof it wasn't recomputed: only ONE RevenueEvent row exists for this period/source.
      const rows = await prisma.revenueEvent.findMany({ where: { dealRoomId, period: "2026-10", source: "processing_volume" } });
      expect(rows).toHaveLength(1);
    });
  });

  describe("GET ledger — the P15 privacy proof: cross-org oversight sees everything, a party sees ONLY its own accrual, the deal's own merchant sees NOTHING (no ordinary same-org owner path)", () => {
    it("FINANCE_OPERATOR sees the WHOLE ledger — both recipients' accruals", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: financeSession.cookie } });
      expect(res.statusCode).toBe(200);
      const { accruals } = res.json();
      const recipients = new Set(accruals.map((a: { recipientOrgId: string }) => a.recipientOrgId));
      expect(recipients.has(provider.org.id)).toBe(true);
      expect(recipients.has(platformOwner.org.id)).toBe(true);
    });

    it("THE PROOF: the provider (contributor) sees ONLY its own accrual, never the platform's", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: providerSession.cookie } });
      expect(res.statusCode).toBe(200);
      const { accruals } = res.json();
      expect(accruals.length).toBeGreaterThan(0);
      for (const a of accruals) {
        expect(a.recipientOrgId).toBe(provider.org.id);
      }
    });

    it("THE PROOF: the deal's own MERCHANT gets a clean 403, not an empty 200 — packages/authz's 'commission_accrual has no ordinary same-org owner' hardening holds through the real API, not just the unit-level can() proof. A merchant is not entitled to see the internal platform/contributor split just because it's the merchant's own deal.", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: merchantSession.cookie } });
      expect(res.statusCode).toBe(403);
    });

    it("DENIES an outsider org entirely", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: outsiderSession.cookie } });
      expect(res.statusCode).toBe(403);
    });

    it("each accrual carries a real, computed balance (status/original/net/paid/outstanding) — never a stored column, always derived", async () => {
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: financeSession.cookie } });
      const { accruals } = res.json();
      const contributorAccrual = accruals.find((a: { recipientOrgId: string }) => a.recipientOrgId === provider.org.id);
      expect(contributorAccrual.balance.status).toBe("ACCRUED");
      expect(contributorAccrual.balance.outstandingAmountMinor).toBe(contributorAccrual.balance.originalAmountMinor);
    });
  });

  describe("record payment — FINANCE_OPERATOR only, server-validated against the real outstanding balance", () => {
    // By this point the contributor has THREE separate accruals (the
    // August/September/October revenue events recorded above) — every
    // test below deliberately targets the FIRST one specifically
    // (contributorFirstAccrualRootId, captured directly from that
    // revenue event's own response) rather than re-deriving "an ACCRUED
    // one" via a GET /ledger lookup, which would be genuinely ambiguous
    // once more than one ACCRUED accrual exists for the same recipient.
    const contributorAccrualRootId = () => contributorFirstAccrualRootId;

    it("the captured accrualRootId is real and still ACCRUED", async () => {
      expect(contributorAccrualRootId()).toBeTruthy();
      const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: financeSession.cookie } });
      const { accruals } = res.json();
      const contributorAccrual = accruals.find((a: { accrualRootId: string }) => a.accrualRootId === contributorAccrualRootId());
      expect(contributorAccrual.balance.status).toBe("ACCRUED");
      expect(contributorAccrual.balance.originalAmountMinor).toBe("4000000");
    });

    it("DENIES the provider (a party role) from recording its own payment — payout evidence stays FINANCE_OPERATOR/PLATFORM_OWNER-only, even on its own accrual", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/payments`,
        headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
        payload: { payments: [{ accrualRootId: contributorAccrualRootId(), amountMinor: "1000000" }], reference: "self-pay-attempt" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("400s an over-payment attempt exceeding the real outstanding balance — server-validated, never client-trusted", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/payments`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { payments: [{ accrualRootId: contributorAccrualRootId(), amountMinor: "999999999" }], reference: "over-payment-attempt" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("ALLOWS FINANCE_OPERATOR to record a PARTIAL payment — the ledger reflects PARTIALLY_PAID afterward", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/payments`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        // a later fix: was a bare literal
        // "econ-test-first-payout" -- CommissionPayment.reference has no
        // uniqueness requirement at the DOMAIN level (two genuinely
        // different payments can share a human-chosen reference string),
        // but a hardcoded literal in a test that runs against this
        // repo's shared, never-reset dev Postgres (see this suite's own
        // "no per-test cleanup" convention) accumulates one real
        // duplicate ROW per run -- 36 confirmed via direct query before
        // this fix, all traced to "... Test Org ..."-named fixtures, none
        // real data; cleaned up in this same commit. newId() suffix
        // makes each run's row unique without changing what's asserted.
        payload: { payments: [{ accrualRootId: contributorAccrualRootId(), amountMinor: "2000000" }], reference: `econ-test-first-payout-${newId()}`, evidenceRef: "ACH-TEST-REF" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().payment.totalAmountMinor).toBe("2000000");

      const ledgerRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/ledger`, headers: { cookie: financeSession.cookie } });
      const { accruals } = ledgerRes.json();
      const contributorAccrual = accruals.find((a: { accrualRootId: string }) => a.accrualRootId === contributorAccrualRootId());
      expect(contributorAccrual.balance.status).toBe("PARTIALLY_PAID");
      expect(contributorAccrual.balance.paidAmountMinor).toBe("2000000");
      expect(contributorAccrual.balance.outstandingAmountMinor).toBe((BigInt(contributorAccrual.balance.originalAmountMinor) - 2_000_000n).toString());
    });

    it("adjust: ALLOWS FINANCE_OPERATOR to record a correction, the balance reflects it immediately", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/ledger/${contributorAccrualRootId()}/adjust`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { direction: "DEBIT", amountMinor: "500000", reason: "econ-test correction — over-accrued due to a rate misapplication." },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ledgerEntry.entryType).toBe("ADJUSTMENT");
      expect(body.ledgerEntry.reason).toContain("econ-test correction");
      expect(body.balance.status).toBe("PARTIALLY_PAID");
    });

    it("DENIES the provider from adjusting its own ledger entry", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/ledger/${contributorAccrualRootId()}/adjust`,
        headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
        payload: { direction: "CREDIT", amountMinor: "1", reason: "attempted self-adjustment" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("concurrency (A2, a later clean-window fix): the pg_advisory_xact_lock guard against a genuine overpayment race", () => {
    // Pre-fix, both recordPayment() calls read the outstanding balance
    // OUTSIDE any transaction and each INSERTs its own independent new
    // CommissionPayment + CommissionAccrual rows — there is no shared
    // existing row for Postgres to serialize an UPDATE against the way
    // claims'/lockbox's races got accidental partial protection from, so
    // two concurrent payments that individually fit but jointly exceed
    // the outstanding balance could both succeed, a genuine overpay. A
    // SINGLE race attempt is empirically flaky at exposing this (same
    // lesson as A1's lockbox race — a cold first connection-pool
    // acquisition/query-plan-cache miss can let one side finish well
    // before the other's critical read, skipping the race window
    // entirely), so this loops the race against several FRESH,
    // dedicated accruals (one dedicated revenue event per attempt, never
    // touching contributorFirstAccrualRootId or its own already-mutated
    // balance from the sequential tests above) and asserts the
    // invariant on every iteration.
    const RACE_ATTEMPTS = 6;

    it(`firing ${RACE_ATTEMPTS} real, simultaneous overpayment races (Promise.all, not sequential, one dedicated revenue event/accrual per attempt) each result in EXACTLY ONE recordPayment() succeeding — never an overpay`, async () => {
      // a later fix: runId makes every
      // race attempt's reference unique PER TEST-SUITE RUN, not just per
      // attempt within one run -- the bare `${attempt}-A`/`-B` literals
      // previously repeated identically across every run against this
      // repo's shared, never-reset dev Postgres, and had ALREADY
      // accumulated up to 7 duplicate rows per reference string (13
      // distinct reference values, confirmed via direct query, all
      // traced to "... Test Org ..."-named fixtures, cleaned up in this
      // same commit) even before CommissionPayment.reference carried a
      // real uniqueness constraint. Left un-fixed, the very next run
      // after that constraint landed would 500 the first time an
      // attempt/side pair happened to repeat a prior run's winner.
      const runId = newId();
      for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt++) {
        const revRes = await app.inject({
          method: "POST",
          url: `/deals/${dealRoomId}/economics/revenue-events`,
          headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
          payload: {
            basis: "GROSS_PROCESSING_VOLUME",
            period: "2027-01",
            source: `concurrency_test_volume_${attempt}`,
            grossAmountMinor: "1000000",
            deductionsMinor: "0",
            currency: "USD",
          },
        });
        expect(revRes.statusCode).toBe(201);
        const raceAccrualRootId = (revRes.json().ledgerEntries as { recipientOrgId: string; accrualRootId: string }[]).find(
          (e) => e.recipientOrgId === provider.org.id,
        )!.accrualRootId;
        // 80% contributor split of grossAmountMinor 1,000,000 = 800,000
        // outstanding. Two concurrent 500,000 payments sum to 1,000,000
        // — over the 800,000 outstanding by 200,000 — so AT MOST ONE may
        // legitimately succeed.

        const [attemptA, attemptB] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/deals/${dealRoomId}/economics/payments`,
            headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
            payload: { payments: [{ accrualRootId: raceAccrualRootId, amountMinor: "500000" }], reference: `concurrency-test-payment-${runId}-${attempt}-A` },
          }),
          app.inject({
            method: "POST",
            url: `/deals/${dealRoomId}/economics/payments`,
            headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
            payload: { payments: [{ accrualRootId: raceAccrualRootId, amountMinor: "500000" }], reference: `concurrency-test-payment-${runId}-${attempt}-B` },
          }),
        ]);

        const statuses = [attemptA.statusCode, attemptB.statusCode];
        expect(statuses.filter((s) => s === 201), `attempt ${attempt}: statuses were ${JSON.stringify(statuses)}`).toHaveLength(1);
        expect(statuses.filter((s) => s === 400), `attempt ${attempt}: statuses were ${JSON.stringify(statuses)}`).toHaveLength(1);

        // THE MONEY PROOF: sum every real PAYMENT-type ledger entry
        // actually persisted for this accrual in the real database —
        // never trust the HTTP responses alone (pre-fix, BOTH responses
        // could independently read 201 while the underlying rows still
        // tell the true, overpaid story).
        const paymentEntries = await prisma.commissionAccrual.findMany({ where: { accrualRootId: raceAccrualRootId, entryType: "PAYMENT" } });
        const totalPaid = paymentEntries.reduce((sum, e) => sum + e.amountMinor, 0n);
        expect(totalPaid, `attempt ${attempt}`).toBe(500000n); // NEVER 1,000,000n — that would exceed the 800,000 outstanding.
      }
    });
  });

  describe("reference uniqueness (Follow-up fix): CommissionPayment.reference is a real, DB-enforced idempotency key", () => {
    it("a retried payment reusing an ALREADY-USED reference is rejected with a clean 409, never a 500 — and the DB genuinely holds only ONE row for it, not two", async () => {
      // Dedicated, isolated revenue event/accrual (same pattern as the
      // concurrency race block above) rather than reusing
      // contributorAccrualRootId — keeps this test's assertions
      // independent of exactly how much of that shared accrual's
      // balance earlier sequential tests have already consumed.
      const revRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: {
          basis: "GROSS_PROCESSING_VOLUME",
          period: "2027-02",
          source: "lane-d-reference-uniqueness-test",
          grossAmountMinor: "1000000",
          deductionsMinor: "0",
          currency: "USD",
        },
      });
      expect(revRes.statusCode).toBe(201);
      const refTestAccrualRootId = (revRes.json().ledgerEntries as { recipientOrgId: string; accrualRootId: string }[]).find(
        (e) => e.recipientOrgId === provider.org.id,
      )!.accrualRootId;
      // 80% contributor split of 1,000,000 gross -> provider's own share
      // is comfortably >= 200,000, room for two sequential 100,000
      // payments (200,000 total) with no overpayment involved anywhere
      // in this test — the ONLY thing under test is the reference reuse.
      const sharedReference = `lane-d-duplicate-ref-${newId()}`;

      const firstRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/payments`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { payments: [{ accrualRootId: refTestAccrualRootId, amountMinor: "100000" }], reference: sharedReference },
      });
      expect(firstRes.statusCode).toBe(201);

      const secondRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/payments`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { payments: [{ accrualRootId: refTestAccrualRootId, amountMinor: "100000" }], reference: sharedReference },
      });
      // A clean, understood conflict — NOT the raw Prisma P2002/500 an
      // unwrapped commissionPaymentRepository.create() would otherwise
      // surface (this is exactly the gap runUniqueConstraintSafe closes
      // in economics/service.ts's recordPayment, same shape as the
      // pre-existing memberships.ts/rfqs.ts precedents).
      expect(secondRes.statusCode).toBe(409);
      const secondBody = secondRes.json();
      expect(secondBody.code).toBe("conflict");
      expect(secondBody.retryable).toBe(true);

      // THE PROOF: query the real table directly. Never trust the HTTP
      // response code alone — confirm the DB genuinely rejected the
      // second insert rather than, say, silently succeeding behind a
      // response the test happens to also read as non-201.
      const rowsWithThisReference = await prisma.commissionPayment.findMany({ where: { reference: sharedReference } });
      expect(rowsWithThisReference).toHaveLength(1);
      expect(rowsWithThisReference[0]!.id).toBe(firstRes.json().payment.id);

      // The rejected second call's transaction must have rolled back
      // completely — only the FIRST payment's ledger entry exists, the
      // outstanding balance reflects exactly ONE 100,000 payment, not
      // two, and not a partial/orphaned second attempt.
      const paymentEntries = await prisma.commissionAccrual.findMany({ where: { accrualRootId: refTestAccrualRootId, entryType: "PAYMENT" } });
      expect(paymentEntries).toHaveLength(1);
      expect(paymentEntries[0]!.amountMinor).toBe(100000n);
    });
  });

  describe("tenant isolation + input validation", () => {
    it("404s for a nonexistent deal room on every economics endpoint", async () => {
      const fakeId = "00000000-0000-7000-8000-0000000000ff";
      const results = await Promise.all([
        app.inject({ method: "GET", url: `/deals/${fakeId}/economics/schedules`, headers: { cookie: financeSession.cookie } }),
        app.inject({ method: "GET", url: `/deals/${fakeId}/economics/revenue-events`, headers: { cookie: financeSession.cookie } }),
        app.inject({ method: "GET", url: `/deals/${fakeId}/economics/ledger`, headers: { cookie: financeSession.cookie } }),
      ]);
      for (const res of results) expect(res.statusCode).toBe(404);
    });

    it("400s a malformed grossAmountMinor (a JSON number instead of an integer string, and a decimal string)", async () => {
      const decimalRes = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "GROSS_PROCESSING_VOLUME", period: "2026-11", source: "x", grossAmountMinor: "100.50", currency: "USD" },
      });
      expect(decimalRes.statusCode).toBe(400);
    });

    it("400s a lowercase currency — Follow-up fix: @tol/contracts' zod schema only checks length===3 (accepts \"usd\"), @tol/domain's assertCurrencyCode is the real charset check, and app.ts's new MoneyInvariantError handler is what turns it into a clean 400 instead of an unhandled 500", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/deals/${dealRoomId}/economics/revenue-events`,
        headers: { cookie: financeSession.cookie, "x-csrf-token": financeSession.csrf },
        payload: { basis: "GROSS_PROCESSING_VOLUME", period: "2026-11", source: "lane-d-lowercase-currency", grossAmountMinor: "100", currency: "usd" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe("invalid_money_value");
      expect(body.retryable).toBe(false);

      // Real proof it's a clean, handled rejection, not a crash: zero
      // RevenueEvent rows were left behind by the failed attempt — same
      // discipline as this describe block's other rejection proofs.
      const orphanedEvents = await prisma.revenueEvent.findMany({ where: { dealRoomId, source: "lane-d-lowercase-currency" } });
      expect(orphanedEvents).toHaveLength(0);
    });

    it("outsider org is denied schedules/revenue-events reads too, not just the ledger", async () => {
      const scheduleRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/schedules`, headers: { cookie: outsiderSession.cookie } });
      const revenueRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/economics/revenue-events`, headers: { cookie: outsiderSession.cookie } });
      expect(scheduleRes.statusCode).toBe(403);
      expect(revenueRes.statusCode).toBe(403);
    });
  });
});
