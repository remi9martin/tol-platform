// apps/api/tests/integration/deals.test.ts
//
// P14 gate proof: conditions + decisions + timeline through the real
// HTTP surface, against a real DealRoom opened by a real quote
// selection (not a hand-inserted fixture — the whole RFQ->DealRoom
// handoff is exercised here too).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma } from "@tol/db";
import {
  buildTestApp,
  createFixtureOpportunity,
  createFixtureOrgWithUser,
  extractCookieHeader,
} from "../helpers/build-test-app.js";

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

describe("P14 — Deal Room: conditions + decisions + timeline through the real HTTP surface", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let provider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let dealRoomId: string;
  let conditionId: string;
  // One login per role, cached and reused across every it() below —
  // /auth/login has its own stricter rate limit (10/minute,
  // apps/api/src/modules/auth/routes.ts) than the global default; a
  // fresh login per assertion within one describe block (same IP key)
  // exceeds it fast. Real product behavior, not a test bug — worked
  // around by authenticating once per role, the way a real client would.
  let merchantSession: { cookie: string; csrf: string };
  let providerSession: { cookie: string; csrf: string };

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "DealMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    provider = await createFixtureOrgWithUser({ orgLabel: "DealProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "DealOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);

    // Drive a real RFQ -> Quote -> Selection to get a real, non-fixture DealRoom.
    const op = await login(app, operator.user.email, operator.user.password);
    const rfq = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie: op.cookie, "x-csrf-token": op.csrf },
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
      payload: { quoteId, reason: "Selected for the deals.test.ts fixture." },
    });
    dealRoomId = select.json().id;
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("both counterparties were auto-added as DealRoomParticipant rows on open", async () => {
    const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}`, headers: { cookie: merchantSession.cookie } });
    expect(res.statusCode).toBe(200);
    const roles = res.json().participants.map((p: { organizationId: string; participantRole: string }) => p.participantRole).sort();
    expect(roles).toEqual(["MERCHANT", "PROVIDER"]);
  });

  it("the QUOTE_SELECTED decision was recorded automatically when the deal opened", async () => {
    const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}`, headers: { cookie: merchantSession.cookie } });
    expect(res.json().decisions).toHaveLength(1);
    expect(res.json().decisions[0].decisionType).toBe("QUOTE_SELECTED");
  });

  it("the provider (not the resource owner) posts a condition — deal moves OPEN -> CONDITIONS", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/deals/${dealRoomId}/conditions`,
      headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
      payload: {
        description: "Merchant must provide UBO documentation.",
        ownerOrgId: merchant.org.id, // the PROVIDER posts a condition the MERCHANT owes — p.21's "owner" is who owes it, not who posted it
        blocking: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe("PENDING");
    expect(res.json().ownerOrgId).toBe(merchant.org.id);
    conditionId = res.json().id;

    const dealRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}`, headers: { cookie: providerSession.cookie } });
    expect(dealRes.json().status).toBe("CONDITIONS");
  });

  it("posting a condition with an ownerOrgId that isn't one of the two real counterparties is rejected", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/deals/${dealRoomId}/conditions`,
      headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
      payload: { description: "x", ownerOrgId: "00000000-0000-7000-8000-000000000abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("the merchant resolves the condition as SATISFIED", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/deals/${dealRoomId}/conditions/${conditionId}`,
      headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
      payload: { state: "SATISFIED", resolutionNote: "UBO docs uploaded to the vault." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("SATISFIED");
  });

  it("resolving an already-SATISFIED condition again fails with a clean 400 (terminal state)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/deals/${dealRoomId}/conditions/${conditionId}`,
      headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
      payload: { state: "WAIVED" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_state_transition");
  });

  it("the merchant records an APPROVAL decision — deal moves CONDITIONS -> APPROVED", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/deals/${dealRoomId}/decisions`,
      headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
      payload: { decisionType: "APPROVAL", reason: "All conditions satisfied; proceeding to activation." },
    });
    expect(res.statusCode).toBe(201);

    const dealRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}`, headers: { cookie: merchantSession.cookie } });
    expect(dealRes.json().status).toBe("APPROVED");
    expect(dealRes.json().decisions).toHaveLength(2); // QUOTE_SELECTED + this APPROVAL
  });

  it("directly recording a QUOTE_SELECTED decision via the API is rejected at the wire-schema level (system-recorded only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/deals/${dealRoomId}/decisions`,
      headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
      payload: { decisionType: "QUOTE_SELECTED", reason: "trying to forge one" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("the timeline includes events from BOTH the deal room AND its originating RFQ, chronological", async () => {
    const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/timeline`, headers: { cookie: merchantSession.cookie } });
    expect(res.statusCode).toBe(200);
    const eventTypes: string[] = res.json().events.map((e: { eventType: string }) => e.eventType);
    // From the RFQ's own history (aggregateType "rfq", merged in):
    expect(eventTypes).toContain("rfq.sent");
    expect(eventTypes).toContain("quote.submitted");
    expect(eventTypes).toContain("quote.selected");
    // From the deal room itself:
    expect(eventTypes).toContain("deal.opened");
    expect(eventTypes).toContain("deal.participant_added");
    expect(eventTypes).toContain("deal.condition_created");
    expect(eventTypes).toContain("deal.condition_resolved");
    expect(eventTypes).toContain("deal.decision_recorded");
    expect(eventTypes).toContain("deal.stage_changed");

    // Chronological order.
    const times = res.json().events.map((e: { occurredAt: string }) => new Date(e.occurredAt).getTime());
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });
});

describe("P14 — Deal Room: tenant isolation", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let provider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let dealRoomId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "IsoDealMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    provider = await createFixtureOrgWithUser({ orgLabel: "IsoDealProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "IsoDealOutsider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "IsoDealOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);

    const op = await login(app, operator.user.email, operator.user.password);
    const rfq = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie: op.cookie, "x-csrf-token": op.csrf },
      payload: {
        opportunityId: opportunity.id,
        providerOrgIds: [provider.org.id],
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
      },
    });
    const prov = await login(app, provider.user.email, provider.user.password);
    const quote = await app.inject({
      method: "POST",
      url: `/rfqs/${rfq.json().id}/quotes`,
      headers: { cookie: prov.cookie, "x-csrf-token": prov.csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });
    const merch = await login(app, merchant.user.email, merchant.user.password);
    const select = await app.inject({
      method: "POST",
      url: `/rfqs/${rfq.json().id}/select`,
      headers: { cookie: merch.cookie, "x-csrf-token": merch.csrf },
      payload: { quoteId: quote.json().id, reason: "fixture" },
    });
    dealRoomId = select.json().id;
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("THE PROOF: an outsider provider (never invited, no DealRoomParticipant row) CANNOT read the deal room", async () => {
    const { cookie } = await login(app, outsider.user.email, outsider.user.password);
    const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("THE PROOF: an outsider provider CANNOT post a condition", async () => {
    const { cookie, csrf } = await login(app, outsider.user.email, outsider.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/deals/${dealRoomId}/conditions`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { description: "x", ownerOrgId: merchant.org.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it("THE PROOF: an outsider provider CANNOT read the timeline", async () => {
    const { cookie } = await login(app, outsider.user.email, outsider.user.password);
    const res = await app.inject({ method: "GET", url: `/deals/${dealRoomId}/timeline`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("AUDITOR_READONLY has cross-org read but zero deal.* write authority, even for this specific deal", async () => {
    const auditor = await createFixtureOrgWithUser({ orgLabel: "IsoDealAuditor", role: "AUDITOR_READONLY" });
    const { cookie, csrf } = await login(app, auditor.user.email, auditor.user.password);
    const readRes = await app.inject({ method: "GET", url: `/deals/${dealRoomId}`, headers: { cookie } });
    expect(readRes.statusCode).toBe(200);

    const writeRes = await app.inject({
      method: "POST",
      url: `/deals/${dealRoomId}/decisions`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { decisionType: "APPROVAL", reason: "auditor should not be able to do this" },
    });
    expect(writeRes.statusCode).toBe(403);
  });
});

describe("P14 — Deal Room: concurrency (A3, a later clean-window fix) — the pg_advisory_xact_lock guard against a genuine double-stage-change race", () => {
  // Pre-fix, recordDecision() re-read the DealRoom fresh inside its own
  // transaction but took no lock. Two concurrent, OPPOSITE decisions (an
  // APPROVAL and a DECLINE) fired at the SAME fresh OPEN deal room could
  // each independently read the pre-commit OPEN status, each compute
  // their own valid-from-OPEN target status, and each successfully
  // UPDATE the DealRoom's status column — Postgres's own row lock
  // serializes the two UPDATE statements, but only AFTER both
  // transactions already computed their target from the SAME stale
  // read, so the second UPDATE simply overwrites the first's result
  // with no conflict detection, and BOTH "deal.stage_changed" events
  // (OPEN -> APPROVED and OPEN -> DECLINED) get persisted to the
  // timeline — a genuinely contradictory historical record for a deal
  // that only ever actually transitioned once. This function's own
  // pre-existing comment already names the exact race the lock closes.
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let provider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let merchantSession: { cookie: string; csrf: string };
  let providerSession: { cookie: string; csrf: string };
  let operatorSession: { cookie: string; csrf: string };

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "RaceDealMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    provider = await createFixtureOrgWithUser({ orgLabel: "RaceDealProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "RaceDealOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    // One login per role, cached and reused across every loop iteration
    // below — same rate-limit-avoidance discipline as this file's own
    // top describe block's comment (/auth/login is 10/minute).
    merchantSession = await login(app, merchant.user.email, merchant.user.password);
    providerSession = await login(app, provider.user.email, provider.user.password);
    operatorSession = await login(app, operator.user.email, operator.user.password);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  const RACE_ATTEMPTS = 6;

  it(`firing ${RACE_ATTEMPTS} real, simultaneous APPROVAL-vs-DECLINE recordDecision() races (Promise.all, not sequential, one fresh OPEN deal room per attempt) each result in EXACTLY ONE "deal.stage_changed" event — never two contradictory transitions from the same OPEN origin`, async () => {
    for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt++) {
      const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);
      const rfq = await app.inject({
        method: "POST",
        url: "/rfqs",
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: {
          opportunityId: opportunity.id,
          providerOrgIds: [provider.org.id],
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
        },
      });
      const quote = await app.inject({
        method: "POST",
        url: `/rfqs/${rfq.json().id}/quotes`,
        headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
        payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
      });
      const select = await app.inject({
        method: "POST",
        url: `/rfqs/${rfq.json().id}/select`,
        headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
        payload: { quoteId: quote.json().id, reason: `concurrency race fixture ${attempt}` },
      });
      expect(select.statusCode).toBe(201);
      const raceDealRoomId = select.json().id;

      const [approvalAttempt, declineAttempt] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/deals/${raceDealRoomId}/decisions`,
          headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
          payload: { decisionType: "APPROVAL", reason: `concurrency test — race attempt ${attempt} — A` },
        }),
        app.inject({
          method: "POST",
          url: `/deals/${raceDealRoomId}/decisions`,
          headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
          payload: { decisionType: "DECLINE", reason: `concurrency test — race attempt ${attempt} — B` },
        }),
      ]);

      // Both requests are individually well-formed and permitted, so
      // BOTH are expected to return 201 regardless of the lock — this
      // function always records the DealDecision row (p.22: exceptions/
      // late decisions are recorded alongside the normal flow, not
      // rejected); the lock's job is protecting the DEAL ROOM's own
      // status field and timeline from a double stage-change, not
      // rejecting the second decision outright.
      expect(approvalAttempt.statusCode, `attempt ${attempt}`).toBe(201);
      expect(declineAttempt.statusCode, `attempt ${attempt}`).toBe(201);

      // THE PROOF: the deal room's final status is exactly ONE of
      // {APPROVED, DECLINED} (whichever transaction won the serialized
      // race) — never ambiguous — and critically, the real persisted
      // timeline carries EXACTLY ONE "deal.stage_changed" event, never
      // two contradictory ones from the same OPEN origin.
      const dealRes = await app.inject({ method: "GET", url: `/deals/${raceDealRoomId}`, headers: { cookie: merchantSession.cookie } });
      expect(["APPROVED", "DECLINED"], `attempt ${attempt}`).toContain(dealRes.json().status);

      const timelineRes = await app.inject({ method: "GET", url: `/deals/${raceDealRoomId}/timeline`, headers: { cookie: merchantSession.cookie } });
      const stageChangedEvents = (timelineRes.json().events as { eventType: string }[]).filter((e) => e.eventType === "deal.stage_changed");
      expect(stageChangedEvents, `attempt ${attempt}: found ${stageChangedEvents.length} deal.stage_changed events`).toHaveLength(1);
    }
  });
});
