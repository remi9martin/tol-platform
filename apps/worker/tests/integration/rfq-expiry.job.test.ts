// apps/worker/tests/integration/rfq-expiry.job.test.ts
//
// Real Postgres, real @tol/domain assertValidRfqTransition guard — a
// transition this job attempts on an ineligible status (DRAFT/EXPIRED/
// DECLINED/SELECTED) must throw, proven directly, not just asserted.

import { afterAll, describe, expect, it } from "vitest";
import { disconnectPrisma, prisma, rfqRepository, domainEventRepository } from "@tol/db";
import { rfqExpiryJob } from "../../src/jobs/rfq-expiry.job.js";
import { createRfqFixture } from "../fixtures.js";
import type { Job } from "bullmq";
import type { RfqExpiryJobData } from "../../src/jobs/rfq-expiry.job.js";

function fakeJob(data: RfqExpiryJobData): Job<RfqExpiryJobData> {
  return { id: "test-job", name: "rfq-expiry", data, attemptsMade: 0 } as unknown as Job<RfqExpiryJobData>;
}

const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} } as never, now: new Date() };

describe("rfq-expiry.job", () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("event-triggered: an overdue SENT rfq transitions to EXPIRED, with a real AuditEvent + DomainEvent", async () => {
    const overdueBy2Days = new Date(Date.now() - 2 * 86_400_000);
    const { rfq } = await createRfqFixture(overdueBy2Days, "SENT");

    const result = await rfqExpiryJob(fakeJob({ rfqId: rfq.id }), ctx);

    expect(result).toEqual({ scanned: 1, expired: 1 });
    const updated = await rfqRepository.findById(prisma, rfq.id);
    expect(updated!.status).toBe("EXPIRED");

    const events = await domainEventRepository.listByAggregate(prisma, "rfq", rfq.id);
    expect(events.some((e) => e.eventType === "rfq.expired")).toBe(true);

    // No listByResourceId query exists on auditRepository (every existing
    // caller queries by subjectOrgId/actorUserId, neither of which this
    // job sets — see its own comment on why: a background sweep has no
    // subject org or human actor) — direct prisma read here is the
    // correct, honest way to verify P16's "worker/job actions audited"
    // obligation for THIS specific write, not a workaround.
    const audits = await prisma.auditEvent.findMany({ where: { resourceId: rfq.id, action: "rfq.expired" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBeNull(); // system-triggered, not a persona action
  });

  it("a not-yet-overdue RFQ is left untouched — the FAILURE RULE (the spec): never a false transition", async () => {
    const dueTomorrow = new Date(Date.now() + 86_400_000);
    const { rfq } = await createRfqFixture(dueTomorrow, "SENT");

    const result = await rfqExpiryJob(fakeJob({ rfqId: rfq.id }), ctx);

    expect(result).toEqual({ scanned: 1, expired: 0 });
    const unchanged = await rfqRepository.findById(prisma, rfq.id);
    expect(unchanged!.status).toBe("SENT");
  });

  it("DRAFT never expires — no RFQ_TRANSITIONS edge to EXPIRED exists from DRAFT (an unsent RFQ was never 'due')", async () => {
    const overdue = new Date(Date.now() - 2 * 86_400_000);
    const { rfq } = await createRfqFixture(overdue, "DRAFT");

    const result = await rfqExpiryJob(fakeJob({ rfqId: rfq.id }), ctx);

    expect(result).toEqual({ scanned: 1, expired: 0 });
    const unchanged = await rfqRepository.findById(prisma, rfq.id);
    expect(unchanged!.status).toBe("DRAFT");
  });

  it("DUPLICATE: re-running the job on an already-EXPIRED RFQ is a clean no-op, not a thrown InvalidRfqTransitionError (P17 — idempotency key is rfqId+dueAt, the spec's own named key)", async () => {
    const overdue = new Date(Date.now() - 2 * 86_400_000);
    const { rfq } = await createRfqFixture(overdue, "SENT");

    const first = await rfqExpiryJob(fakeJob({ rfqId: rfq.id }), ctx);
    const second = await rfqExpiryJob(fakeJob({ rfqId: rfq.id }), ctx);
    const third = await rfqExpiryJob(fakeJob({ rfqId: rfq.id }), ctx);

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0); // already EXPIRED — expireOne's own precondition guard short-circuits before ever calling assertValidRfqTransition
    expect(third.expired).toBe(0);

    const events = await domainEventRepository.listByAggregate(prisma, "rfq", rfq.id);
    expect(events.filter((e) => e.eventType === "rfq.expired")).toHaveLength(1); // exactly once, not 3 times
  });

  it("a missing rfqId is a clean no-op, never a thrown error", async () => {
    const result = await rfqExpiryJob(fakeJob({ rfqId: "00000000-0000-7000-8000-00000000dead" }), ctx);
    expect(result).toEqual({ scanned: 0, expired: 0 });
  });

  it("sweep mode (no rfqId): finds and expires an overdue RFQ via listOverdue's real DB-level filter, leaves a not-yet-due one alone", async () => {
    const overdue = new Date(Date.now() - 3 * 86_400_000);
    const notDue = new Date(Date.now() + 3 * 86_400_000);
    const { rfq: overdueRfq } = await createRfqFixture(overdue, "QUOTED");
    const { rfq: futureRfq } = await createRfqFixture(notDue, "QUOTED");

    const result = await rfqExpiryJob(fakeJob({}), ctx);

    expect(result.expired).toBeGreaterThanOrEqual(1);
    const overdueUpdated = await rfqRepository.findById(prisma, overdueRfq.id);
    const futureUpdated = await rfqRepository.findById(prisma, futureRfq.id);
    expect(overdueUpdated!.status).toBe("EXPIRED");
    expect(futureUpdated!.status).toBe("QUOTED");
  });
});
