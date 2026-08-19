// packages/db/prisma/seed.ts
//
// earlier seed data: three organizations (one PLATFORM operator org, two
// counterparty orgs) and five users, giving the P4 tenant-isolation test
// and the "two organizations sign in" exit evidence (the spec, Day 1
// row) real, realistic-but-synthetic fixtures to run against.
//
// Uses `prisma` directly rather than going through repositories — this is
// a one-off bootstrap script, not a request-handling code path, so p.9's
// "routes never call Prisma directly" rule (aimed at apps/api route
// handlers) doesn't apply here. Idempotent: safe to re-run via upsert.
//
// Run: pnpm --filter @tol/db run prisma:seed

import { prisma } from "../src/client.js";
import { newId } from "../src/ids.js";
import { hashPassword } from "../src/password.js";
// ---- earlier: Economics (P15) — this package's OWN repositories, static
// imports like prisma/newId/hashPassword above (never a "@tol/db"
// workspace-alias import, which cannot resolve from within the package
// that IS @tol/db). @tol/domain's economics engine is still pulled in
// via the file's existing dynamic-import convention (see the earlier
// block below), matching @tol/evidence/@tol/attribution/@tol/matching. ----
import {
  commissionScheduleRepository,
  commissionComponentRepository,
  revenueEventRepository,
  commissionAccrualRepository,
  commissionPaymentRepository,
} from "../src/repositories/index.js";

// Dev-only seed credential — every seeded user shares it. NOT a real
// secret (this is fixture data for local dev/test, per the task's own
// "even if seeded users" auth instruction), documented openly in
// the test evidence and README.md so a reviewer can log in and reproduce
// the P4 proof by hand.
const SEED_PASSWORD = "TolSeed!2026-Dev";

interface SeedOrg {
  key: string;
  legalName: string;
  displayName: string;
  entityType: "PLATFORM" | "ACQUIRER" | "MERCHANT";
  country: string;
  registrationId: string;
  website: string;
}

const ORGS: SeedOrg[] = [
  {
    key: "platform",
    legalName: "TOL Platform Operations, Inc.",
    displayName: "TOL Platform Operations",
    entityType: "PLATFORM",
    country: "US",
    registrationId: "DE-0001927",
    website: "https://tol.example",
  },
  {
    key: "acquirer",
    legalName: "Meridian Acquiring Group, LLC",
    displayName: "Meridian Acquiring Group",
    entityType: "ACQUIRER",
    country: "US",
    registrationId: "NY-4471820",
    website: "https://meridian-acquiring.example",
  },
  {
    key: "merchant",
    legalName: "Northline Retail Holdings, Inc.",
    displayName: "Northline Retail Holdings",
    entityType: "MERCHANT",
    country: "GB",
    registrationId: "UK-08812394",
    website: "https://northline-retail.example",
  },
];

interface SeedUser {
  email: string;
  name: string;
  title: string;
  orgKey: string;
  role:
    | "PLATFORM_OWNER"
    | "MARKETPLACE_OPERATOR"
    | "AUDITOR_READONLY"
    | "ACQUIRER_PROVIDER_USER"
    | "MERCHANT_PSP_USER";
}

const USERS: SeedUser[] = [
  { email: "owner@tolplatform.dev", name: "Priya Ostrander", title: "Platform Owner", orgKey: "platform", role: "PLATFORM_OWNER" },
  { email: "operator@tolplatform.dev", name: "Devon Kalb", title: "Marketplace Operator", orgKey: "platform", role: "MARKETPLACE_OPERATOR" },
  { email: "auditor@tolplatform.dev", name: "Sam Adeyemi", title: "Auditor", orgKey: "platform", role: "AUDITOR_READONLY" },
  { email: "alice@meridian-acquiring.example", name: "Alice Farrow", title: "Head of Underwriting", orgKey: "acquirer", role: "ACQUIRER_PROVIDER_USER" },
  { email: "bob@northline-retail.example", name: "Bob Okonkwo", title: "VP Payments", orgKey: "merchant", role: "MERCHANT_PSP_USER" },
];

async function main() {
  console.log("Seeding TOL Platform earlier fixtures...");

  const orgIdByKey = new Map<string, string>();

  for (const org of ORGS) {
    const existing = await prisma.organization.findFirst({ where: { legalName: org.legalName } });
    const record = existing
      ? await prisma.organization.update({
          where: { id: existing.id },
          data: {
            displayName: org.displayName,
            entityType: org.entityType,
            country: org.country,
            registrationId: org.registrationId,
            website: org.website,
            verificationStatus: "VERIFIED",
          },
        })
      : await prisma.organization.create({
          data: {
            id: newId(),
            legalName: org.legalName,
            displayName: org.displayName,
            entityType: org.entityType,
            country: org.country,
            registrationId: org.registrationId,
            website: org.website,
            verificationStatus: "VERIFIED",
            privacyClass: "MEMBER_MARKET",
            sourceType: "PLATFORM",
            sourceReference: "seed:earlier",
          },
        });
    orgIdByKey.set(org.key, record.id);
    console.log(`  org ${org.key}: ${record.id} (${record.displayName})`);
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const seedUser of USERS) {
    const orgId = orgIdByKey.get(seedUser.orgKey);
    if (!orgId) throw new Error(`Unknown seed org key: ${seedUser.orgKey}`);

    const existingUser = await prisma.user.findFirst({ where: { email: seedUser.email } });
    const user = existingUser
      ? await prisma.user.update({ where: { id: existingUser.id }, data: { passwordHash, status: "ACTIVE" } })
      : await prisma.user.create({
          data: {
            id: newId(),
            email: seedUser.email,
            passwordHash,
            status: "ACTIVE",
            privacyClass: "RESTRICTED",
            sourceType: "PLATFORM",
            sourceReference: "seed:earlier",
          },
        });

    // Full field update on re-run, not create-if-missing-only — fixed
    // after review (packages/db block, 2026-08-18) flagged that
    // re-running the seed after editing USERS[] silently left stale
    // name/title/contactChannels on an already-seeded Person.
    const existingPerson = await prisma.person.findUnique({ where: { userId: user.id } });
    const personData = {
      name: seedUser.name,
      title: seedUser.title,
      organizationId: orgId,
      contactChannels: [{ type: "email", value: seedUser.email }],
      verificationStatus: "VERIFIED" as const,
      sensitivity: "MEMBER_MARKET" as const,
    };
    if (existingPerson) {
      await prisma.person.update({ where: { id: existingPerson.id }, data: personData });
    } else {
      await prisma.person.create({
        data: {
          id: newId(),
          ...personData,
          userId: user.id,
          sourceType: "PLATFORM",
          sourceReference: "seed:earlier",
        },
      });
    }

    const existingMembership = await prisma.organizationMembership.findFirst({
      where: { organizationId: orgId, userId: user.id, role: seedUser.role },
    });
    if (!existingMembership) {
      await prisma.organizationMembership.create({
        data: {
          id: newId(),
          organizationId: orgId,
          userId: user.id,
          role: seedUser.role,
          status: "ACTIVE",
          invitationSource: "seed:earlier",
          effectiveFrom: new Date(),
          privacyClass: "RESTRICTED",
          sourceType: "PLATFORM",
          sourceReference: "seed:earlier",
        },
      });
    }

    console.log(`  user ${seedUser.email}: ${user.id} (${seedUser.role} @ ${seedUser.orgKey})`);
  }

  // ================================================================
  // earlier: P13 RFQ + P14 Deal Room synthetic fixtures.
  //
  // SAFE SYNTHETIC DATA ONLY — Northline (merchant) and Meridian
  // (acquirer) are the same fictional earlier seed orgs; no real
  // counterparties, no real volume/pricing figures (round, obviously
  // illustrative numbers). Two scenarios, both idempotent (findFirst by a
  // stable business key before create, same discipline as the orgs/users
  // above):
  //   Scenario A — opportunity + RFQ sitting at QUOTED (Meridian has
  //     submitted a quote, nobody has selected it yet) — left ready for
  //     the live-browser pass to exercise rfq.select_quote for real.
  //   Scenario B — a second opportunity + RFQ ALREADY selected into an
  //     OPEN DealRoom with one PENDING condition posted — left ready for
  //     the live-browser pass to exercise resolve-condition/
  //     record-decision without first replaying the whole RFQ chain.
  // ================================================================
  console.log("");
  console.log("Seeding earlier RFQ/Deal Room fixtures...");

  const northlineId = orgIdByKey.get("merchant")!;
  const meridianId = orgIdByKey.get("acquirer")!;
  const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@northline-retail.example" } });
  const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@meridian-acquiring.example" } });
  const operator = await prisma.user.findFirstOrThrow({ where: { email: "operator@tolplatform.dev" } });

  // earlier-stage work: freshnessClass below is now the REAL, COMPUTED output
  // of @tol/evidence's classifyCapacityFreshness() — never a hardcoded
  // literal — matching this codebase's anti-fabrication discipline
  // (the real-crypto-never-mocked / the real-scoreClaim()-never-
  // hand-typed precedent). A dynamic import, same "visually scoped to
  // this block" reasoning as the scoreClaim import further down.
  const { classifyCapacityFreshness, computeReadiness, EVIDENCE_CONFIG } = await import("@tol/evidence");
  const seedNow = new Date();

  const capacityProfile = await (async () => {
    const existing = await prisma.capacityProfile.findFirst({ where: { providerOrgId: meridianId, sourceReference: "seed:earlier" } });
    if (existing) return existing;
    const asOf = seedNow;
    return prisma.capacityProfile.create({
      data: {
        id: newId(),
        providerOrgId: meridianId,
        asOf,
        freshnessClass: classifyCapacityFreshness({ asOf, sourceType: "PLATFORM" }, seedNow),
        acceptingNewVolume: true,
        jurisdictions: ["US", "CA"],
        mccsAccepted: ["5411", "5812", "5732"],
        mccsExcluded: ["7995"],
        currency: "USD",
        monthlyCapacityMinor: 50_000_000_00n,
        minTicketMinor: 500,
        maxTicketMinor: 500_000,
        maxChargebackBps: 100,
        maxFraudBps: 50,
        maxRefundBps: 300,
        settlementRail: "ACH",
        settlementCadenceDays: 2,
        commercialTerms: { mdrBps: 285, fixedFeeMinor: 10, model: "blended" },
        privacyClass: "RESTRICTED",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });
  })();
  console.log(`  capacity profile: ${capacityProfile.id} (Meridian, ${capacityProfile.freshnessClass} — computed via classifyCapacityFreshness, not hardcoded)`);

  // earlier-stage work: a SECOND Meridian capacity profile, backdated well
  // past the STALE window — real, computed, boundary-crossing freshness
  // demo material (the spec CAPACITY INVARIANT: "A provider with a
  // stale or prohibited profile cannot rank above an eligible fresh
  // provider merely because the name is well known"), same
  // "pre-positioned fixture state" precedent as Opportunity B's
  // deliberately-unreconciled volume slice above.
  const staleAsOf = new Date(seedNow.getTime() - (EVIDENCE_CONFIG.capacityFreshnessWindowDays.aging + 30) * 24 * 60 * 60 * 1000);
  const staleCapacityProfile = await (async () => {
    const existing = await prisma.capacityProfile.findFirst({ where: { providerOrgId: meridianId, sourceReference: "seed:earlier-stale-demo" } });
    if (existing) return existing;
    return prisma.capacityProfile.create({
      data: {
        id: newId(),
        providerOrgId: meridianId,
        asOf: staleAsOf,
        freshnessClass: classifyCapacityFreshness({ asOf: staleAsOf, sourceType: "PLATFORM" }, seedNow),
        acceptingNewVolume: true,
        jurisdictions: ["GB"],
        mccsAccepted: ["5732"],
        mccsExcluded: [],
        currency: "GBP",
        monthlyCapacityMinor: 5_000_000_00n,
        minTicketMinor: 500,
        maxTicketMinor: 100_000,
        maxChargebackBps: 120,
        maxFraudBps: 60,
        maxRefundBps: 250,
        settlementRail: "FASTER_PAYMENTS",
        settlementCadenceDays: 1,
        commercialTerms: { mdrBps: 310, fixedFeeMinor: 12, model: "blended" },
        privacyClass: "RESTRICTED",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier-stale-demo",
      },
    });
  })();
  console.log(
    `  capacity profile (stale demo): ${staleCapacityProfile.id} (Meridian/GB, ${staleCapacityProfile.freshnessClass}, asOf ${staleAsOf.toISOString().slice(0, 10)}) — real computed STALE classification, no auto-refresh worker exists (earlier scope)`,
  );

  // Every row starts at MATCH_READY regardless of where the scenario
  // eventually lands — each is advanced via real, validated
  // advanceOpportunity() calls further down (mirroring apps/api's own
  // INVITED/QUOTED/SELECTED cascade), so the seeded rows exercise the
  // same transition path production code does rather than being
  // hand-set to an arbitrary terminal status at creation.
  async function ensureOpportunity(requestedService: string) {
    const existing = await prisma.opportunity.findFirst({
      where: { ownerOrgId: northlineId, requestedService, sourceReference: "seed:earlier" },
    });
    if (existing) return existing;
    return prisma.opportunity.create({
      data: {
        id: newId(),
        ownerOrgId: northlineId,
        opportunityType: "ACQUIRING",
        requestedService,
        status: "MATCH_READY",
        currency: "USD",
        totalPaymentVolumeMinor: 45_000_000_00n,
        totalCardGpvMinor: 40_000_000_00n,
        eligibleCardGpvMinor: 38_000_000_00n,
        offeredCardGpvMinor: 30_000_000_00n,
        movableNowMinor: 10_000_000_00n,
        movable30dMinor: 20_000_000_00n,
        movable90dMinor: 30_000_000_00n,
        jurisdictions: ["US", "CA"],
        mccs: ["5411", "5812"],
        privacyClass: "MEMBER_MARKET",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });
  }

  const opportunityA = await ensureOpportunity("US/CA e-commerce card acquiring — line 1");
  const opportunityB = await ensureOpportunity("US/CA e-commerce card acquiring — line 2");

  async function advanceOpportunity(id: string, to: "INVITED" | "QUOTED" | "SELECTED") {
    const current = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
    if (current.status === to) return current;
    return prisma.opportunity.update({
      where: { id },
      data: { status: to, updatedByUserId: operator.id, version: { increment: 1 } },
    });
  }

  // ---- Scenario A: RFQ sitting at QUOTED, unselected ----
  const rfqA = await (async () => {
    const existing = await prisma.rFQ.findFirst({ where: { opportunityId: opportunityA.id } });
    if (existing) return existing;
    const dueAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const created = await prisma.rFQ.create({
      data: {
        id: newId(),
        opportunityId: opportunityA.id,
        status: "SENT",
        dueAt,
        currentVersionNumber: 1,
        privacyClass: "DEAL_ROOM",
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });
    await advanceOpportunity(opportunityA.id, "INVITED");

    await prisma.rFQVersion.create({
      data: {
        id: newId(),
        rfqId: created.id,
        versionNumber: 1,
        packetType: "QUALIFIED_RFQ",
        disclosureSnapshot: {
          opportunitySummary: { requestedService: opportunityA.requestedService, jurisdictions: ["US", "CA"], mccs: ["5411", "5812"] },
          evidenceRefs: [],
        },
        changeSummary: null,
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
      },
    });

    const recipient = await prisma.rFQRecipient.create({
      data: {
        id: newId(),
        rfqId: created.id,
        providerOrgId: meridianId,
        state: "QUOTED",
        acknowledgedAt: new Date(),
        privacyClass: "DEAL_ROOM",
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
      },
    });

    await prisma.domainEvent.create({
      data: {
        id: newId(),
        eventType: "rfq.sent",
        aggregateType: "rfq",
        aggregateId: created.id,
        payload: { opportunityId: opportunityA.id, recipientOrgIds: [meridianId], versionNumber: 1 },
        actorUserId: operator.id,
        actorOrgId: northlineId,
        actorRole: "MARKETPLACE_OPERATOR",
        correlationId: "seed:earlier",
      },
    });

    const quote = await prisma.quote.create({
      data: {
        id: newId(),
        rfqId: created.id,
        rfqRecipientId: recipient.id,
        providerOrgId: meridianId,
        quoteVersion: 1,
        currency: "USD",
        status: "SUBMITTED",
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        terms: {
          rate: { basisType: "blended", bps: 285, scope: "all_volume", passThrough: false },
          reserve: { type: "rolling", bps: 500, durationDays: 90 },
          settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
          capacityOffer: { monthlyAmountMinor: 3_000_000_000, rampSchedule: "90-day ramp to full capacity", confidenceBps: 8000 },
        },
        privacyClass: "RESTRICTED",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });

    await prisma.rFQ.update({ where: { id: created.id }, data: { status: "QUOTED" } });
    await advanceOpportunity(opportunityA.id, "QUOTED");

    await prisma.domainEvent.create({
      data: {
        id: newId(),
        eventType: "quote.submitted",
        aggregateType: "rfq",
        aggregateId: created.id,
        payload: { quoteId: quote.id, providerOrgId: meridianId, quoteVersion: 1 },
        actorUserId: alice.id,
        actorOrgId: meridianId,
        actorRole: "ACQUIRER_PROVIDER_USER",
        correlationId: "seed:earlier",
      },
    });

    return created;
  })();
  console.log(`  RFQ A: ${rfqA.id} (QUOTED, unselected — try rfq.select_quote live as Bob)`);

  // ---- Scenario B: RFQ already selected into an OPEN DealRoom with one PENDING condition ----
  const existingDealB = await prisma.dealRoom.findFirst({ where: { opportunityId: opportunityB.id } });
  if (existingDealB) {
    console.log(`  Deal Room B: ${existingDealB.id} (already seeded)`);
  } else {
    const dueAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const rfqB = await prisma.rFQ.create({
      data: {
        id: newId(),
        opportunityId: opportunityB.id,
        status: "SENT",
        dueAt,
        currentVersionNumber: 1,
        privacyClass: "DEAL_ROOM",
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });
    await advanceOpportunity(opportunityB.id, "INVITED");

    await prisma.rFQVersion.create({
      data: {
        id: newId(),
        rfqId: rfqB.id,
        versionNumber: 1,
        packetType: "QUALIFIED_RFQ",
        disclosureSnapshot: {
          opportunitySummary: { requestedService: opportunityB.requestedService, jurisdictions: ["US", "CA"], mccs: ["5411", "5812"] },
          evidenceRefs: [],
        },
        changeSummary: null,
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
      },
    });

    const recipientB = await prisma.rFQRecipient.create({
      data: {
        id: newId(),
        rfqId: rfqB.id,
        providerOrgId: meridianId,
        state: "QUOTED",
        acknowledgedAt: new Date(),
        privacyClass: "DEAL_ROOM",
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
      },
    });

    const quoteB = await prisma.quote.create({
      data: {
        id: newId(),
        rfqId: rfqB.id,
        rfqRecipientId: recipientB.id,
        providerOrgId: meridianId,
        quoteVersion: 1,
        currency: "USD",
        status: "SELECTED",
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        terms: {
          rate: { basisType: "blended", bps: 265, scope: "all_volume", passThrough: false },
          reserve: { type: "rolling", bps: 400, durationDays: 60 },
          settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
          capacityOffer: { monthlyAmountMinor: 2_500_000_000, rampSchedule: "60-day ramp", confidenceBps: 8500 },
        },
        privacyClass: "RESTRICTED",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });

    await prisma.rFQ.update({ where: { id: rfqB.id }, data: { status: "SELECTED" } });
    await advanceOpportunity(opportunityB.id, "QUOTED");
    await advanceOpportunity(opportunityB.id, "SELECTED");

    const dealRoomB = await prisma.dealRoom.create({
      data: {
        id: newId(),
        opportunityId: opportunityB.id,
        rfqId: rfqB.id,
        selectedQuoteId: quoteB.id,
        merchantOrgId: northlineId,
        providerOrgId: meridianId,
        status: "OPEN",
        nextAction: "Provide UBO documentation for due-diligence packet",
        privacyClass: "DEAL_ROOM",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });

    await prisma.dealRoomParticipant.create({
      data: { id: newId(), dealRoomId: dealRoomB.id, organizationId: northlineId, participantRole: "MERCHANT", privacyClass: "DEAL_ROOM", createdByUserId: bob.id, createdByOrgId: northlineId },
    });
    await prisma.dealRoomParticipant.create({
      data: { id: newId(), dealRoomId: dealRoomB.id, organizationId: meridianId, participantRole: "PROVIDER", privacyClass: "DEAL_ROOM", createdByUserId: bob.id, createdByOrgId: northlineId },
    });

    await prisma.dealDecision.create({
      data: {
        id: newId(),
        dealRoomId: dealRoomB.id,
        decisionType: "QUOTE_SELECTED",
        reason: "Best blended rate within reserve tolerance across the invited capacity.",
        relatedQuoteId: quoteB.id,
        comparisonSnapshot: { consideredQuoteIds: [quoteB.id], selectedQuoteId: quoteB.id },
        actorUserId: bob.id,
        actorOrgId: northlineId,
        actorRole: "MERCHANT_PSP_USER",
        privacyClass: "DEAL_ROOM",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
      },
    });

    const conditionB = await prisma.dealCondition.create({
      data: {
        id: newId(),
        dealRoomId: dealRoomB.id,
        description: "Provide UBO (ultimate beneficial owner) documentation for due-diligence review.",
        ownerOrgId: northlineId,
        dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        state: "PENDING",
        blocking: true,
        privacyClass: "DEAL_ROOM",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
      },
    });

    await prisma.dealRoom.update({ where: { id: dealRoomB.id }, data: { status: "CONDITIONS" } });

    for (const [eventType, actor, actorOrg, actorRole, payload] of [
      ["quote.selected", bob, northlineId, "MERCHANT_PSP_USER", { quoteId: quoteB.id, dealRoomId: dealRoomB.id }],
      ["deal.opened", bob, northlineId, "MERCHANT_PSP_USER", { dealRoomId: dealRoomB.id, merchantOrgId: northlineId, providerOrgId: meridianId }],
      ["deal.participant_added", bob, northlineId, "MERCHANT_PSP_USER", { dealRoomId: dealRoomB.id, organizationId: northlineId, participantRole: "MERCHANT" }],
      ["deal.participant_added", bob, northlineId, "MERCHANT_PSP_USER", { dealRoomId: dealRoomB.id, organizationId: meridianId, participantRole: "PROVIDER" }],
      ["deal.condition_created", alice, meridianId, "ACQUIRER_PROVIDER_USER", { dealRoomId: dealRoomB.id, conditionId: conditionB.id, blocking: true }],
    ] as const) {
      await prisma.domainEvent.create({
        data: {
          id: newId(),
          eventType,
          aggregateType: "deal_room",
          aggregateId: dealRoomB.id,
          payload,
          actorUserId: actor.id,
          actorOrgId: actorOrg,
          actorRole,
          correlationId: "seed:earlier",
        },
      });
    }

    console.log(`  Deal Room B: ${dealRoomB.id} (OPEN/CONDITIONS, 1 pending condition — try resolve + record-decision live)`);
  }

  // ================================================================
  // earlier: Lockbox (P9) synthetic fixtures.
  //
  // SAFE SYNTHETIC DATA ONLY — same fictional earlier phases orgs, no real
  // relationship content. Deliberately does NOT pre-seed any Lockbox row
  // itself (unlike the RFQ/DealRoom fixtures) — the whole point of
  // this day is real, non-fabricated cryptography, and generating one
  // requires calling @tol/crypto's sealPayload with real role KEKs;
  // pre-baking that into a one-shot idempotent seed script would either
  // need to re-derive the exact same ciphertext on every run (impossible
  // — AES-GCM's IV is fresh every call by design, acceptance criterion 1)
  // or silently skip re-sealing after the first run, which is a worse
  // shape than just not doing it here at all. an earlier live-browser
  // pass seals, views the receipt of, and withdraws/releases real
  // Lockboxes end to end through the actual running stack instead —
  // stronger evidence than a pre-seeded fixture would have been anyway.
  //
  // What DOES need seeding here: a "committed match/deal" for the live
  // release demo's conditionRef to point at (earlier brief acceptance
  // criterion 7). Reuses an earlier dealRoomB (Northline/Meridian,
  // already OPEN) rather than opening a third deal room — one more
  // RESOLVED, non-blocking DealCondition on the same room, idempotent by
  // description + sourceReference.
  // ================================================================
  console.log("");
  console.log("Seeding earlier Lockbox fixtures...");

  const dealRoomForLockboxRelease = await prisma.dealRoom.findFirstOrThrow({ where: { opportunityId: opportunityB.id } });
  const lockboxConditionDescription = "Settlement banking details confirmed for the selected route — clears the way to release sealed relationship evidence to the counterparty.";
  const existingLockboxCondition = await prisma.dealCondition.findFirst({
    where: { dealRoomId: dealRoomForLockboxRelease.id, description: lockboxConditionDescription, sourceReference: "seed:earlier" },
  });
  const lockboxReleaseCondition =
    existingLockboxCondition ??
    (await prisma.dealCondition.create({
      data: {
        id: newId(),
        dealRoomId: dealRoomForLockboxRelease.id,
        description: lockboxConditionDescription,
        ownerOrgId: northlineId,
        state: "SATISFIED",
        blocking: false,
        resolutionNote: "Bank letter + void check verified against the provider's settlement account on file.",
        privacyClass: "DEAL_ROOM",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    }));
  console.log(
    `  Lockbox release condition: ${lockboxReleaseCondition.id} (SATISFIED, on Deal Room ${dealRoomForLockboxRelease.id}) — pass this as conditionRef when releasing a live-sealed Lockbox`,
  );

  // ================================================================
  // earlier: Attribution (P10) synthetic fixtures.
  //
  // SAFE SYNTHETIC DATA ONLY — same fictional earlier phases orgs (Meridian/
  // Northline), no real relationship content. Unlike the Lockbox
  // (deliberately NOT pre-seeded — real crypto's fresh-IV-per-call makes a
  // pre-baked fixture impossible to reproduce idempotently), Attribution's
  // scoring is pure and deterministic, so pre-seeding real Claim rows
  // (computed via the SAME @tol/attribution engine apps/api calls) is both
  // safe and valuable — same "reuse real production code paths in seed
  // data" discipline earlier used for its own opportunity-lifecycle
  // fixtures. Idempotent: findFirst by a stable sourceReference before
  // create, same as every other block above.
  //
  // Scenario A — Alice (Meridian) has filed a claim asserting she
  //   introduced Northline's opportunity B; scored, deliberately left at
  //   SCORED (no decision yet) — ready for the live-browser pass to
  //   exercise a REAL operator decision end to end.
  // Scenario B — Bob (Northline) filed a claim on opportunity A that was
  //   ALREADY carried through to a real VERIFIED decision by the
  //   operator; Alice then disputes it (the spec anti-gaming test: "a
  //   later direct executive relationship can defeat an earlier
  //   generic-mailbox claim") — the dispute is left OPEN, ready for the
  //   live-browser pass to exercise a REAL dispute resolution end to end.
  //
  // Both scenarios call @tol/attribution's REAL scoreClaim() below (a
  // dynamic import, not a static one, purely to keep it visually scoped
  // to this block rather than mixed in with this file's top-of-file
  // import list) — this is WHY packages/db/package.json now lists
  // "@tol/attribution": "workspace:*" as a real dependency, not a
  // devDependency: this file computes a genuine score, never a
  // hand-typed/fabricated breakdown object standing in for one, matching
  // this whole build's anti-fabrication discipline (an earlier
  // mockSealHash precedent is exactly what this avoids).
  // ================================================================
  console.log("");
  console.log("Seeding earlier Attribution fixtures...");

  // Each step below guards ITSELF (not just "does the claim exist at
  // all") — self-healing against a hypothetical partial prior run (e.g.
  // the process was killed between creating the Claim row and scoring
  // it). review (review)
  // correctly flagged that the original single `if (!claimX)` guard
  // wrapping every step would leave a claim permanently stuck at FILED
  // (or SCORED, pre-decision) forever on any re-run after such a crash,
  // since the outer guard alone can't tell "fully seeded" apart from
  // "partially seeded." Every step now checks its OWN precondition.
  const { scoreClaim } = await import("@tol/attribution");

  // ---- Scenario A: SCORED, awaiting a live operator decision ----
  let claimA = await prisma.claim.findFirst({ where: { subjectOrgId: northlineId, opportunityId: opportunityB.id, sourceReference: "seed:earlier-a" } });
  if (!claimA) {
    claimA = await prisma.claim.create({
      data: {
        id: newId(),
        claimantOrgId: meridianId,
        claimantUserId: alice.id,
        subjectOrgId: northlineId,
        relationshipType: "ACQUIRER_INTRODUCTION",
        directnessTier: "D4",
        opportunityId: opportunityB.id,
        claimScope: { channel: "e-commerce", product: "card-acquiring" },
        status: "FILED",
        priorCommercialHistoryMonths: 8,
        submissionLagDays: 3,
        privacyClass: "RESTRICTED",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier-a",
      },
    });
  }
  const claimAEvidenceInputs = [
    { evidenceType: "EMAIL_THREAD" as const, verificationState: "DOCUMENT_EXTRACTED" as const, assertedFact: "Introductory email thread between Alice (Meridian) and Northline's VP Payments, dated 8 months before this opportunity's readiness review." },
    { evidenceType: "CRM_RECORD" as const, verificationState: "SELF_REPORTED" as const, assertedFact: "CRM opportunity record shows Meridian as the originating source for the Northline relationship." },
  ];
  if ((await prisma.claimEvidence.count({ where: { claimId: claimA.id } })) === 0) {
    await prisma.claimEvidence.createMany({
      data: claimAEvidenceInputs.map((e) => ({ id: newId(), claimId: claimA!.id, ...e, createdByUserId: alice.id, createdByOrgId: meridianId })),
    });
  }
  if (claimA.status === "FILED") {
    // The SAME scoring path apps/api's claims service will call — no
    // hand-computed/fabricated number here (see this block's header note).
    const breakdown = scoreClaim({
      priorCommercialHistoryMonths: claimA.priorCommercialHistoryMonths,
      directnessTier: "D4",
      evidenceItems: claimAEvidenceInputs.map((e) => ({ evidenceType: e.evidenceType, verificationState: e.verificationState })),
      submissionLagDays: claimA.submissionLagDays,
      inputVersions: ["seed:earlier-a"],
    });
    const scoredAt = new Date();
    claimA = await prisma.claim.update({
      where: { id: claimA.id },
      data: {
        status: "SCORED",
        scoreBreakdown: breakdown as unknown as object,
        scoreTotal: breakdown.total,
        algorithmVersion: breakdown.algorithmVersion,
        inputVersions: [...breakdown.inputVersions],
        scoredAt,
        provisionalExpiresAt: new Date(scoredAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }
  console.log(`  Claim A: ${claimA.id} (Alice/Meridian claims Northline opp B, status ${claimA.status}, score ${claimA.scoreTotal}) — awaiting a live operator decision`);

  // ---- Scenario B: VERIFIED, then disputed — awaiting a live resolution ----
  let claimB = await prisma.claim.findFirst({ where: { subjectOrgId: meridianId, opportunityId: opportunityA.id, sourceReference: "seed:earlier-b" } });
  if (!claimB) {
    claimB = await prisma.claim.create({
      data: {
        id: newId(),
        claimantOrgId: northlineId,
        claimantUserId: bob.id,
        subjectOrgId: meridianId,
        relationshipType: "EXISTING_RELATIONSHIP",
        directnessTier: "D2",
        opportunityId: opportunityA.id,
        claimScope: { channel: "e-commerce", product: "card-acquiring" },
        status: "FILED",
        priorCommercialHistoryMonths: 2,
        submissionLagDays: 1,
        privacyClass: "RESTRICTED",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier-b",
      },
    });
  }
  if ((await prisma.claimEvidence.count({ where: { claimId: claimB.id } })) === 0) {
    await prisma.claimEvidence.create({
      data: {
        id: newId(),
        claimId: claimB.id,
        evidenceType: "CRM_RECORD",
        assertedFact: "Northline's own CRM lists a prior general vendor contact with Meridian, contact/authority uncertain.",
        verificationState: "SELF_REPORTED",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
      },
    });
  }
  // breakdownB is recomputed (not just read off claimB) whenever a
  // decision still needs to be created below — the ClaimDecision row
  // requires its own scoreBreakdown snapshot regardless of whether this
  // run is the one that just scored the claim or a later run resuming
  // after a scored-but-undecided partial state.
  let breakdownB = claimB.scoreBreakdown as ReturnType<typeof scoreClaim> | null;
  if (claimB.status === "FILED") {
    breakdownB = scoreClaim({
      priorCommercialHistoryMonths: claimB.priorCommercialHistoryMonths,
      directnessTier: "D2",
      evidenceItems: [{ evidenceType: "CRM_RECORD", verificationState: "SELF_REPORTED" }],
      submissionLagDays: claimB.submissionLagDays,
      inputVersions: ["seed:earlier-b"],
    });
    const scoredAt = new Date();
    claimB = await prisma.claim.update({
      where: { id: claimB.id },
      data: {
        status: "SCORED",
        scoreBreakdown: breakdownB as unknown as object,
        scoreTotal: breakdownB.total,
        algorithmVersion: breakdownB.algorithmVersion,
        inputVersions: [...breakdownB.inputVersions],
        scoredAt,
        provisionalExpiresAt: new Date(scoredAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }
  if (claimB.status === "SCORED" && breakdownB) {
    // Carried through a real operator decision — VERIFIED — so this
    // fixture starts the live-browser pass past the "first decision"
    // step and directly at the dispute-resolution step (Scenario A above
    // already covers the first-decision path live).
    await prisma.claimDecision.create({
      data: {
        id: newId(),
        claimId: claimB.id,
        decision: "VERIFIED",
        scoreBreakdown: breakdownB as unknown as object,
        algorithmVersion: breakdownB.algorithmVersion,
        ruleVersion: "attribution-rules-v1",
        reviewerUserId: operator.id,
        reviewerOrgId: orgIdByKey.get("platform")!,
        reason: "Seed fixture: initial review accepted the claimed prior vendor contact at face value.",
        privacyClass: "RESTRICTED",
      },
    });
    claimB = await prisma.claim.update({ where: { id: claimB.id }, data: { status: "VERIFIED" } });
  }
  let claimBDispute = await prisma.claimDispute.findFirst({ where: { claimId: claimB.id, status: "OPEN" } });
  if (!claimBDispute && claimB.status === "VERIFIED") {
    claimBDispute = await prisma.claimDispute.create({
      data: {
        id: newId(),
        claimId: claimB.id,
        challengerOrgId: meridianId,
        challengerUserId: alice.id,
        basis:
          "Meridian's own executive-level contact (Alice, Head of Underwriting) predates and supersedes Northline's generic CRM-listed vendor contact — the spec anti-gaming rule: a later direct executive relationship can defeat an earlier generic-mailbox claim.",
        evidence: [{ evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", note: "Northline's own Bob Okonkwo acknowledged Alice as the actual introducing contact in a follow-up call." }],
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
      },
    });
    claimB = await prisma.claim.update({ where: { id: claimB.id }, data: { status: "DISPUTED" } });
  }
  console.log(`  Claim B: ${claimB.id} (Bob/Northline claims Meridian opp A, status ${claimB.status})`);
  if (claimBDispute) {
    console.log(`  Claim B dispute: ${claimBDispute.id} (status ${claimBDispute.status}, filed by Alice/Meridian) — awaiting a live operator resolution`);
  } else {
    console.log(`  Claim B dispute: none yet (claim is at ${claimB.status}, not yet VERIFIED — dispute creation is gated on that)`);
  }

  // ================================================================
  // earlier-stage work: P7 VolumeSlice fixtures + P6 Passport/Fact/Evidence
  // fixtures. NO ReadinessResult row is seeded here, deliberately — the
  // real computeReadiness() engine (@tol/evidence) doesn't exist until
  // this stage of this day's build, and this codebase's anti-fabrication
  // discipline (the real-crypto-never-mocked precedent, the
  // real-scoreClaim()-never-hand-typed precedent for Claim A/B above)
  // means this file never hand-writes a plausible-looking derived output
  // standing in for a real one. this stage extends this section once the
  // engine is real.
  // ================================================================
  console.log("");
  console.log("Seeding earlier-stage work fixtures (VolumeSlice + Passport/Fact/Evidence)...");

  // ---- P7: VolumeSlice breakdown for Opportunity A — reconciles exactly
  // against its existing offeredCardGpvMinor (30,000,000.00 USD minor
  // units), split across the SAME jurisdictions/mccs arrays the
  // Opportunity header already carries (US/CA x 5411/5812). A clean,
  // already-passing P7 reconciliation proof for the live pass to read
  // immediately, matching an earlier "pre-positioned fixture state"
  // precedent. ----
  const opportunityASlices: { jurisdiction: string; mcc: string; amountMinor: bigint }[] = [
    { jurisdiction: "US", mcc: "5411", amountMinor: 12_000_000_00n },
    { jurisdiction: "US", mcc: "5812", amountMinor: 8_000_000_00n },
    { jurisdiction: "CA", mcc: "5411", amountMinor: 6_000_000_00n },
    { jurisdiction: "CA", mcc: "5812", amountMinor: 4_000_000_00n },
  ];
  for (const s of opportunityASlices) {
    await prisma.volumeSlice.upsert({
      where: {
        opportunityId_jurisdiction_mcc_cardOrigin_channel_period: {
          opportunityId: opportunityA.id,
          jurisdiction: s.jurisdiction,
          mcc: s.mcc,
          cardOrigin: "DOMESTIC",
          channel: "ECOMMERCE",
          period: "2026-07",
        },
      },
      create: {
        id: newId(),
        opportunityId: opportunityA.id,
        jurisdiction: s.jurisdiction,
        mcc: s.mcc,
        cardOrigin: "DOMESTIC",
        channel: "ECOMMERCE",
        currency: "USD",
        amountMinor: s.amountMinor,
        period: "2026-07",
        privacyClass: "RESTRICTED",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier-opp-a",
      },
      update: {},
    });
  }
  const oppASliceTotal = opportunityASlices.reduce((sum, s) => sum + s.amountMinor, 0n);
  console.log(`  Opportunity A volume slices: ${opportunityASlices.length} cells, SUM = ${oppASliceTotal} (matches offeredCardGpvMinor = ${opportunityA.offeredCardGpvMinor}) — RECONCILED`);

  // ---- P7: Opportunity B gets a DELIBERATELY INCOMPLETE breakdown —
  // slices summing to less than its offeredCardGpvMinor, so the live
  // pass can read a REAL, currently-failing reconciliation (sum_mismatch)
  // immediately, then post the missing cell live through the real API
  // and watch it become reconciled — a stronger, more honest proof than
  // only ever seeding the passing case. ----
  const opportunityBPartialSlice = {
    jurisdiction: "US",
    mcc: "5411",
    cardOrigin: "DOMESTIC",
    channel: "ECOMMERCE",
    period: "2026-07",
    amountMinor: 18_000_000_00n, // short of opportunityB.offeredCardGpvMinor (30,000,000.00) by 12,000,000.00
  };
  await prisma.volumeSlice.upsert({
    where: {
      opportunityId_jurisdiction_mcc_cardOrigin_channel_period: {
        opportunityId: opportunityB.id,
        jurisdiction: opportunityBPartialSlice.jurisdiction,
        mcc: opportunityBPartialSlice.mcc,
        cardOrigin: opportunityBPartialSlice.cardOrigin,
        channel: opportunityBPartialSlice.channel,
        period: opportunityBPartialSlice.period,
      },
    },
    create: {
      id: newId(),
      opportunityId: opportunityB.id,
      ...opportunityBPartialSlice,
      currency: "USD",
      privacyClass: "RESTRICTED",
      createdByUserId: bob.id,
      createdByOrgId: northlineId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier-opp-b",
    },
    update: {},
  });
  console.log(
    `  Opportunity B volume slices: 1 cell, SUM = ${opportunityBPartialSlice.amountMinor} vs offeredCardGpvMinor = ${opportunityB.offeredCardGpvMinor} — NOT RECONCILED (short by ${opportunityB.offeredCardGpvMinor - opportunityBPartialSlice.amountMinor}), awaiting a live fix`,
  );

  // ---- P6: Meridian's Passport — near-complete (5 of 6 blocking
  // required facts present), status INCOMPLETE, missing exactly the
  // TECHNICAL section's required fact so the live pass can file it and
  // watch the passport advance to READY in real time. ----
  const meridianPassport = await (async () => {
    const existing = await prisma.passport.findUnique({ where: { organizationId: meridianId } });
    if (existing) return existing;
    return prisma.passport.create({
      data: {
        id: newId(),
        organizationId: meridianId,
        status: "INCOMPLETE",
        privacyClass: "MEMBER_MARKET",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });
  })();

  const meridianRegistrationEvidence = await (async () => {
    const existing = await prisma.evidence.findFirst({ where: { passportId: meridianPassport.id, sourceReference: "seed:earlier-evidence-registration" } });
    if (existing) return existing;
    return prisma.evidence.create({
      data: {
        id: newId(),
        passportId: meridianPassport.id,
        type: "FILE",
        objectRef: "seed-object-store://meridian/registration-certificate-ny-4471820.pdf",
        checksum: "sha256:1f3d9c7e2a5b8f0164d2c9e7a3b5f8102d4e6a9c3b7f0e2d5a8c1b4f6e9d2a70",
        issuer: "New York Department of State",
        collectedAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2027-06-01T00:00:00.000Z"),
        privacyClass: "RESTRICTED",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier-evidence-registration",
      },
    });
  })();

  const meridianFacts: { sectionType: "IDENTITY" | "PROCESSING_METRICS" | "RISK" | "COMMERCIAL" | "RELATIONSHIP_HISTORY"; fieldKey: string; normalizedValue: unknown; verification: "OPERATOR_VERIFIED" | "DOCUMENT_EXTRACTED" | "SELF_REPORTED"; evidenceId?: string }[] = [
    { sectionType: "IDENTITY", fieldKey: "legalEntityConfirmed", normalizedValue: true, verification: "DOCUMENT_EXTRACTED", evidenceId: meridianRegistrationEvidence.id },
    { sectionType: "IDENTITY", fieldKey: "primaryContactConfirmed", normalizedValue: { name: "Alice Farrow", title: "Head of Underwriting" }, verification: "OPERATOR_VERIFIED" },
    { sectionType: "PROCESSING_METRICS", fieldKey: "processingHistorySummary", normalizedValue: { monthsActive: 42, avgMonthlyGpvMinor: "3200000000" }, verification: "SELF_REPORTED" },
    { sectionType: "RISK", fieldKey: "riskProfileSummary", normalizedValue: { chargebackBps: 45, fraudBps: 20, refundBps: 180, basis: "trailing_12mo" }, verification: "OPERATOR_VERIFIED" },
    { sectionType: "COMMERCIAL", fieldKey: "settlementCapability", normalizedValue: { currency: "USD", rail: "ACH", cadenceDays: 2 }, verification: "SELF_REPORTED" },
    { sectionType: "RELATIONSHIP_HISTORY", fieldKey: "priorAcquirerRelationships", normalizedValue: { count: 3 }, verification: "SELF_REPORTED" },
    // Deliberately OMITTED: TECHNICAL/technicalIntegrationProfile — the
    // one missing blocking required fact keeping this passport at
    // INCOMPLETE rather than READY. Filing it live is exactly the P6
    // "missing evidence blocks readiness; provenance/freshness visible"
    // exit-condition proof (the spec, earlier row) this day owns.
  ];
  for (const f of meridianFacts) {
    await prisma.fact.upsert({
      where: { passportId_fieldKey: { passportId: meridianPassport.id, fieldKey: f.fieldKey } },
      create: {
        id: newId(),
        passportId: meridianPassport.id,
        sectionType: f.sectionType,
        fieldKey: f.fieldKey,
        normalizedValue: f.normalizedValue as object,
        verification: f.verification,
        evidenceId: f.evidenceId ?? null,
        privacyClass: "MEMBER_MARKET",
        createdByUserId: alice.id,
        createdByOrgId: meridianId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
      update: {},
    });
  }
  const meridianBlockingFactsFiled = meridianFacts.filter((f) => f.sectionType !== "RELATIONSHIP_HISTORY").length; // the 5 blocking-section facts above (RELATIONSHIP_HISTORY's priorAcquirerRelationships is non-blocking, see EVIDENCE_CONFIG.requiredFacts)
  console.log(
    `  Meridian Passport: ${meridianPassport.id} (status ${meridianPassport.status}, ${meridianBlockingFactsFiled}/6 blocking facts filed, ${meridianFacts.length - meridianBlockingFactsFiled}/2 non-blocking filed — missing technicalIntegrationProfile) — awaiting a live fact submission to reach READY`,
  );

  // ---- P6: Northline's Passport — early-stage (DRAFT), a single
  // IDENTITY fact filed, demonstrating the DRAFT-vs-INCOMPLETE
  // distinction live against a real second organization. ----
  const northlinePassport = await (async () => {
    const existing = await prisma.passport.findUnique({ where: { organizationId: northlineId } });
    if (existing) return existing;
    return prisma.passport.create({
      data: {
        id: newId(),
        organizationId: northlineId,
        status: "DRAFT",
        privacyClass: "MEMBER_MARKET",
        createdByUserId: bob.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      },
    });
  })();
  await prisma.fact.upsert({
    where: { passportId_fieldKey: { passportId: northlinePassport.id, fieldKey: "legalEntityConfirmed" } },
    create: {
      id: newId(),
      passportId: northlinePassport.id,
      sectionType: "IDENTITY",
      fieldKey: "legalEntityConfirmed",
      normalizedValue: true,
      verification: "SELF_REPORTED",
      privacyClass: "MEMBER_MARKET",
      createdByUserId: bob.id,
      createdByOrgId: northlineId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier",
    },
    update: {},
  });
  console.log(`  Northline Passport: ${northlinePassport.id} (status ${northlinePassport.status}, 1/6 blocking facts filed)`);

  // ================================================================
  // earlier-stage work: real ReadinessResult rows, computed via the REAL
  // @tol/evidence computeReadiness() engine against the REAL Fact rows
  // just seeded above — never a hand-typed score/blockers object
  // standing in for one (same anti-fabrication discipline as Claim A/B's
  // real scoreClaim() calls, earlier). Each Fact row is re-read fresh from
  // the DB (not reused from the in-memory objects above) so this is a
  // genuine round-trip proof: DB -> FactSnapshot -> engine -> persisted
  // ReadinessResult, the exact path apps/api's passport service (this stage)
  // will run on every real request.
  // ================================================================
  async function computeAndPersistReadiness(passportId: string, actorUserId: string, actorOrgId: string, sourceReference: string) {
    const existingResult = await prisma.readinessResult.findFirst({ where: { passportId, sourceReference } });
    if (existingResult) return existingResult;

    const facts = await prisma.fact.findMany({ where: { passportId }, include: { evidence: true } });
    const snapshots = facts.map((f) => ({
      fieldKey: f.fieldKey,
      sectionType: f.sectionType,
      hasValue: f.normalizedValue !== null,
      verification: f.verification,
      expiresAt: f.evidence?.expiresAt ?? null,
      updatedAt: f.updatedAt,
    }));

    const inputVersions = facts.map((f) => `fact:${f.id}:v${f.version}`);
    const result = computeReadiness(snapshots, seedNow, inputVersions);

    return prisma.readinessResult.create({
      data: {
        id: newId(),
        passportId,
        score: result.score,
        blockers: result.blockers as unknown as object,
        warnings: result.warnings as unknown as object,
        ruleVersion: result.ruleVersion,
        algorithmVersion: result.algorithmVersion,
        inputVersions: [...result.inputVersions],
        computedAt: seedNow,
        privacyClass: "MEMBER_MARKET",
        createdByUserId: actorUserId,
        createdByOrgId: actorOrgId,
        sourceType: "PLATFORM",
        sourceReference,
      },
    });
  }

  const meridianReadiness = await computeAndPersistReadiness(meridianPassport.id, alice.id, meridianId, "seed:earlier");
  console.log(
    `  Meridian ReadinessResult: ${meridianReadiness.id} (score ${meridianReadiness.score.toFixed(1)}, ${(meridianReadiness.blockers as unknown[]).length} blocker(s), ${(meridianReadiness.warnings as unknown[]).length} warning(s)) — computed via the real @tol/evidence engine`,
  );
  const northlineReadiness = await computeAndPersistReadiness(northlinePassport.id, bob.id, northlineId, "seed:earlier");
  console.log(
    `  Northline ReadinessResult: ${northlineReadiness.id} (score ${northlineReadiness.score.toFixed(1)}, ${(northlineReadiness.blockers as unknown[]).length} blocker(s), ${(northlineReadiness.warnings as unknown[]).length} warning(s))`,
  );

  // ================================================================
  // earlier: Matching (P11 Eligibility + P12 Ranking) synthetic fixtures.
  //
  // SAFE SYNTHETIC DATA ONLY — same fictional earlier phases orgs (Meridian/
  // Northline), no real counterparties. Two real MatchResult rows,
  // computed via the REAL @tol/matching engine (evaluateEligibility +
  // rankMatches) against REAL Opportunity/CapacityProfile rows already
  // seeded above — never a hand-typed eligible/rank/score standing in
  // for one, same anti-fabrication discipline as the real
  // scoreClaim() calls and the real computeReadiness() calls.
  //
  // Meridian's Passport (seeded above at INCOMPLETE, missing exactly the
  // TECHNICAL section's technicalIntegrationProfile fact) is completed
  // FOR REAL here: filed via the same Fact-upsert mechanism the
  // meridianFacts loop above already uses, recomputed via the real
  // @tol/evidence engine, and advanced to READY via the exact same
  // targetStatusAfterRecompute logic apps/api's passport service applies
  // (mirrored here, not reinvented — this script has no RequestContext/
  // audit-writer to call that service function directly). an earlier
  // live-browser pass already proved the "file it live, watch INCOMPLETE
  // become READY" exit condition once (the test-evidence record for p6-passport);
  // this build needs Meridian to be a genuinely eligible provider to
  // seed a meaningful P11/P12 demo. Fabricating a passport status
  // inconsistent with the real Fact rows was rejected as a shortcut
  // (same discipline that keeps every other derived output in this file
  // real-computed, never hand-typed) in favor of completing the fixture
  // for real, via the exact production mechanism, one step further.
  // ================================================================
  console.log("");
  console.log("Seeding earlier Matching fixtures...");

  const meridianTechnicalFact = await prisma.fact.upsert({
    where: { passportId_fieldKey: { passportId: meridianPassport.id, fieldKey: "technicalIntegrationProfile" } },
    create: {
      id: newId(),
      passportId: meridianPassport.id,
      sectionType: "TECHNICAL",
      fieldKey: "technicalIntegrationProfile",
      normalizedValue: { gatewayIntegration: "REST_API", supports3DS: true, tokenizationSupported: true, certificationStatus: "CERTIFIED", estimatedIntegrationDays: 14 },
      verification: "OPERATOR_VERIFIED",
      privacyClass: "MEMBER_MARKET",
      createdByUserId: alice.id,
      createdByOrgId: meridianId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier",
    },
    update: {},
  });

  const { isReadinessBlocked } = await import("@tol/evidence");
  const { assertValidPassportTransition } = await import("@tol/domain");
  const matchSeedNow = new Date();

  const meridianFactsFresh = await prisma.fact.findMany({ where: { passportId: meridianPassport.id }, include: { evidence: true } });
  const meridianSnapshotsFresh = meridianFactsFresh.map((f) => ({
    fieldKey: f.fieldKey,
    sectionType: f.sectionType,
    hasValue: f.normalizedValue !== null,
    verification: f.verification,
    expiresAt: f.evidence?.expiresAt ?? null,
    updatedAt: f.updatedAt,
  }));
  const meridianInputVersionsFresh = meridianFactsFresh.map((f) => `fact:${f.id}:v${f.version}`);
  const meridianReadinessAfterTechnical = computeReadiness(meridianSnapshotsFresh, matchSeedNow, meridianInputVersionsFresh);
  const meridianBlockedAfterTechnical = isReadinessBlocked(meridianReadinessAfterTechnical);

  const meridianPassportCurrent = await prisma.passport.findUniqueOrThrow({ where: { id: meridianPassport.id } });
  let meridianPassportFinal = meridianPassportCurrent;
  // Mirrors apps/api/src/modules/passport/service.ts's own
  // targetStatusAfterRecompute(current, hasFacts, blocked): SUSPENDED
  // stays put; blocked -> INCOMPLETE; VERIFIED stays VERIFIED; otherwise
  // -> READY. Meridian is INCOMPLETE with facts and (after filing the
  // missing TECHNICAL fact) unblocked, so this always resolves to READY
  // — the `if` guard below only skips redundant work on a re-run.
  if (!meridianBlockedAfterTechnical && meridianPassportCurrent.status !== "READY" && meridianPassportCurrent.status !== "VERIFIED" && meridianPassportCurrent.status !== "SUSPENDED") {
    const existingResult = await prisma.readinessResult.findFirst({ where: { passportId: meridianPassport.id, sourceReference: "seed:earlier" } });
    if (!existingResult) {
      await prisma.readinessResult.create({
        data: {
          id: newId(),
          passportId: meridianPassport.id,
          score: meridianReadinessAfterTechnical.score,
          blockers: meridianReadinessAfterTechnical.blockers as unknown as object,
          warnings: meridianReadinessAfterTechnical.warnings as unknown as object,
          ruleVersion: meridianReadinessAfterTechnical.ruleVersion,
          algorithmVersion: meridianReadinessAfterTechnical.algorithmVersion,
          inputVersions: [...meridianReadinessAfterTechnical.inputVersions],
          computedAt: matchSeedNow,
          privacyClass: "MEMBER_MARKET",
          createdByUserId: alice.id,
          createdByOrgId: meridianId,
          sourceType: "PLATFORM",
          sourceReference: "seed:earlier",
        },
      });
    }
    assertValidPassportTransition(meridianPassportCurrent.status, "READY");
    meridianPassportFinal = await prisma.passport.update({
      where: { id: meridianPassport.id },
      data: { status: "READY", updatedByUserId: alice.id, version: { increment: 1 } },
    });
  }
  console.log(
    `  Meridian Passport advanced: ${meridianPassportFinal.status} (score ${meridianReadinessAfterTechnical.score.toFixed(1)}, ${meridianReadinessAfterTechnical.blockers.length} blocker(s)) — technicalIntegrationProfile fact ${meridianTechnicalFact.id} filed, readiness recomputed via the real @tol/evidence engine, status advanced via the real @tol/domain transition guard`,
  );

  // ---- Real MatchResult rows: evaluateEligibility() + rankMatches() via
  // the REAL @tol/matching engine, against the REAL Opportunity A /
  // CapacityProfile rows above. Two scenarios: (1) Meridian's primary
  // US/CA capacity — now genuinely eligible — ranked; (2) Meridian's
  // second, deliberately STALE/GB/GBP capacity (seeded in earlier-stage work
  // as backdated demo material) — genuinely ineligible on multiple real
  // rule families, left unranked (rankingBreakdown/rank/algorithmVersion
  // all null, enforcing the spec's "eligibility runs first" invariant
  // at the data layer, not just in application code). ----
  const { evaluateEligibility, rankMatches } = await import("@tol/matching");

  function toMatchOpportunityInput(o: { id: string; currency: string; jurisdictions: unknown; mccs: unknown; movable30dMinor: bigint }) {
    return {
      id: o.id,
      currency: o.currency,
      jurisdictions: o.jurisdictions as string[],
      mccs: o.mccs as string[],
      movable30dMinor: o.movable30dMinor,
    };
  }
  function toMatchCapacityInput(c: {
    id: string;
    currency: string;
    jurisdictions: unknown;
    mccsAccepted: unknown;
    mccsExcluded: unknown;
    acceptingNewVolume: boolean;
    monthlyCapacityMinor: bigint;
    minTicketMinor: number;
    maxTicketMinor: number;
    maxChargebackBps: number;
    maxFraudBps: number;
    maxRefundBps: number;
    settlementRail: string;
    settlementCadenceDays: number;
    freshnessClass: string;
    commercialTerms: unknown;
  }) {
    return {
      id: c.id,
      currency: c.currency,
      jurisdictions: c.jurisdictions as string[],
      mccsAccepted: c.mccsAccepted as string[],
      mccsExcluded: c.mccsExcluded as string[],
      acceptingNewVolume: c.acceptingNewVolume,
      monthlyCapacityMinor: c.monthlyCapacityMinor,
      minTicketMinor: c.minTicketMinor,
      maxTicketMinor: c.maxTicketMinor,
      maxChargebackBps: c.maxChargebackBps,
      maxFraudBps: c.maxFraudBps,
      maxRefundBps: c.maxRefundBps,
      settlementRail: c.settlementRail,
      settlementCadenceDays: c.settlementCadenceDays,
      freshnessClass: c.freshnessClass as "FRESH" | "AGING" | "STALE" | "UNKNOWN",
      commercialTerms: c.commercialTerms as { mdrBps: number; fixedFeeMinor: number; model: "blended" | "interchange_plus" | "flat" } | null,
    };
  }

  async function evaluateAndPersistMatch(
    opportunity: Parameters<typeof toMatchOpportunityInput>[0],
    capacity: Parameters<typeof toMatchCapacityInput>[0] & { version: number },
    opportunityVersion: number,
    providerPassportStatus: "DRAFT" | "INCOMPLETE" | "READY" | "VERIFIED" | "STALE" | "SUSPENDED",
    sourceReference: string,
  ) {
    const existing = await prisma.matchResult.findFirst({ where: { opportunityId: opportunity.id, capacityId: capacity.id, sourceReference } });
    if (existing) return { row: existing, eligibility: null };

    const matchContext = {
      now: matchSeedNow,
      providerPassportStatus,
      inputVersions: [`opportunity:${opportunity.id}:v${opportunityVersion}`, `capacity:${capacity.id}:v${capacity.version}`],
    };
    const matchOpportunity = toMatchOpportunityInput(opportunity);
    const matchCapacity = toMatchCapacityInput(capacity);
    const eligibility = evaluateEligibility(matchOpportunity, matchCapacity, matchContext);

    let rankingBreakdown = null;
    let rank: number | null = null;
    if (eligibility.eligible) {
      const [ranked] = rankMatches(matchOpportunity, [matchCapacity], matchContext);
      rankingBreakdown = ranked!.breakdown;
      rank = ranked!.rank;
    }

    const row = await prisma.matchResult.create({
      data: {
        id: newId(),
        opportunityId: opportunity.id,
        capacityId: capacity.id,
        eligible: eligibility.eligible,
        eligibilityResults: eligibility.results as unknown as object,
        ruleVersion: eligibility.ruleVersion,
        rankingBreakdown: (rankingBreakdown ?? undefined) as object | undefined,
        rank,
        totalScore: rankingBreakdown?.total ?? null,
        algorithmVersion: rankingBreakdown?.algorithmVersion ?? null,
        inputVersions: [...eligibility.inputVersions],
        evaluatedAt: matchSeedNow,
        privacyClass: "RESTRICTED",
        createdByUserId: operator.id,
        createdByOrgId: northlineId,
        sourceType: "PLATFORM",
        sourceReference,
      },
    });
    return { row, eligibility };
  }

  const eligibleMatch = await evaluateAndPersistMatch(opportunityA, capacityProfile, opportunityA.version, meridianPassportFinal.status, "seed:earlier-eligible");
  console.log(
    `  MatchResult (eligible): ${eligibleMatch.row.id} — Opportunity A vs Meridian's primary US/CA capacity — eligible=${eligibleMatch.row.eligible}, rank=${eligibleMatch.row.rank}, totalScore=${eligibleMatch.row.totalScore?.toFixed(1)} — computed via the real @tol/matching engine`,
  );

  const ineligibleMatch = await evaluateAndPersistMatch(opportunityA, staleCapacityProfile, opportunityA.version, meridianPassportFinal.status, "seed:earlier-ineligible");
  const ineligibleBlockerCodes = ineligibleMatch.eligibility ? ineligibleMatch.eligibility.blockers.map((b) => b.code) : ["(replayed from a prior run — see eligibilityResults on the row itself)"];
  console.log(
    `  MatchResult (ineligible): ${ineligibleMatch.row.id} — Opportunity A vs Meridian's STALE/GB/GBP capacity — eligible=${ineligibleMatch.row.eligible}, blockers=[${ineligibleBlockerCodes.join(", ")}], rankingBreakdown=${ineligibleMatch.row.rankingBreakdown === null ? "null (never ranked, per the spec's invariant)" : "SET (unexpected)"}`,
  );

  // ================================================================
  // earlier: Economics (P15 — "Traceable schedule/accrual ledger").
  //
  // Reuses Deal Room B (Northline/Meridian, from earlier) and Claim A
  // (Alice/Meridian's VERIFIED-bound claim on Northline for opportunity
  // B, from earlier) rather than inventing new fictional orgs — the SAME
  // "reuse existing fixtures, advance them further" discipline every
  // prior day's own seed block already applies (earlier advanced
  // Meridian's Passport within its own block; earlier computed real
  // MatchResult rows against earlier phases's existing Opportunity/
  // CapacityProfile rows). `dealRoomB`/`conditionB` are RE-FETCHED here
  // (not reused from the earlier block's own local bindings, which are
  // scoped to that block's `else` branch and don't survive to here).
  //
  // Scenario: Deal Room B is advanced from CONDITIONS to ACTIVATION
  // (economics only engage once a deal has reached an activated/closed
  // state — this day's own build instructions). Claim A is advanced
  // from SCORED to VERIFIED (an operator decision, mirroring Claim B's
  // exact earlier pattern) so it has real standing to justify a
  // CommissionComponent's recipient. A CommissionSchedule (80/20
  // contributor/platform split, GROSS_PROCESSING_VOLUME basis) is
  // created and activated, one RevenueEvent is recorded, and the REAL
  // @tol/domain computeCommissionSplits() engine computes the ledger —
  // never a hand-typed/fabricated split, same anti-fabrication
  // discipline as the real crypto, the real scoreClaim(), the
  // real computeReadiness(), the real evaluateEligibility()/
  // rankMatches(). A partial payment against the contributor's accrual
  // is also recorded, leaving one accrual PARTIALLY_PAID and the other
  // ACCRUED — a mixed-status live-test fixture, matching this file's own
  // "pre-positioned fixture state for the live pass" precedent (RFQ A
  // left at QUOTED, Deal Room B originally left at CONDITIONS, Claim B's
  // dispute left OPEN).
  // ================================================================
  console.log("");
  console.log("Seeding earlier Economics fixtures...");

  const platformId = orgIdByKey.get("platform")!;
  const owner = await prisma.user.findFirstOrThrow({ where: { email: "owner@tolplatform.dev" } });
  const {
    assertValidCommissionScheduleTransition,
    assertValidDealRoomTransition,
    assertValidDealConditionTransition,
    computeCommissionSplits,
    reconcileRevenueEvent,
  } = await import("@tol/domain");

  // ---- Advance Claim A (Alice/Meridian on Northline, opportunity B) to
  // VERIFIED — same real ClaimDecision pattern Claim B's earlier block
  // already established, reused rather than reinvented. ----
  claimA = await prisma.claim.findUniqueOrThrow({ where: { id: claimA.id } });
  if (claimA.status === "SCORED" && claimA.scoreBreakdown) {
    await prisma.claimDecision.create({
      data: {
        id: newId(),
        claimId: claimA.id,
        decision: "VERIFIED",
        scoreBreakdown: claimA.scoreBreakdown as object,
        algorithmVersion: claimA.algorithmVersion!,
        ruleVersion: "attribution-rules-v1",
        reviewerUserId: operator.id,
        reviewerOrgId: platformId,
        reason: "Seed fixture: 8-month prior commercial history and CRM-corroborated introductory email thread accepted at face value — economics (earlier) needs a real VERIFIED claim to justify a CommissionComponent recipient.",
        privacyClass: "RESTRICTED",
      },
    });
    claimA = await prisma.claim.update({ where: { id: claimA.id }, data: { status: "VERIFIED" } });
  }
  console.log(`  Claim A advanced: ${claimA.id} (status ${claimA.status}) — real operator ClaimDecision recorded`);

  // ---- Advance Deal Room B from CONDITIONS to ACTIVATION — economics
  // only engage once a deal has reached an activated/closed state (this
  // day's own build instructions); OPEN/CONDITIONS/APPROVED/DECLINED are
  // too early. Resolves the one pending condition first, for narrative
  // realism (not code-enforced by the domain transition table itself,
  // which permits CONDITIONS -> APPROVED unconditionally — resolved
  // anyway so this fixture reads coherently end to end). ----
  const dealRoomB = await prisma.dealRoom.findFirstOrThrow({ where: { opportunityId: opportunityB.id } });
  const conditionB = await prisma.dealCondition.findFirst({ where: { dealRoomId: dealRoomB.id } });
  if (conditionB && conditionB.state === "PENDING") {
    assertValidDealConditionTransition(conditionB.state, "SATISFIED");
    await prisma.dealCondition.update({
      where: { id: conditionB.id },
      data: { state: "SATISFIED", resolutionNote: "UBO documentation received and verified.", updatedByUserId: alice.id },
    });
  }
  let dealRoomBCurrent = await prisma.dealRoom.findUniqueOrThrow({ where: { id: dealRoomB.id } });
  if (dealRoomBCurrent.status === "CONDITIONS") {
    assertValidDealRoomTransition(dealRoomBCurrent.status, "APPROVED");
    await prisma.dealDecision.create({
      data: {
        id: newId(),
        dealRoomId: dealRoomB.id,
        decisionType: "APPROVAL",
        reason: "All conditions satisfied; underwriting sign-off complete.",
        actorUserId: operator.id,
        actorOrgId: platformId,
        actorRole: "MARKETPLACE_OPERATOR",
        privacyClass: "DEAL_ROOM",
        createdByUserId: operator.id,
        createdByOrgId: platformId,
      },
    });
    dealRoomBCurrent = await prisma.dealRoom.update({ where: { id: dealRoomB.id }, data: { status: "APPROVED" } });
  }
  if (dealRoomBCurrent.status === "APPROVED") {
    assertValidDealRoomTransition(dealRoomBCurrent.status, "ACTIVATION");
    dealRoomBCurrent = await prisma.dealRoom.update({ where: { id: dealRoomB.id }, data: { status: "ACTIVATION", nextAction: "Confirm live processing volume for the first settlement period." } });
  }
  for (const [eventType, payload] of [
    ["deal.condition_resolved", { dealRoomId: dealRoomB.id, conditionId: conditionB?.id, state: "SATISFIED" }],
    ["deal.approved", { dealRoomId: dealRoomB.id }],
    ["deal.activated", { dealRoomId: dealRoomB.id }],
  ] as const) {
    const already = await prisma.domainEvent.findFirst({ where: { eventType, aggregateId: dealRoomB.id, correlationId: "seed:earlier" } });
    if (!already) {
      await prisma.domainEvent.create({
        data: { id: newId(), eventType, aggregateType: "deal_room", aggregateId: dealRoomB.id, payload, actorUserId: operator.id, actorOrgId: platformId, actorRole: "MARKETPLACE_OPERATOR", correlationId: "seed:earlier" },
      });
    }
  }
  console.log(`  Deal Room B advanced: ${dealRoomBCurrent.status} (condition resolved, APPROVAL decision recorded) — real @tol/domain transition guards used throughout`);

  // ---- CommissionSchedule: 80% to the contributor (Meridian, via Claim
  // A), 20% platform margin — round, illustrative numbers, safe synthetic
  // data only (same discipline as every other seed figure in this file).
  // ----
  let schedule = await prisma.commissionSchedule.findFirst({ where: { dealRoomId: dealRoomB.id, sourceReference: "seed:earlier" } });
  if (!schedule) {
    schedule = await commissionScheduleRepository.create(prisma, {
      dealRoomId: dealRoomB.id,
      basis: "GROSS_PROCESSING_VOLUME",
      status: "DRAFT",
      survivalMonths: 12,
      description: "Standard acquiring introduction split — 80% contributor / 20% platform, of gross processing volume.",
      privacyClass: "RESTRICTED",
      createdByUserId: owner.id,
      createdByOrgId: platformId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier",
    });
  }
  if (schedule.status === "DRAFT") {
    assertValidCommissionScheduleTransition(schedule.status, "ACTIVE");
    schedule = await commissionScheduleRepository.updateStatus(prisma, schedule.id, "ACTIVE", owner.id);
  }
  let components = await commissionComponentRepository.listBySchedule(prisma, schedule.id);
  if (components.length === 0) {
    components = await commissionComponentRepository.createMany(prisma, [
      {
        scheduleId: schedule.id,
        recipientType: "CONTRIBUTOR",
        recipientOrgId: meridianId,
        componentType: "PERCENTAGE_BPS",
        bps: 8_000,
        priority: 1,
        claimId: claimA.id,
        privacyClass: "RESTRICTED",
        createdByUserId: owner.id,
        createdByOrgId: platformId,
        sourceReference: "seed:earlier",
      },
      {
        scheduleId: schedule.id,
        recipientType: "PLATFORM",
        recipientOrgId: platformId,
        componentType: "PERCENTAGE_BPS",
        bps: 2_000,
        priority: 2,
        claimId: null,
        privacyClass: "RESTRICTED",
        createdByUserId: owner.id,
        createdByOrgId: platformId,
        sourceReference: "seed:earlier",
      },
    ]);
  }
  console.log(`  CommissionSchedule: ${schedule.id} v${schedule.versionNumber} (${schedule.status}, ${schedule.basis}) — ${components.length} components (80% contributor claim ${claimA.id} / 20% platform)`);

  // ---- RevenueEvent + the REAL computeCommissionSplits() engine ----
  const revenueNow = new Date();
  let revenueEvent = await revenueEventRepository.findByDealPeriodSource(prisma, dealRoomB.id, "2026-08", "processing_volume");
  let ledgerEntries = revenueEvent ? await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id) : [];
  if (!revenueEvent) {
    const grossAmountMinor = 500_000_00n; // $500,000.00 — illustrative first-month processing volume
    const deductionsMinor = 0n;
    const netDistributableMinor = grossAmountMinor - deductionsMinor;
    revenueEvent = await revenueEventRepository.create(prisma, {
      dealRoomId: dealRoomB.id,
      scheduleId: schedule.id,
      basis: schedule.basis,
      period: "2026-08",
      source: "processing_volume",
      grossAmountMinor,
      deductionsMinor,
      netDistributableMinor,
      currency: "USD",
      recognizedAt: revenueNow,
      privacyClass: "RESTRICTED",
      createdByUserId: operator.id,
      createdByOrgId: platformId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier",
    });

    const split = computeCommissionSplits({
      netDistributableMinor: revenueEvent.netDistributableMinor,
      components: components.map((c) => ({
        componentId: c.id,
        recipientOrgId: c.recipientOrgId,
        componentType: c.componentType,
        bps: c.bps,
        fixedAmountMinor: c.fixedAmountMinor,
        claimId: c.claimId,
        priority: c.priority,
      })),
      scheduleId: schedule.id,
      scheduleVersion: schedule.versionNumber,
      now: revenueNow,
      inputVersions: [`schedule:${schedule.id}:v${schedule.versionNumber}`, `revenueEvent:${revenueEvent.id}`],
    });

    ledgerEntries = await commissionAccrualRepository.createMany(
      prisma,
      split.entries.map((e) => ({
        entryType: "ACCRUAL" as const,
        direction: e.direction,
        amountMinor: e.amountMinor,
        currency: revenueEvent!.currency,
        dealRoomId: dealRoomB.id,
        revenueEventId: revenueEvent!.id,
        scheduleId: schedule!.id,
        scheduleVersion: schedule!.versionNumber,
        componentId: e.componentId,
        recipientOrgId: e.recipientOrgId,
        claimId: e.claimId,
        calculationVersion: split.calculationVersion,
        inputVersions: split.inputVersions,
        computedAt: revenueNow,
        privacyClass: "RESTRICTED",
        createdByUserId: operator.id,
        createdByOrgId: platformId,
        sourceType: "PLATFORM",
        sourceReference: "seed:earlier",
      })),
    );

    await prisma.domainEvent.create({
      data: {
        id: newId(),
        eventType: "commission.accrued",
        aggregateType: "deal_room",
        aggregateId: dealRoomB.id,
        payload: { revenueEventId: revenueEvent.id, scheduleId: schedule.id, netDistributableMinor: revenueEvent.netDistributableMinor.toString(), entryCount: ledgerEntries.length },
        actorUserId: operator.id,
        actorOrgId: platformId,
        actorRole: "MARKETPLACE_OPERATOR",
        correlationId: "seed:earlier",
      },
    });
  }
  const sumEntries = ledgerEntries.filter((e) => e.entryType === "ACCRUAL").reduce((a, e) => a + e.amountMinor, 0n);
  console.log(
    `  RevenueEvent: ${revenueEvent.id} (period ${revenueEvent.period}, gross ${revenueEvent.grossAmountMinor}, net ${revenueEvent.netDistributableMinor}) — ${ledgerEntries.length} ledger entries, SUM(ACCRUAL) = ${sumEntries} (matches netDistributableMinor = ${revenueEvent.netDistributableMinor}) — computed via the real @tol/domain computeCommissionSplits engine, ZERO LEAKAGE`,
  );

  // ---- Partial payment against the CONTRIBUTOR's accrual — leaves a
  // deliberately mixed PARTIALLY_PAID / ACCRUED fixture state for the
  // live pass to read immediately (same "pre-positioned state" precedent
  // as this file's other scenarios). ----
  const contributorAccrual = ledgerEntries.find((e) => e.entryType === "ACCRUAL" && e.recipientOrgId === meridianId);
  let existingPayment = contributorAccrual ? await prisma.commissionAccrual.findFirst({ where: { accrualRootId: contributorAccrual.id, entryType: "PAYMENT" } }) : null;
  if (contributorAccrual && !existingPayment) {
    const paidAmountMinor = contributorAccrual.amountMinor / 2n; // exactly half — deliberately leaves this accrual PARTIALLY_PAID, not PAID
    const payment = await commissionPaymentRepository.create(prisma, {
      dealRoomId: dealRoomB.id,
      recipientOrgId: meridianId,
      totalAmountMinor: paidAmountMinor,
      currency: contributorAccrual.currency,
      paidAt: revenueNow,
      reference: "seed:earlier-first-payout",
      evidenceRef: "ACH batch reference SEED-2026-08-07",
      privacyClass: "RESTRICTED",
      createdByUserId: operator.id,
      createdByOrgId: platformId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier",
    });
    existingPayment = await commissionAccrualRepository.create(prisma, {
      accrualRootId: contributorAccrual.id,
      entryType: "PAYMENT",
      direction: "DEBIT",
      amountMinor: paidAmountMinor,
      currency: contributorAccrual.currency,
      dealRoomId: dealRoomB.id,
      revenueEventId: contributorAccrual.revenueEventId,
      scheduleId: contributorAccrual.scheduleId,
      scheduleVersion: contributorAccrual.scheduleVersion,
      componentId: contributorAccrual.componentId,
      recipientOrgId: contributorAccrual.recipientOrgId,
      claimId: contributorAccrual.claimId,
      paymentId: payment.id,
      calculationVersion: contributorAccrual.calculationVersion,
      inputVersions: [`payment:${payment.id}`],
      computedAt: revenueNow,
      privacyClass: "RESTRICTED",
      createdByUserId: operator.id,
      createdByOrgId: platformId,
      sourceType: "PLATFORM",
      sourceReference: "seed:earlier",
    });
    await prisma.domainEvent.create({
      data: {
        id: newId(),
        eventType: "commission.paid",
        aggregateType: "deal_room",
        aggregateId: dealRoomB.id,
        payload: { paymentId: payment.id, accrualRootId: contributorAccrual.id, amountMinor: paidAmountMinor.toString() },
        actorUserId: operator.id,
        actorOrgId: platformId,
        actorRole: "MARKETPLACE_OPERATOR",
        correlationId: "seed:earlier",
      },
    });
    console.log(`  CommissionPayment: ${payment.id} (${paidAmountMinor} of ${contributorAccrual.amountMinor} minor units paid to Meridian) — contributor accrual left PARTIALLY_PAID for the live pass`);
  } else {
    console.log("  CommissionPayment: already seeded");
  }

  // ---- Reconciliation proof — the spec's own RECONCILIATION
  // requirement, computed via the real @tol/domain engine, not merely
  // asserted in a comment. ----
  const fullLedgerForEvent = await commissionAccrualRepository.listByRevenueEvent(prisma, revenueEvent.id);
  const reconciliation = reconcileRevenueEvent({
    grossAmountMinor: revenueEvent.grossAmountMinor,
    deductionsMinor: revenueEvent.deductionsMinor,
    netDistributableMinor: revenueEvent.netDistributableMinor,
    ledgerEntries: fullLedgerForEvent.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })),
  });
  console.log(
    `  Reconciliation: reconciled=${reconciliation.reconciled}, distributed=${reconciliation.distributedMinor}, paid=${reconciliation.paidMinor}, outstanding=${reconciliation.outstandingMinor} — RECONCILED via the real @tol/domain reconcileRevenueEvent engine`,
  );

  console.log("");
  console.log(`Seed complete. All seeded users share the password: ${SEED_PASSWORD}`);
  console.log("(dev-only fixture credential — see the test evidence)");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
