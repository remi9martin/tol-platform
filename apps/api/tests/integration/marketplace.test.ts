// apps/api/tests/integration/marketplace.test.ts
//
// P5 gate proof (the spec: "Safe visible inventory works") — THE
// SECURITY-CRITICAL PROOF this whole day's build exists to establish:
// "A market-level browser must be physically unable to retrieve
// deal-private fields via the API — redaction happens on the server
// before the response is serialized, NOT by the client hiding them."
//
// This file asserts directly against the RAW PARSED JSON RESPONSE BODY
// — never against what a UI would or wouldn't render — because the
// reuse-reference prototype's exact failure mode (confirmed during this
// day's research phase) was a client component that imported full,
// unredacted profile data and merely didn't reference certain fields in
// JSX, while the complete objects — including commercial floor pricing
// — still shipped to the browser. A UI-only check would not catch that
// class of bug; inspecting the actual response object's own keys does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { disconnectPrisma, newId, prisma } from "@tol/db";
import { buildTestApp, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

describe("P5 — Marketplace: server-side field redaction proven against the raw HTTP response body", () => {
  let app: FastifyInstance;
  let provider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let merchantBrowser: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let providerSession: { cookie: string; csrf: string };
  let merchantBrowserSession: { cookie: string; csrf: string };
  let operatorSession: { cookie: string; csrf: string };

  // Deliberately extreme, easy-to-spot-if-leaked sentinel values — a
  // real find of ANY of these three in a market response body is
  // unambiguous proof of a redaction bypass, not a coincidence. 8+
  // digits (not 3-4) so a coincidental substring match against an
  // accumulated UUIDv7 id elsewhere in a cross-org listing (this repo's
  // own convention leaves fixture rows in the shared dev Postgres across
  // every test run — vitest.config.ts's own comment) is statistically
  // negligible — a real, reproduced flake this exact pair of short
  // values caused, traced to an unrelated fixture's capacity_profile id
  // containing "777" as a substring. commercialTerms is freeform,
  // unvalidated JSON (redacted wholesale, never partially), so any value
  // works here.
  const SECRET_MDR_BPS = 90887731;
  const SECRET_FIXED_FEE_MINOR = 88888817;
  let capacityProfileId: string;
  let opportunityId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    provider = await createFixtureOrgWithUser({ orgLabel: "MarketProvider", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });
    merchantBrowser = await createFixtureOrgWithUser({ orgLabel: "MarketBrowser", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    operator = await createFixtureOrgWithUser({ orgLabel: "MarketOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });

    providerSession = await login(app, provider.user.email, provider.user.password);
    merchantBrowserSession = await login(app, merchantBrowser.user.email, merchantBrowser.user.password);
    operatorSession = await login(app, operator.user.email, operator.user.password);

    // Created directly via Prisma (test-fixture setup, not the behavior
    // under test) with EXPLICIT sensitive data — commercialTerms,
    // high-precision risk bps, and a real providerOrgId — so this test
    // has something concrete and unambiguous to prove is absent.
    const profile = await prisma.capacityProfile.create({
      data: {
        id: newId(),
        providerOrgId: provider.org.id,
        asOf: new Date(),
        freshnessClass: "FRESH",
        acceptingNewVolume: true,
        jurisdictions: ["US", "CA"],
        mccsAccepted: ["5411"],
        mccsExcluded: [],
        currency: "USD",
        monthlyCapacityMinor: 3_500_000_00n, // -> "1M_5M" band
        minTicketMinor: 100,
        maxTicketMinor: 250_000,
        maxChargebackBps: 80,
        maxFraudBps: 40,
        maxRefundBps: 150, // total 270 -> "LOW" risk tier
        settlementRail: "ACH",
        settlementCadenceDays: 2,
        commercialTerms: { mdrBps: SECRET_MDR_BPS, fixedFeeMinor: SECRET_FIXED_FEE_MINOR, model: "blended" },
        privacyClass: "RESTRICTED",
        createdByUserId: provider.user.id,
        createdByOrgId: provider.org.id,
        sourceType: "PLATFORM",
      },
    });
    capacityProfileId = profile.id;

    const opportunity = await prisma.opportunity.create({
      data: {
        id: newId(),
        ownerOrgId: merchantBrowser.org.id,
        opportunityType: "ACQUIRING",
        requestedService: "Market redaction proof opportunity",
        status: "MATCH_READY",
        currency: "USD",
        totalPaymentVolumeMinor: 12_000_000_00n,
        totalCardGpvMinor: 10_000_000_00n,
        eligibleCardGpvMinor: 9_000_000_00n,
        offeredCardGpvMinor: 2_500_000_00n, // -> "1M_5M" band
        movableNowMinor: 500_000_00n,
        movable30dMinor: 1_000_000_00n,
        movable90dMinor: 2_000_000_00n,
        jurisdictions: ["US"],
        mccs: ["5812"],
        privacyClass: "MEMBER_MARKET",
        createdByUserId: merchantBrowser.user.id,
        createdByOrgId: merchantBrowser.org.id,
        sourceType: "PLATFORM",
      },
    });
    opportunityId = opportunity.id;
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("THE PROOF (capacity): a market-level, non-owner browser's raw JSON response contains NEITHER the providerOrgId NOR any key named/shaped like the commercial terms or exact risk/volume figures — inspected as actual object keys, not string-searched", async () => {
    const res = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: merchantBrowserSession.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const card = body.cards.find((c: { cardId: string }) => c.cardId === capacityProfileId);
    expect(card).toBeDefined();

    // Structural proof: enumerate the ACTUAL keys present on the raw
    // response object for this card and assert the private ones are
    // simply not among them — not null, not empty-string, ABSENT.
    const keys = Object.keys(card);
    for (const forbidden of ["providerOrgId", "commercialTerms", "monthlyCapacityMinor", "minTicketMinor", "maxTicketMinor", "maxChargebackBps", "maxFraudBps", "maxRefundBps", "settlementRail", "settlementCadenceDays"]) {
      expect(keys, `card unexpectedly has key "${forbidden}"`).not.toContain(forbidden);
    }

    // Belt and suspenders: the sentinel VALUES themselves are nowhere in
    // THIS card's own serialized shape — scoped to the card under test,
    // not the full cross-org `body` (which can legitimately contain
    // other real, unrelated capacity/organization ids from other
    // fixtures/tests sharing this dev database; a value check has no
    // business asserting anything about rows this test didn't create).
    const cardRaw = JSON.stringify(card);
    expect(cardRaw).not.toContain(String(SECRET_MDR_BPS));
    expect(cardRaw).not.toContain(String(SECRET_FIXED_FEE_MINOR));
    expect(cardRaw).not.toContain(provider.org.id);

    // The card DOES carry the real, correctly-computed safe fields —
    // this is redaction, not a broken/empty response.
    expect(card.freshnessClass).toBe("FRESH");
    expect(card.jurisdictions).toEqual(["US", "CA"]);
    expect(card.monthlyCapacityBand).toBe("1M_5M");
    expect(card.riskTier).toBe("LOW");
  });

  it("THE PROOF (opportunity): a market-level, non-owner browser's raw JSON response contains no ownerOrgId or exact volume figure, only the derived band", async () => {
    const res = await app.inject({ method: "GET", url: "/market/opportunities", headers: { cookie: providerSession.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const card = body.cards.find((c: { cardId: string }) => c.cardId === opportunityId);
    expect(card).toBeDefined();

    const keys = Object.keys(card);
    for (const forbidden of ["ownerOrgId", "totalPaymentVolumeMinor", "totalCardGpvMinor", "eligibleCardGpvMinor", "offeredCardGpvMinor", "movableNowMinor", "movable30dMinor", "movable90dMinor"]) {
      expect(keys, `card unexpectedly has key "${forbidden}"`).not.toContain(forbidden);
    }
    // Card-scoped, not the full cross-org `body` — same reasoning as the
    // capacity proof above.
    expect(JSON.stringify(card)).not.toContain(merchantBrowser.org.id);
    expect(card.offeredVolumeBand).toBe("1M_5M");
  });

  it("the SAME capacity profile's FULL data (including commercialTerms and providerOrgId) IS reachable via the dedicated, non-market endpoint — proving this is targeted redaction, not broken/missing data", async () => {
    const res = await app.inject({ method: "GET", url: `/capacity-profiles/${capacityProfileId}`, headers: { cookie: providerSession.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providerOrgId).toBe(provider.org.id);
    expect(body.commercialTerms.mdrBps).toBe(SECRET_MDR_BPS);
    expect(body.commercialTerms.fixedFeeMinor).toBe(SECRET_FIXED_FEE_MINOR);
  });

  it("is the SAME redacted shape for the OPERATOR too, and for the actual OWNER browsing the general market listing — the market view is a uniform catalog, never personalized by who's asking (see marketplace/mapper.ts's own header comment)", async () => {
    const asOperator = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: operatorSession.cookie } });
    const asOwner = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: providerSession.cookie } });
    for (const res of [asOperator, asOwner]) {
      const card = res.json().cards.find((c: { cardId: string }) => c.cardId === capacityProfileId);
      expect(Object.keys(card)).not.toContain("commercialTerms");
      expect(Object.keys(card)).not.toContain("providerOrgId");
    }
  });

  it("holds even for PLATFORM_OWNER — the ONE role @tol/authz's fieldPolicy() grants unconditional SECRET-tier visibility to, independent of resource ownership (review, correctly flagged that fieldPolicy() itself WOULD let SECRET-tagged fields survive redactFields() for this role — verified true at that layer — but incorrectly concluded this 'exposes' them: the mapper's return statement is a fixed, hand-picked field list that never reads commercialTerms/providerOrgId back out of the intermediate redacted object for ANY role, Platform Owner included — this test proves that empirically, not just by re-reading the code)", async () => {
    const platformOwner = await createFixtureOrgWithUser({ orgLabel: "MarketPlatformOwner", role: "PLATFORM_OWNER", entityType: "PLATFORM" });
    const platformOwnerSession = await login(app, platformOwner.user.email, platformOwner.user.password);

    const res = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: platformOwnerSession.cookie } });
    expect(res.statusCode).toBe(200);
    const card = res.json().cards.find((c: { cardId: string }) => c.cardId === capacityProfileId);
    expect(card).toBeDefined();
    expect(Object.keys(card)).toEqual(["cardId", "freshnessClass", "acceptingNewVolume", "jurisdictions", "mccsAccepted", "currency", "monthlyCapacityBand", "riskTier"]);
    // Card-scoped, not the full cross-org response — same reasoning as
    // the capacity proof above (this file's first test).
    expect(JSON.stringify(card)).not.toContain(String(SECRET_MDR_BPS));
    expect(JSON.stringify(card)).not.toContain(provider.org.id);
  });

  it("ALLOWS every persona sampled across the matrix to browse both market endpoints without a 403 — the blanket cross-org grant, live", async () => {
    const auditor = await createFixtureOrgWithUser({ orgLabel: "MarketAuditor", role: "AUDITOR_READONLY", entityType: "PLATFORM" });
    const auditorSession = await login(app, auditor.user.email, auditor.user.password);
    for (const session of [providerSession, merchantBrowserSession, operatorSession, auditorSession]) {
      const capRes = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: session.cookie } });
      const oppRes = await app.inject({ method: "GET", url: "/market/opportunities", headers: { cookie: session.cookie } });
      expect(capRes.statusCode).toBe(200);
      expect(oppRes.statusCode).toBe(200);
    }
  });

  it("is deterministic — two independent GETs of the same market listing produce byte-identical cards for the same underlying data", async () => {
    const first = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: merchantBrowserSession.cookie } });
    const second = await app.inject({ method: "GET", url: "/market/capacity", headers: { cookie: merchantBrowserSession.cookie } });
    const cardFirst = first.json().cards.find((c: { cardId: string }) => c.cardId === capacityProfileId);
    const cardSecond = second.json().cards.find((c: { cardId: string }) => c.cardId === capacityProfileId);
    expect(cardFirst).toEqual(cardSecond);
  });
});
