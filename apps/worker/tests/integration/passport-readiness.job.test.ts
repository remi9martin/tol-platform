// apps/worker/tests/integration/passport-readiness.job.test.ts
//
// Real Postgres, real @tol/evidence computeReadiness engine — no
// hand-typed readiness numbers anywhere in this file's own assertions.

import { afterAll, describe, expect, it } from "vitest";
import { disconnectPrisma, prisma, readinessResultRepository, factRepository, passportRepository, domainEventRepository } from "@tol/db";
import { passportReadinessJob } from "../../src/jobs/passport-readiness.job.js";
import { createPassportFixture } from "../fixtures.js";
import type { Job } from "bullmq";
import type { PassportReadinessJobData } from "../../src/jobs/passport-readiness.job.js";

function fakeJob(data: PassportReadinessJobData): Job<PassportReadinessJobData> {
  return { id: "test-job", name: "passport-readiness", data, attemptsMade: 0 } as unknown as Job<PassportReadinessJobData>;
}

const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} } as never, now: new Date() };

describe("passport-readiness.job", () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("event-triggered: computes a REAL readiness result via @tol/evidence and persists it for a zero-fact passport", async () => {
    const { passport } = await createPassportFixture();

    const result = await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);

    expect(result.scanned).toBe(1);
    expect(result.recomputed).toBe(1);

    const latest = await readinessResultRepository.findLatestByPassport(prisma, passport.id);
    expect(latest).not.toBeNull();
    expect(latest!.score).toBeLessThan(100); // zero facts present -> not 100% of required facts
    expect(latest!.sourceType).toBe("SYSTEM"); // distinguishes a worker-triggered recompute from apps/api's own (PLATFORM default)

    const events = await domainEventRepository.listByAggregate(prisma, "passport", passport.id);
    expect(events.some((e) => e.eventType === "passport.readiness_computed")).toBe(true);
  });

  it("adding a fact then re-running the job produces a DIFFERENT readiness result — proves this isn't a cached/stub value", async () => {
    const { passport } = await createPassportFixture();
    await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);
    const before = await readinessResultRepository.findLatestByPassport(prisma, passport.id);

    await factRepository.upsertByFieldKey(prisma, {
      passportId: passport.id,
      sectionType: "IDENTITY",
      fieldKey: "legalEntityConfirmed",
      normalizedValue: true,
      verification: "SELF_REPORTED",
    });

    await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);
    const after = await readinessResultRepository.findLatestByPassport(prisma, passport.id);

    expect(after!.id).not.toBe(before!.id); // a genuinely new row, append-only
    expect(after!.inputVersions).not.toEqual(before!.inputVersions);
  });

  it("DUPLICATE: re-running the job with UNCHANGED facts replays the cached result instead of appending a redundant ReadinessResult row (P17)", async () => {
    const { passport } = await createPassportFixture();
    await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);
    const countBefore = (await readinessResultRepository.listByPassport(prisma, passport.id)).length;

    // Same passport, same (empty) fact set — a genuine duplicate delivery.
    await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);
    await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);

    const countAfter = (await readinessResultRepository.listByPassport(prisma, passport.id)).length;
    expect(countAfter).toBe(countBefore); // idempotent — no new rows from the 2 duplicate runs
  });

  it("a missing passportId (already deleted, or a stale enqueue) is a clean no-op, never a thrown error", async () => {
    const result = await passportReadinessJob(fakeJob({ passportId: "00000000-0000-7000-8000-00000000dead" }), ctx);
    expect(result).toEqual({ scanned: 0, recomputed: 0 });
  });

  it("sweep mode (no passportId): recomputes a passport with NO ReadinessResult yet, leaves an up-to-date one untouched", async () => {
    const { passport: neverComputed } = await createPassportFixture();
    const { passport: alreadyFresh } = await createPassportFixture();
    await passportReadinessJob(fakeJob({ passportId: alreadyFresh.id }), ctx); // give it a fresh, current ReadinessResult

    const beforeFreshCount = (await readinessResultRepository.listByPassport(prisma, alreadyFresh.id)).length;

    const result = await passportReadinessJob(fakeJob({}), ctx);

    expect(result.scanned).toBeGreaterThanOrEqual(2);
    const neverComputedLatest = await readinessResultRepository.findLatestByPassport(prisma, neverComputed.id);
    expect(neverComputedLatest).not.toBeNull(); // the sweep picked it up

    const afterFreshCount = (await readinessResultRepository.listByPassport(prisma, alreadyFresh.id)).length;
    expect(afterFreshCount).toBe(beforeFreshCount); // a passport with a CURRENT ReadinessResult is left alone by the sweep
  });

  it("sweep mode recomputes a passport already at STALE, giving it a chance to un-stale (isPassportReadinessStale itself only covers READY/VERIFIED, deliberately — see this job's own comment)", async () => {
    const { passport } = await createPassportFixture();
    await passportReadinessJob(fakeJob({ passportId: passport.id }), ctx);
    // Force it to STALE the same way apps/api's own on-read path would —
    // direct status nudge, matching this repo's established "no HTTP
    // endpoint drives this transition yet" fixture precedent.
    await passportRepository.updateStatus(prisma, passport.id, "STALE", null);

    const beforeCount = (await readinessResultRepository.listByPassport(prisma, passport.id)).length;
    await passportReadinessJob(fakeJob({}), ctx);
    const afterCount = (await readinessResultRepository.listByPassport(prisma, passport.id)).length;

    expect(afterCount).toBeGreaterThan(beforeCount); // the sweep DID recompute a STALE passport, not skip it
  });
});
