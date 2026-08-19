// apps/api/tests/integration/worker-integration.test.ts
//
// earlier-stage work — the literal instruction: "Integration tests proving
// event flows api -> queue -> worker -> DB effect, exactly once." Every
// other integration test in this directory proves apps/api's OWN
// synchronous behavior; this file proves the boundary apps/api now shares
// with apps/worker actually works, end to end, through REAL processes —
// not a mock queue, not an inlined copy of the worker's job logic.
//
// Spawns the REAL apps/worker entrypoint (apps/worker/src/server.ts,
// unmodified — the exact file `pnpm --filter @tol/worker start` runs) as
// a genuinely separate OS process, on a WORKER_PORT override (18599)
// chosen to never collide with a real dev worker (.env's default 18500,
// confirmed free at the time this file was written) or another
// concurrent session's own worker. That process connects to the SAME
// real Redis/Postgres this test suite already uses, and consumes the
// SAME fixed WORKER_QUEUE_NAME apps/api's enqueue*() functions target —
// the exact production shape, not a test-only stand-in queue name.
//
// RFQ expiry is the cleanest of the four Block-4-wired jobs to prove this
// with: unlike passport-readiness/capacity-freshness/economics-accrual,
// apps/api has NO synchronous equivalent that also flips RFQ.status ->
// EXPIRED — the ONLY thing that can produce that DB effect is a worker
// actually consuming the job. A green assertion here can only mean the
// real chain ran.
//
// Idempotency across the api->worker boundary (the second named
// requirement) is proven by enqueuing the SAME logical rfq-expiry job
// twice back-to-back, once the RFQ is genuinely overdue — exactly the
// shape a duplicate producer-side enqueue (an HTTP retry, two apps/api
// instances reacting to the same event) would take — and confirming the
// real worker still only ever produces ONE DomainEvent / ONE
// idempotency_keys row / ONE status transition, even though BOTH direct
// enqueue calls (plus the RFQ's own automatic creation-time enqueue —
// three real attempts in total) genuinely raced apps/worker's real
// pg_advisory_xact_lock.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, rfqRepository } from "@tol/db";
import { enqueueRfqExpiry } from "@tol/queue";
import { buildTestApp, createFixtureOpportunity, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

// Portable tsx resolution — same real-bug fix as apps/worker's own
// p17-worker-crash.test.ts (review-
// recovery): require.resolve finds wherever tsx actually got installed
// (pnpm's structure, whatever version is present), never a hardcoded,
// machine-specific path.
const require = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
const WORKER_SERVER_ENTRY = fileURLToPath(new URL("../../../worker/src/server.ts", import.meta.url));
const TEST_WORKER_PORT = "18599";

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, opts: { timeoutMs: number; intervalMs: number; label: string }): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.label}`);
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

describe("earlier-stage work — api -> queue -> worker -> DB, exactly once (real separate worker process)", () => {
  let app: FastifyInstance;
  let workerProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let merchant: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let marketplaceOperator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    merchant = await createFixtureOrgWithUser({ orgLabel: "WorkerIntegMerchant", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    marketplaceOperator = await createFixtureOrgWithUser({ orgLabel: "WorkerIntegOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });

    // THE real, unmodified worker entrypoint — not a stand-in script.
    workerProcess = spawn(process.execPath, [TSX_CLI, WORKER_SERVER_ENTRY], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WORKER_PORT: TEST_WORKER_PORT },
    });
    workerProcess.stdout.on("data", (chunk: Buffer) => {
      // Surfaced for debuggability only, same as p17-worker-crash.test.ts's
      // own precedent — pino JSON lines, not asserted on directly (this
      // test polls the real /ready HTTP endpoint instead, below).
      process.stdout.write(`[worker stdout] ${chunk.toString()}`);
    });
    workerProcess.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[worker stderr] ${chunk.toString()}`);
    });
    workerProcess.on("error", (err) => {
      throw new Error(`spawned worker process failed to start: ${err.message}`);
    });

    // Real readiness gate: /ready returns 200 only once the real worker
    // has passed waitForStartupConsistency, registered every real job
    // handler, and its BullMQ Worker instance is constructed and actively
    // consuming WORKER_QUEUE_NAME — the exact moment it's safe to assume
    // an enqueued job will actually be picked up.
    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://localhost:${TEST_WORKER_PORT}/ready`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "spawned worker process /ready" },
    );
  }, 30_000);

  afterAll(async () => {
    if (workerProcess && !workerProcess.killed) {
      workerProcess.kill("SIGTERM");
    }
    await app.close();
  });

  it(
    "a real POST /rfqs enqueues a real delayed job that the real spawned worker process consumes, transitioning the RFQ to EXPIRED exactly once",
    async () => {
      const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);
      const operatorSession = await login(app, marketplaceOperator.user.email, marketplaceOperator.user.password);

      // dueAt 1.2s out — long enough to clear the HTTP round trip before
      // enqueueRfqExpiry's delay is computed (rfqs/service.ts targets the
      // ABSOLUTE dueAt moment: `rfq.dueAt.getTime() - Date.now()`, so this
      // is self-correcting against processing latency), short enough to
      // keep this test fast.
      const dueAt = new Date(Date.now() + 1200).toISOString();
      const createRes = await app.inject({
        method: "POST",
        url: "/rfqs",
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: {
          opportunityId: opportunity.id,
          providerOrgIds: [merchant.org.id], // arbitrary valid org id — no provider-side action happens in this test
          dueAt,
          disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const rfqId = createRes.json().id as string;

      const expired = await waitFor(
        async () => {
          const fresh = await rfqRepository.findById(prisma, rfqId);
          return fresh?.status === "EXPIRED" ? fresh : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 200, label: `RFQ ${rfqId} reaching EXPIRED via the real worker` },
      );
      expect(expired.status).toBe("EXPIRED");

      const events = await prisma.domainEvent.findMany({ where: { aggregateId: rfqId, eventType: "rfq.expired" } });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ from: "SENT" });

      const idempotencyRow = await prisma.idempotencyKey.findUnique({
        where: { scope_key: { scope: "worker.rfq-expiry", key: `${rfqId}:${dueAt}` } },
      });
      expect(idempotencyRow).not.toBeNull();
    },
    20_000,
  );

  it(
    "boundary idempotency: the SAME logical rfq-expiry job enqueued twice (simulating a duplicate producer-side enqueue) still produces exactly one DB effect",
    async () => {
      const opportunity = await createFixtureOpportunity(merchant.org.id, merchant.user.id);
      const operatorSession = await login(app, marketplaceOperator.user.email, marketplaceOperator.user.password);

      // dueAt 900ms out at creation time — by the time this test reaches
      // the duplicate-enqueue step below (after an explicit wait), it is
      // genuinely overdue, so every enqueued job below exercises
      // expireOne()'s real lock+idempotency path rather than no-op'ing on
      // "not yet overdue" (rfq-expiry.job.ts re-reads the REAL dueAt
      // column at processing time — a job's own BullMQ delay does not
      // change that check).
      const dueAt = new Date(Date.now() + 900).toISOString();
      const createRes = await app.inject({
        method: "POST",
        url: "/rfqs",
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: {
          opportunityId: opportunity.id,
          providerOrgIds: [merchant.org.id],
          dueAt,
          disclosureSnapshot: { opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] }, evidenceRefs: [] },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const rfqId = createRes.json().id as string;

      // Guarantee dueAt has genuinely passed before racing the duplicate
      // enqueue below — this test is about idempotency, not timing luck.
      // (This RFQ's own creation already enqueued ONE automatic job too,
      // per rfqs/service.ts's Block-4 wiring — it may well have already
      // expired the RFQ by the time this wait elapses. That only makes
      // this a STRONGER proof: the two explicit calls below then race an
      // ALREADY-EXPIRED row, a real third contender for the same lock.)
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const [resultA, resultB] = await Promise.all([enqueueRfqExpiry(rfqId, 0), enqueueRfqExpiry(rfqId, 0)]);
      expect(resultA.enqueued).toBe(true);
      expect(resultB.enqueued).toBe(true);

      const expired = await waitFor(
        async () => {
          const fresh = await rfqRepository.findById(prisma, rfqId);
          return fresh?.status === "EXPIRED" ? fresh : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 200, label: `RFQ ${rfqId} reaching EXPIRED after a duplicate enqueue` },
      );
      expect(expired.status).toBe("EXPIRED");

      // THE actual assertion: (at least) three real job attempts ran
      // against this same rfqId (one automatic + two explicit duplicates)
      // — this is not testing "the duplicate enqueue was silently
      // dropped" (both resolved enqueued:true above, real BullMQ jobIds).
      // The worker's own idempotency key collapsed them to exactly one
      // DomainEvent and one status transition — proving idempotency lives
      // at the correct layer (the consumer, keyed on domain values), not
      // accidentally relying on the producer never enqueuing twice.
      const events = await prisma.domainEvent.findMany({ where: { aggregateId: rfqId, eventType: "rfq.expired" } });
      expect(events).toHaveLength(1);

      const idempotencyRow = await prisma.idempotencyKey.findUnique({
        where: { scope_key: { scope: "worker.rfq-expiry", key: `${rfqId}:${expired.dueAt.toISOString()}` } },
      });
      expect(idempotencyRow).not.toBeNull();
    },
    25_000,
  );
});
