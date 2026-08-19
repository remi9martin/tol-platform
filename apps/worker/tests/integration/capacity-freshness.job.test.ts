// apps/worker/tests/integration/capacity-freshness.job.test.ts
//
// Real Postgres, real @tol/evidence classifyCapacityFreshness engine.

import { afterAll, describe, expect, it } from "vitest";
import { disconnectPrisma, prisma, capacityProfileRepository, domainEventRepository } from "@tol/db";
import { capacityFreshnessJob } from "../../src/jobs/capacity-freshness.job.js";
import { createCapacityProfileFixture } from "../fixtures.js";
import type { Job } from "bullmq";
import type { CapacityFreshnessJobData } from "../../src/jobs/capacity-freshness.job.js";
import { EVIDENCE_CONFIG } from "@tol/evidence";

function fakeJob(data: CapacityFreshnessJobData): Job<CapacityFreshnessJobData> {
  return { id: "test-job", name: "capacity-freshness", data, attemptsMade: 0 } as unknown as Job<CapacityFreshnessJobData>;
}

const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} } as never, now: new Date() };

describe("capacity-freshness.job", () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("event-triggered: downgrades a profile whose asOf has genuinely aged past STALE, and writes a real DomainEvent recording the transition", async () => {
    const agingWindow = EVIDENCE_CONFIG.capacityFreshnessWindowDays.aging;
    const staleAsOf = new Date(Date.now() - (agingWindow + 5) * 24 * 60 * 60 * 1000);
    const { profile } = await createCapacityProfileFixture({ asOf: staleAsOf, freshnessClass: "FRESH" }); // created with a WRONG stored value on purpose — the job's job is to correct it

    const result = await capacityFreshnessJob(fakeJob({ profileId: profile.id }), ctx);

    expect(result.scanned).toBe(1);
    expect(result.reclassified).toBe(1);

    const updated = await capacityProfileRepository.findById(prisma, profile.id);
    expect(updated!.freshnessClass).toBe("STALE");

    const events = await domainEventRepository.listByAggregate(prisma, "capacity_profile", profile.id);
    const event = events.find((e) => e.eventType === "capacity_profile.freshness_recomputed");
    expect(event).toBeDefined();
    expect((event!.payload as { previousFreshnessClass: string; newFreshnessClass: string }).previousFreshnessClass).toBe("FRESH");
    expect((event!.payload as { previousFreshnessClass: string; newFreshnessClass: string }).newFreshnessClass).toBe("STALE");
  });

  it("no-op when the stored class already matches the live-computed one — no wasted write, no spurious event", async () => {
    const { profile } = await createCapacityProfileFixture({ asOf: new Date(), freshnessClass: "FRESH" });

    const result = await capacityFreshnessJob(fakeJob({ profileId: profile.id }), ctx);

    expect(result.reclassified).toBe(0);
    const events = await domainEventRepository.listByAggregate(prisma, "capacity_profile", profile.id);
    expect(events.some((e) => e.eventType === "capacity_profile.freshness_recomputed")).toBe(false);
  });

  it("DUPLICATE: re-running the job after it already reclassified is a clean no-op on the second call (compare-before-write) — no duplicate DomainEvent", async () => {
    const agingWindow = EVIDENCE_CONFIG.capacityFreshnessWindowDays.aging;
    const staleAsOf = new Date(Date.now() - (agingWindow + 5) * 24 * 60 * 60 * 1000);
    const { profile } = await createCapacityProfileFixture({ asOf: staleAsOf, freshnessClass: "FRESH" });

    const first = await capacityFreshnessJob(fakeJob({ profileId: profile.id }), ctx);
    const second = await capacityFreshnessJob(fakeJob({ profileId: profile.id }), ctx);

    expect(first.reclassified).toBe(1);
    expect(second.reclassified).toBe(0); // already STALE by the time the duplicate runs — nothing left to change
    const events = await domainEventRepository.listByAggregate(prisma, "capacity_profile", profile.id);
    expect(events.filter((e) => e.eventType === "capacity_profile.freshness_recomputed")).toHaveLength(1);
  });

  it("a missing profileId is a clean no-op, never a thrown error", async () => {
    const result = await capacityFreshnessJob(fakeJob({ profileId: "00000000-0000-7000-8000-00000000dead" }), ctx);
    expect(result).toEqual({ scanned: 0, reclassified: 0 });
  });

  it("sweep mode (no profileId) reclassifies a stale profile among a real batch", async () => {
    const agingWindow = EVIDENCE_CONFIG.capacityFreshnessWindowDays.aging;
    const staleAsOf = new Date(Date.now() - (agingWindow + 5) * 24 * 60 * 60 * 1000);
    const { profile: stale } = await createCapacityProfileFixture({ asOf: staleAsOf, freshnessClass: "FRESH" });
    const { profile: fresh } = await createCapacityProfileFixture({ asOf: new Date(), freshnessClass: "FRESH" });

    const result = await capacityFreshnessJob(fakeJob({}), ctx);

    expect(result.scanned).toBeGreaterThanOrEqual(2);
    const staleUpdated = await capacityProfileRepository.findById(prisma, stale.id);
    const freshUpdated = await capacityProfileRepository.findById(prisma, fresh.id);
    expect(staleUpdated!.freshnessClass).toBe("STALE");
    expect(freshUpdated!.freshnessClass).toBe("FRESH");
  });
});
