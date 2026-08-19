// apps/api/tests/integration/rfqs.test.ts
//
// P13 gate proof: a real RFQ created through the actual HTTP surface,
// a real invited provider submitting a real quote, the merchant
// selecting it — exercising the full route -> service -> authz.can() ->
// repository chain, including the earlier isParticipant mechanism
// (ADR-0008), against the real docker-compose Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, prisma } from "@tol/db";
import {
  buildTestApp,
  createFixtureCapacityProfile,
  createFixtureOpportunity,
  createFixtureOrgWithUser,
  extractCookieHeader,
} from "../helpers/build-test-app.js";

const VALID_TERMS = {
  rate: { basisType: "blended", bps: 285, scope: "all_volume", passThrough: false },
  reserve: { type: "rolling", bps: 500, durationDays: 90 },
  settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
  capacityOffer: { monthlyAmountMinor: 3_000_000_000, rampSchedule: "90-day ramp", confidenceBps: 8000 },
};

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

describe("P13 — RFQ: full lifecycle through the real HTTP surface", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let provider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let opportunity: Awaited<ReturnType<typeof createFixtureOpportunity>>;
  let rfqId: string;
  let quoteId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "RfqMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    provider = await createFixtureOrgWithUser({ orgLabel: "RfqProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "RfqOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });

    opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);
    await createFixtureCapacityProfile(provider.org.id, provider.user.id);
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("MERCHANT_PSP_USER cannot create an RFQ — operator-assisted model this pass (matrix.ts)", async () => {
    const { cookie, csrf } = await login(app, merchant.user.email, merchant.user.password);
    const res = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        opportunityId: opportunity.id,
        providerOrgIds: [provider.org.id],
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("MARKETPLACE_OPERATOR creates the RFQ (cross-org) — status SENT, version 1", async () => {
    const { cookie, csrf } = await login(app, operator.user.email, operator.user.password);
    const res = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        opportunityId: opportunity.id,
        providerOrgIds: [provider.org.id],
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("SENT");
    expect(body.currentVersion.versionNumber).toBe(1);
    rfqId = body.id;
  });

  it("the invited provider CAN read the RFQ (isParticipant path — not the resource owner)", async () => {
    const { cookie } = await login(app, provider.user.email, provider.user.password);
    const res = await app.inject({ method: "GET", url: `/rfqs/${rfqId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("the invited provider submits a quote — 201, RFQ moves to QUOTED", async () => {
    const { cookie, csrf } = await login(app, provider.user.email, provider.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("SUBMITTED");
    quoteId = res.json().id;

    const rfqRes = await app.inject({ method: "GET", url: `/rfqs/${rfqId}`, headers: { cookie } });
    expect(rfqRes.json().status).toBe("QUOTED");
  });

  it("the merchant sees the submitted quote in the RFQ detail (owner sees all quotes)", async () => {
    const { cookie } = await login(app, merchant.user.email, merchant.user.password);
    const res = await app.inject({ method: "GET", url: `/rfqs/${rfqId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().quotes).toHaveLength(1);
    expect(res.json().quotes[0].id).toBe(quoteId);
  });

  it("the merchant selects the quote — 201, opens a DealRoom", async () => {
    const { cookie, csrf } = await login(app, merchant.user.email, merchant.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/select`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { quoteId, reason: "Best blended rate within reserve tolerance." },
    });
    expect(res.statusCode).toBe(201);
    const dealRoom = res.json();
    expect(dealRoom.status).toBe("OPEN");
    expect(dealRoom.merchantOrgId).toBe(merchant.org.id);
    expect(dealRoom.providerOrgId).toBe(provider.org.id);
    expect(dealRoom.selectedQuoteId).toBe(quoteId);
  });

  it("re-selecting the same (now-SELECTED) RFQ fails with a clean 400, not a 500 — DomainTransitionError caught centrally", async () => {
    const { cookie, csrf } = await login(app, merchant.user.email, merchant.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/select`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { quoteId, reason: "trying again" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_state_transition");
  });

});

describe("P13 — RFQ: fresh-read-inside-transaction guard (closes a real check-then-act race self-identified during the review)", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let providerA: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let providerB: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let rfqId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "RaceMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    providerA = await createFixtureOrgWithUser({ orgLabel: "RaceProviderA", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    providerB = await createFixtureOrgWithUser({ orgLabel: "RaceProviderB", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "RaceOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);

    // One RFQ invites BOTH providers. Provider A quotes and gets
    // selected (closing the RFQ). Provider B never quotes — their
    // RFQRecipient stays INVITED, the exact precondition needed to
    // reach submitQuote()'s pre-transaction assertValidRfqRecipientTransition
    // check (which only the NEW fresh-RFQ-status guard inside the
    // transaction can still catch, since the recipient-state check alone
    // has no opinion on the RFQ's own status).
    const op = await login(app, operator.user.email, operator.user.password);
    const rfq = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie: op.cookie, "x-csrf-token": op.csrf },
      payload: {
        opportunityId: opportunity.id,
        providerOrgIds: [providerA.org.id, providerB.org.id],
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
      },
    });
    rfqId = rfq.json().id;

    const provA = await login(app, providerA.user.email, providerA.user.password);
    const quote = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: { cookie: provA.cookie, "x-csrf-token": provA.csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });

    const merch = await login(app, merchant.user.email, merchant.user.password);
    await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/select`,
      headers: { cookie: merch.cookie, "x-csrf-token": merch.csrf },
      payload: { quoteId: quote.json().id, reason: "Provider A selected; Provider B never quoted." },
    });
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("Provider B (still INVITED, never quoted) submitting a quote AFTER the RFQ was already selected is rejected with a clean 409, not silently accepted into a closed RFQ", async () => {
    const { cookie, csrf } = await login(app, providerB.user.email, providerB.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/no longer accepting quotes/i);
  });
});

describe("P13 — RFQ: tenant isolation for the two-sided isParticipant mechanism", () => {
  let app: FastifyInstance;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let invitedProvider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let uninvitedProvider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let opportunity: Awaited<ReturnType<typeof createFixtureOpportunity>>;
  let rfqId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "IsoMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    invitedProvider = await createFixtureOrgWithUser({ orgLabel: "IsoInvited", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    uninvitedProvider = await createFixtureOrgWithUser({ orgLabel: "IsoUninvited", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "IsoOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });

    opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);

    const { cookie, csrf } = await login(app, operator.user.email, operator.user.password);
    const createRes = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        opportunityId: opportunity.id,
        providerOrgIds: [invitedProvider.org.id],
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
      },
    });
    rfqId = createRes.json().id;
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("THE PROOF: an uninvited provider (no RFQRecipient row) CANNOT read the RFQ", async () => {
    const { cookie } = await login(app, uninvitedProvider.user.email, uninvitedProvider.user.password);
    const res = await app.inject({ method: "GET", url: `/rfqs/${rfqId}`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("THE PROOF: an uninvited provider CANNOT submit a quote on an RFQ it wasn't invited to", async () => {
    const { cookie, csrf } = await login(app, uninvitedProvider.user.email, uninvitedProvider.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });
    expect(res.statusCode).toBe(403);
  });

  it("THE PROOF: an uninvited provider CANNOT decline an RFQ it wasn't invited to", async () => {
    const { cookie, csrf } = await login(app, uninvitedProvider.user.email, uninvitedProvider.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/decline`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { declineReason: "not real" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a SECOND merchant org (not this RFQ's owner) cannot select a quote on it", async () => {
    const otherMerchant = await createFixtureOrgWithUser({ orgLabel: "IsoOtherMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    const { cookie, csrf } = await login(app, otherMerchant.user.email, otherMerchant.user.password);
    const res = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/select`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { quoteId: "00000000-0000-7000-8000-000000000000", reason: "hijack attempt" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("the invited provider CAN decline, and after declining cannot submit a quote (invalid transition -> clean 400)", async () => {
    const { cookie, csrf } = await login(app, invitedProvider.user.email, invitedProvider.user.password);
    const declineRes = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/decline`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { declineReason: "outside our current risk appetite" },
    });
    expect(declineRes.statusCode).toBe(200);
    expect(declineRes.json().state).toBe("DECLINED");

    const quoteRes = await app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
    });
    expect(quoteRes.statusCode).toBe(400);
    expect(quoteRes.json().code).toBe("invalid_state_transition");
  });
});

describe("P13 — RFQ: concurrency (A3, a later clean-window fix) — the pg_advisory_xact_lock guard against a genuine select-vs-withdraw corruption race", () => {
  // Pre-fix, withdrawQuote() had NEITHER a lock NOR a re-read-inside-tx
  // guard at all (the most exposed of the four rfqs/service.ts mutating
  // functions this pass found): quote.status SELECTED has zero legal
  // outgoing transitions (packages/domain's QUOTE_TRANSITIONS), so a
  // concurrent selectQuote() racing this withdrawQuote() could let
  // withdrawQuote() blindly overwrite an ALREADY-SELECTED quote — the
  // one a real, just-opened DealRoom now references as selectedQuoteId
  // — back to WITHDRAWN, using nothing but its own STALE pre-transaction
  // read (quote.status was SUBMITTED when it read it). This corrupts a
  // live deal: a DealRoom would exist whose selectedQuoteId points at a
  // quote row now claiming WITHDRAWN.
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

    merchant = await createFixtureOrgWithUser({ orgLabel: "RaceRfqMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    provider = await createFixtureOrgWithUser({ orgLabel: "RaceRfqProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    operator = await createFixtureOrgWithUser({ orgLabel: "RaceRfqOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    await createFixtureCapacityProfile(provider.org.id, provider.user.id);
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

  it(`firing ${RACE_ATTEMPTS} real, simultaneous selectQuote()-vs-withdrawQuote() races (Promise.all, not sequential, one fresh RFQ+quote per attempt) each result in EXACTLY ONE succeeding, and a SELECTED quote is never silently overwritten back to WITHDRAWN`, async () => {
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
      expect(rfq.statusCode).toBe(201);
      const raceRfqId = rfq.json().id;

      const quote = await app.inject({
        method: "POST",
        url: `/rfqs/${raceRfqId}/quotes`,
        headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
        payload: { currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), terms: VALID_TERMS },
      });
      expect(quote.statusCode).toBe(201);
      const raceQuoteId = quote.json().id;

      const [selectAttempt, withdrawAttempt] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/rfqs/${raceRfqId}/select`,
          headers: { cookie: merchantSession.cookie, "x-csrf-token": merchantSession.csrf },
          payload: { quoteId: raceQuoteId, reason: `concurrency test — race attempt ${attempt}` },
        }),
        app.inject({
          method: "POST",
          url: `/rfqs/${raceRfqId}/quotes/${raceQuoteId}/withdraw`,
          headers: { cookie: providerSession.cookie, "x-csrf-token": providerSession.csrf },
        }),
      ]);

      // Exactly one wins — select returns 201 (opens a DealRoom) or
      // withdraw returns 200, never both.
      const successes = [selectAttempt.statusCode === 201, withdrawAttempt.statusCode === 200].filter(Boolean);
      expect(successes, `attempt ${attempt}: select=${selectAttempt.statusCode} withdraw=${withdrawAttempt.statusCode}`).toHaveLength(1);

      const finalQuote = await prisma.quote.findUniqueOrThrow({ where: { id: raceQuoteId } });

      if (selectAttempt.statusCode === 201) {
        // selectQuote() won — a real DealRoom now references this quote.
        // withdrawQuote() MUST have failed cleanly (its fresh re-read,
        // now inside the lock, sees SELECTED and
        // assertValidQuoteTransition rejects WITHDRAWN as a legal exit),
        // and the quote's PERSISTED status must genuinely be SELECTED —
        // never silently flipped back to WITHDRAWN by the loser.
        expect(withdrawAttempt.statusCode, `attempt ${attempt}`).not.toBe(200);
        expect(finalQuote.status, `attempt ${attempt}`).toBe("SELECTED");
        const dealRoom = await prisma.dealRoom.findFirst({ where: { selectedQuoteId: raceQuoteId } });
        expect(dealRoom, `attempt ${attempt}: DealRoom referencing this SELECTED quote must exist`).not.toBeNull();
      } else {
        // withdrawQuote() won fairly — the quote never reached SELECTED,
        // so selectQuote() must have failed cleanly against the
        // already-WITHDRAWN quote, and no DealRoom was ever opened for it.
        expect(selectAttempt.statusCode, `attempt ${attempt}`).not.toBe(201);
        expect(finalQuote.status, `attempt ${attempt}`).toBe("WITHDRAWN");
        const dealRoom = await prisma.dealRoom.findFirst({ where: { selectedQuoteId: raceQuoteId } });
        expect(dealRoom, `attempt ${attempt}: no DealRoom should reference a withdrawn quote`).toBeNull();
      }
    }
  });
});
