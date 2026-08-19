// apps/worker/tests/fixtures.ts
//
// Direct-repository (no HTTP, no @tol/authz) fixture builders for
// apps/worker's own integration tests. Deliberately bypasses apps/api
// entirely — these tests exercise WORKER JOB logic against real
// Postgres rows via real repository calls (same "real DB, never
// fabricated" discipline every other test suite in this repo follows),
// not apps/api's own authz/HTTP layer, which is out of scope for what a
// background job test needs to prove.

import {
  prisma,
  organizationRepository,
  opportunityRepository,
  rfqRepository,
  rfqRecipientRepository,
  quoteRepository,
  dealRoomRepository,
  passportRepository,
  capacityProfileRepository,
  commissionScheduleRepository,
  commissionComponentRepository,
  revenueEventRepository,
  type Organization,
  type RFQ,
  type Passport,
  type CapacityProfile,
  type DealRoom,
  type CommissionSchedule,
  type SourceType,
} from "@tol/db";
import type { RfqStatus } from "@tol/domain";

let counter = 0;
/** Monotonic-within-process suffix — avoids name/label collisions across tests that run in the same file without relying on wall-clock precision (two fixtures created in the same millisecond would otherwise collide). */
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

export async function createOrg(label: string, entityType: Organization["entityType"] = "MERCHANT"): Promise<Organization> {
  const tag = unique(label);
  return organizationRepository.create(prisma, {
    legalName: `${tag} Legal Entity`,
    displayName: tag,
    entityType,
    country: "US",
  });
}

export async function createPassportFixture(): Promise<{ org: Organization; passport: Passport }> {
  const org = await createOrg("PassportOrg");
  const passport = await passportRepository.create(prisma, { organizationId: org.id });
  return { org, passport };
}

export async function createCapacityProfileFixture(overrides: { asOf?: Date; sourceType?: SourceType; freshnessClass?: CapacityProfile["freshnessClass"] } = {}): Promise<{ org: Organization; profile: CapacityProfile }> {
  const org = await createOrg("CapacityOrg", "ACQUIRER");
  const profile = await capacityProfileRepository.create(prisma, {
    providerOrgId: org.id,
    asOf: overrides.asOf ?? new Date(),
    freshnessClass: overrides.freshnessClass ?? "FRESH",
    currency: "USD",
    settlementRail: "ACH",
    sourceType: overrides.sourceType ?? "PLATFORM",
  });
  return { org, profile };
}

export async function createRfqFixture(dueAt: Date, status: RfqStatus = "SENT"): Promise<{ merchant: Organization; provider: Organization; rfq: RFQ }> {
  const merchant = await createOrg("RfqMerchant");
  const provider = await createOrg("RfqProvider", "ACQUIRER");
  const opportunity = await opportunityRepository.create(prisma, {
    ownerOrgId: merchant.id,
    opportunityType: "ACQUIRING",
    requestedService: "processing",
    currency: "USD",
  });
  const rfq = await rfqRepository.create(prisma, { opportunityId: opportunity.id, dueAt, status });
  await rfqRecipientRepository.create(prisma, { rfqId: rfq.id, providerOrgId: provider.id });
  return { merchant, provider, rfq };
}

/**
 * Full chain through to an ACTIVATION-status DealRoom with an ACTIVE
 * CommissionSchedule — everything economics-accrual.job.test.ts needs
 * before it can create a RevenueEvent. Mirrors apps/api/tests/integration/
 * economics.test.ts's own fixture shape (RFQ -> RFQRecipient -> Quote ->
 * DealRoom, then a direct `dealRoom.status` nudge to ACTIVATION — that
 * file's own header comment explains why: no earlier HTTP endpoint advances
 * a DealRoom past OPEN/CONDITIONS/APPROVED yet), rebuilt here via direct
 * repository calls since apps/worker cannot import apps/api's HTTP test
 * helpers across the app boundary.
 */
export async function createActivatedDealRoomFixture(): Promise<{
  merchant: Organization;
  provider: Organization;
  dealRoom: DealRoom;
}> {
  const merchant = await createOrg("DealMerchant");
  const provider = await createOrg("DealProvider", "ACQUIRER");
  const opportunity = await opportunityRepository.create(prisma, {
    ownerOrgId: merchant.id,
    opportunityType: "ACQUIRING",
    requestedService: "processing",
    currency: "USD",
  });
  const rfq = await rfqRepository.create(prisma, {
    opportunityId: opportunity.id,
    dueAt: new Date(Date.now() + 86_400_000),
    status: "SENT",
  });
  const recipient = await rfqRecipientRepository.create(prisma, { rfqId: rfq.id, providerOrgId: provider.id });
  const quote = await quoteRepository.create(prisma, {
    rfqId: rfq.id,
    rfqRecipientId: recipient.id,
    providerOrgId: provider.id,
    quoteVersion: 1,
    currency: "USD",
    validUntil: new Date(Date.now() + 7 * 86_400_000),
    terms: { rate: { bps: 250 } },
  });
  const dealRoom = await dealRoomRepository.create(prisma, {
    opportunityId: opportunity.id,
    rfqId: rfq.id,
    selectedQuoteId: quote.id,
    merchantOrgId: merchant.id,
    providerOrgId: provider.id,
  });
  // Same direct-nudge precedent as apps/api/tests/integration/economics.test.ts's
  // own header comment documents — no HTTP endpoint drives this transition yet.
  const activated = await prisma.dealRoom.update({ where: { id: dealRoom.id }, data: { status: "ACTIVATION" } });
  return { merchant, provider, dealRoom: activated };
}

export async function createActiveScheduleFixture(dealRoom: DealRoom, contributorOrgId: string, platformOrgId: string): Promise<{ schedule: CommissionSchedule; contributorComponentId: string; platformComponentId: string }> {
  const draft = await commissionScheduleRepository.create(prisma, {
    dealRoomId: dealRoom.id,
    basis: "GROSS_PROCESSING_VOLUME",
    status: "DRAFT",
  });
  const schedule = await commissionScheduleRepository.updateStatus(prisma, draft.id, "ACTIVE", null);
  const [contributor, platform] = await commissionComponentRepository.createMany(prisma, [
    { scheduleId: schedule.id, recipientType: "CONTRIBUTOR", recipientOrgId: contributorOrgId, componentType: "PERCENTAGE_BPS", bps: 8000, priority: 1 },
    { scheduleId: schedule.id, recipientType: "PLATFORM", recipientOrgId: platformOrgId, componentType: "PERCENTAGE_BPS", bps: 2000, priority: 2 },
  ]);
  return { schedule, contributorComponentId: contributor!.id, platformComponentId: platform!.id };
}

export async function createRevenueEventFixture(dealRoom: DealRoom, schedule: CommissionSchedule, grossAmountMinor: bigint, opts: { period?: string; source?: string } = {}) {
  return revenueEventRepository.create(prisma, {
    dealRoomId: dealRoom.id,
    scheduleId: schedule.id,
    basis: schedule.basis,
    period: opts.period ?? unique("period"),
    source: opts.source ?? "test-fixture",
    grossAmountMinor,
    netDistributableMinor: grossAmountMinor,
    currency: "USD",
    recognizedAt: new Date(),
  });
}
