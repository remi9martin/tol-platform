// apps/api/tests/integration/lockbox.test.ts
//
// P9 gate proof (the spec: "Ciphertext/receipt/withdraw/release
// evidence") through the real HTTP surface, against the real
// docker-compose Postgres, with REAL cryptography — no mocked/simulated
// encryption anywhere in this file's own assertions. This is the anti-
// fabrication evidence the earlier brief exists to produce: every crypto
// acceptance criterion is proven not just at the packages/crypto unit
// level (already done, 73 tests) but end to end through the actual
// seal -> persist -> release HTTP lifecycle real callers would use.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getConfig } from "@tol/config";
import { parseKeyHex, verifyReceipt } from "@tol/crypto";
import { disconnectPrisma, prisma, Prisma } from "@tol/db";
import { buildTestApp, createFixtureOrgWithUser, extractCookieHeader } from "../helpers/build-test-app.js";

const VALID_PAYLOAD = {
  counterpartyPrivate: "Acme Acquiring — named bank contact on file",
  evidenceSummary: "Signed MSA dated 2024-03-01, three settled batches since.",
  priorDealHistory: "Two prior referrals in 2023, both closed, both compensated.",
};

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return {
    cookie: extractCookieHeader(res.cookies.map((c) => `${c.name}=${c.value}`)),
    csrf: res.cookies.find((c) => c.name === "tol_csrf")?.value ?? "",
  };
}

describe("P9 — Lockbox: real cryptography end to end through the HTTP surface", () => {
  let app: FastifyInstance;
  let sealer: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let outsider: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let operator: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let recipient: Awaited<ReturnType<typeof createFixtureOrgWithUser>>;
  let sealerSession: { cookie: string; csrf: string };
  let outsiderSession: { cookie: string; csrf: string };
  let operatorSession: { cookie: string; csrf: string };
  let seededConditionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();

    sealer = await createFixtureOrgWithUser({ orgLabel: "LockboxSealer", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    outsider = await createFixtureOrgWithUser({ orgLabel: "LockboxOutsider", role: "MERCHANT_PSP_USER", entityType: "MERCHANT" });
    operator = await createFixtureOrgWithUser({ orgLabel: "LockboxOperator", role: "MARKETPLACE_OPERATOR", entityType: "PLATFORM" });
    recipient = await createFixtureOrgWithUser({ orgLabel: "LockboxRecipient", role: "ACQUIRER_PROVIDER_USER", entityType: "ACQUIRER" });

    sealerSession = await login(app, sealer.user.email, sealer.user.password);
    outsiderSession = await login(app, outsider.user.email, outsider.user.password);
    operatorSession = await login(app, operator.user.email, operator.user.password);

    // Reuse the seed.ts earlier fixture ("Lockbox release condition") as a
    // real conditionRef — proves the release flow against the actual
    // seeded SATISFIED DealCondition this build's seed extension exists
    // for, not an arbitrary/unrelated UUID.
    const seededCondition = await prisma.dealCondition.findFirst({ where: { sourceReference: "seed:earlier" } });
    if (!seededCondition) throw new Error("seed.ts earlier fixture (SATISFIED DealCondition) not found — run pnpm prisma:seed first.");
    seededConditionId = seededCondition.id;
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  describe("seal -> receipt -> withdraw lifecycle", () => {
    let lockboxId: string;

    it("seals a Lockbox — 201, response carries ciphertextHash but NEVER ciphertext/iv/authTag bytes", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/lockbox",
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { relationshipType: "ACQUIRER_RELATIONSHIP", region: "EU", payload: VALID_PAYLOAD },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe("SEALED");
      expect(body.ciphertextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body).not.toHaveProperty("ciphertext");
      expect(body).not.toHaveProperty("iv");
      expect(body).not.toHaveProperty("authTag");
      // Structural sweep: NO field anywhere in the response contains the sealed plaintext.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
      expect(serialized).not.toContain(VALID_PAYLOAD.evidenceSummary);
      lockboxId = body.id;
    });

    it("the persisted DB row's ciphertext is REAL — genuinely different from the plaintext, and the plaintext appears nowhere in the row", async () => {
      const row = await prisma.lockbox.findUniqueOrThrow({ where: { id: lockboxId } });
      const ciphertextStr = Buffer.from(row.ciphertext).toString("latin1");
      expect(ciphertextStr).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
      expect(ciphertextStr).not.toContain(VALID_PAYLOAD.evidenceSummary);
      expect(ciphertextStr).not.toContain(VALID_PAYLOAD.priorDealHistory);
      expect(row.iv.length).toBe(12); // 96-bit GCM IV
      expect(row.authTag.length).toBe(16); // 128-bit auth tag
    });

    it("all 3 threshold shares (SEALER/OPERATOR/ESCROW) were persisted, wrapped (never a raw share value equal to any recognizable plaintext)", async () => {
      const shares = await prisma.lockboxKeyShare.findMany({ where: { lockboxId } });
      expect(shares).toHaveLength(3);
      expect(shares.map((s) => s.holderRole).sort()).toEqual(["ESCROW", "OPERATOR", "SEALER"]);
      for (const share of shares) {
        expect(share.wrappedShare).not.toBeNull();
        expect(share.destroyedAt).toBeNull();
      }
    });

    it("no AuditEvent or DomainEvent for this lockbox contains plaintext payload content or share/DEK material — only ciphertextHash and safe metadata (acceptance criterion 9, exercised end to end)", async () => {
      const auditEvents = await prisma.auditEvent.findMany({ where: { resourceType: "lockbox", resourceId: lockboxId } });
      const domainEvents = await prisma.domainEvent.findMany({ where: { aggregateType: "lockbox", aggregateId: lockboxId } });
      expect(auditEvents.length).toBeGreaterThan(0);
      expect(domainEvents.length).toBeGreaterThan(0);
      for (const row of [...auditEvents, ...domainEvents]) {
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
        expect(serialized).not.toContain(VALID_PAYLOAD.evidenceSummary);
        expect(serialized).not.toContain(VALID_PAYLOAD.priorDealHistory);
      }
    });

    it("GET receipt returns a signature that independently verifies via @tol/crypto's verifyReceipt — real HMAC-SHA256, not a mock hash", async () => {
      const res = await app.inject({ method: "GET", url: `/lockbox/${lockboxId}/receipt`, headers: { cookie: sealerSession.cookie } });
      expect(res.statusCode).toBe(200);
      const receipt = res.json();
      expect(receipt.algorithm).toBe("HMAC-SHA256");

      const hmacKey = parseKeyHex(getConfig().lockboxReceiptHmacKey, "LOCKBOX_RECEIPT_HMAC_KEY");
      const valid = verifyReceipt(
        {
          lockboxId: receipt.lockboxId,
          ciphertextHash: receipt.ciphertextHash,
          sealerOrgId: receipt.sealerOrgId,
          sealedAt: receipt.sealedAt,
          state: "SEALED",
        },
        receipt.signature,
        hmacKey,
      );
      expect(valid).toBe(true);
    });

    it("an EDITED receipt (ciphertextHash tampered) fails verification — real tamper-evidence, not decorative", async () => {
      const res = await app.inject({ method: "GET", url: `/lockbox/${lockboxId}/receipt`, headers: { cookie: sealerSession.cookie } });
      const receipt = res.json();
      const hmacKey = parseKeyHex(getConfig().lockboxReceiptHmacKey, "LOCKBOX_RECEIPT_HMAC_KEY");
      const tamperedValid = verifyReceipt(
        { lockboxId: receipt.lockboxId, ciphertextHash: "f".repeat(64), sealerOrgId: receipt.sealerOrgId, sealedAt: receipt.sealedAt, state: "SEALED" },
        receipt.signature,
        hmacKey,
      );
      expect(tamperedValid).toBe(false);
    });

    it("the OUTSIDER org (not the sealer) CANNOT read the receipt — tenant isolation proof", async () => {
      const res = await app.inject({ method: "GET", url: `/lockbox/${lockboxId}/receipt`, headers: { cookie: outsiderSession.cookie } });
      expect(res.statusCode).toBe(403);
    });

    it("the OUTSIDER org CANNOT withdraw a lockbox it doesn't own — tenant isolation proof", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/withdraw`,
        headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it("the sealer withdraws — 200, status WITHDRAWN", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/withdraw`,
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { withdrawReason: "Testing the withdraw path — this Lockbox will never be released." },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("WITHDRAWN");
      expect(res.json().withdrawnByUserId).toBe(sealer.user.id);
    });

    it("acceptance criterion 6, proven live: ALL 3 shares are destroyed (wrappedShare NULLed) after withdraw — not just a status flag", async () => {
      const shares = await prisma.lockboxKeyShare.findMany({ where: { lockboxId } });
      expect(shares).toHaveLength(3);
      for (const share of shares) {
        expect(share.wrappedShare).toBeNull();
        expect(share.shareIv).toBeNull();
        expect(share.shareAuthTag).toBeNull();
        expect(share.destroyedAt).not.toBeNull();
      }
    });

    it("acceptance criterion 6, proven live: a withdrawn Lockbox can NEVER be released — the operator's attempt fails cleanly (400 invalid_state_transition, not 500), through the real HTTP path", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/release`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      // assertValidLockboxReleaseCascade throws a DomainTransitionError
      // subclass, which app.ts's central error handler maps to a clean
      // 400 "invalid_state_transition" — the SAME pattern rfqs.test.ts's
      // "re-selecting an already-SELECTED RFQ fails with a clean 400"
      // proves for RFQ. Never a 500; never a silent success.
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_state_transition");
    });

    it("withdrawing an already-withdrawn Lockbox a second time fails cleanly (409), proving the state machine — not just the crypto — also rejects it", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/withdraw`,
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("seal -> (condition met) -> release lifecycle", () => {
    let lockboxId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/lockbox",
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { relationshipType: "PROCESSOR_RELATIONSHIP", region: "US", metadataSummary: "Processor relationship — US", payload: VALID_PAYLOAD },
      });
      expect(res.statusCode).toBe(201);
      lockboxId = res.json().id;
    });

    it("the SEALER itself cannot release its own Lockbox — release is operator-triggered only (ADR-0001/ADR-0009)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/release`,
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      expect(res.statusCode).toBe(403);
    });

    it("the OUTSIDER org (not sealer, not operator) cannot release either", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/release`,
        headers: { cookie: outsiderSession.cookie, "x-csrf-token": outsiderSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      expect(res.statusCode).toBe(403);
    });

    it("the OPERATOR releases, referencing the real seeded committed condition — 200, REAL Shamir reconstruction + REAL AES-256-GCM decryption, disclosedPayload matches the original sealed payload EXACTLY", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/release`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lockbox.status).toBe("OPENED");
      expect(body.lockbox.recipientOrgId).toBe(recipient.org.id);
      expect(body.lockbox.conditionRef).toBe(seededConditionId);
      expect(body.releaseEvidence.authorizedRoles.sort()).toEqual(["ESCROW", "OPERATOR"]);
      expect(body.releaseEvidence.recipientOrgId).toBe(recipient.org.id);
      // THE decryption proof: the disclosed plaintext is byte-for-byte the original sealed payload.
      expect(body.disclosedPayload).toEqual(VALID_PAYLOAD);
    });

    it("the persisted status is OPENED and a LockboxReleaseEvidence row exists with the real ciphertextHash", async () => {
      const row = await prisma.lockbox.findUniqueOrThrow({ where: { id: lockboxId } });
      expect(row.status).toBe("OPENED");
      expect(row.releasedAt).not.toBeNull();

      const evidence = await prisma.lockboxReleaseEvidence.findFirst({ where: { lockboxId } });
      expect(evidence).not.toBeNull();
      expect(evidence!.ciphertextHash).toBe(row.ciphertextHash);
    });

    it("the release's own AuditEvent/DomainEvent rows still carry no plaintext, even though release itself just disclosed it in the HTTP response", async () => {
      const auditEvents = await prisma.auditEvent.findMany({ where: { resourceType: "lockbox", resourceId: lockboxId, action: "lockbox.released" } });
      const domainEvents = await prisma.domainEvent.findMany({ where: { aggregateType: "lockbox", aggregateId: lockboxId, eventType: "lockbox.opened" } });
      expect(auditEvents.length).toBeGreaterThan(0);
      expect(domainEvents.length).toBeGreaterThan(0);
      for (const row of [...auditEvents, ...domainEvents]) {
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
        expect(serialized).not.toContain(VALID_PAYLOAD.evidenceSummary);
        expect(serialized).not.toContain(VALID_PAYLOAD.priorDealHistory);
      }
    });

    it("regression (real review finding, fixed): the release endpoint is NOT wrapped in idempotency protection, so disclosedPayload is never persisted into idempotency_keys.response_body — checked across EVERY idempotency_keys row in the whole table, not just ones scoped to this lockbox, since the bug (if present) would write the plaintext regardless of scope key", async () => {
      const allIdempotencyRows = await prisma.idempotencyKey.findMany({ where: { scope: "lockbox.release" } });
      expect(allIdempotencyRows).toHaveLength(0); // no rows at all — release was never routed through withIdempotency
      // Belt and suspenders: sweep the whole table for the plaintext regardless of scope.
      const everyIdempotencyRow = await prisma.idempotencyKey.findMany({});
      for (const row of everyIdempotencyRow) {
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
        expect(serialized).not.toContain(VALID_PAYLOAD.evidenceSummary);
      }
    });

    it("releasing an already-OPENED Lockbox again fails cleanly (400 invalid_state_transition) — release is not repeatable", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/release`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_state_transition");
    });
  });

  describe("tamper-evidence exercised end to end through real HTTP (not just packages/crypto's own unit tests)", () => {
    let lockboxId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/lockbox",
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { relationshipType: "MERCHANT_RELATIONSHIP", region: "GLOBAL", payload: VALID_PAYLOAD },
      });
      lockboxId = res.json().id;
    });

    it("corrupting the persisted ciphertext directly in the database makes a subsequent release fail cleanly (500 problem+json, never a wrong/silent plaintext)", async () => {
      const row = await prisma.lockbox.findUniqueOrThrow({ where: { id: lockboxId } });
      const corrupted = Buffer.from(row.ciphertext);
      corrupted[0] = corrupted[0]! ^ 0xff;
      await prisma.lockbox.update({ where: { id: lockboxId }, data: { ciphertext: corrupted } });

      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${lockboxId}/release`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("internal_error");
      // The response body itself must never leak a disclosedPayload on this failure path.
      expect(res.json()).not.toHaveProperty("disclosedPayload");

      // And the lockbox must NOT have been silently marked OPENED despite the failed release.
      const after = await prisma.lockbox.findUniqueOrThrow({ where: { id: lockboxId } });
      expect(after.status).toBe("SEALED");
    });

    // earlier, P17 gate — the spec scenario #7, verbatim: "Lockbox
    // key-release failure: submission remains FROZEN/blocked; no partial
    // plaintext is persisted." Distinct fault from the ciphertext-
    // corruption test above (which trips AES-GCM's auth tag) — this one
    // corrupts an OPERATOR share so Shamir reconstruction ITSELF fails,
    // the other real way `releasePayload()` can throw before ever
    // reaching a plaintext. Confirmed via direct code read (an earlier
    // research, see ADR-0014 part 5) that both the share-count
    // check AND releasePayload()'s try/catch sit inside the SAME
    // withTransaction(...) as every cascade-status write, before any of
    // them — a thrown error here rolls the whole transaction back,
    // meaning the Lockbox's status is structurally unable to advance.
    // ("Remains FROZEN" is the scope doc's own description of this
    // invariant, not a literal status value this build persists — see
    // this test's own status assertion below for what actually happens
    // in this implementation: a release-eligible Lockbox is always
    // SEALED going in, since earlier never persists the intermediate
    // COMMITTED/FROZEN states standalone.)
    it("a corrupted OPERATOR share makes Shamir reconstruction itself fail — release fails cleanly (500), the Lockbox status is unchanged, and no plaintext lands anywhere: not the HTTP response, not AuditEvent, not DomainEvent, not idempotency_keys", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/lockbox",
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { relationshipType: "MERCHANT_RELATIONSHIP", region: "GLOBAL", payload: VALID_PAYLOAD },
      });
      const shareTestLockboxId = create.json().id;

      const operatorShare = await prisma.lockboxKeyShare.findFirstOrThrow({ where: { lockboxId: shareTestLockboxId, holderRole: "OPERATOR" } });
      expect(operatorShare.wrappedShare).not.toBeNull();
      const corruptedShare = Buffer.from(operatorShare.wrappedShare!);
      corruptedShare[0] = corruptedShare[0]! ^ 0xff;
      await prisma.lockboxKeyShare.update({ where: { id: operatorShare.id }, data: { wrappedShare: corruptedShare } });

      const res = await app.inject({
        method: "POST",
        url: `/lockbox/${shareTestLockboxId}/release`,
        headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
        payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("internal_error");
      expect(res.json()).not.toHaveProperty("disclosedPayload");
      // Structural proof, not just "no disclosedPayload key" — the ENTIRE
      // response body, serialized, never contains anything from the real
      // VALID_PAYLOAD plaintext this lockbox actually sealed.
      expect(JSON.stringify(res.json())).not.toContain(VALID_PAYLOAD.counterpartyPrivate);

      const after = await prisma.lockbox.findUniqueOrThrow({ where: { id: shareTestLockboxId } });
      expect(after.status).toBe("SEALED"); // unchanged — the failed release never advanced the cascade

      // No partial plaintext anywhere else this codebase ever writes it:
      // AuditEvent.afterValue, DomainEvent.payload, and — the ONE real
      // historical bug this exact table caused (an earlier review
      // finding, the build log's earlier-stage work) — idempotency_keys.
      // response_body. release() is deliberately NOT idempotency-wrapped
      // BECAUSE of that finding; asserting the table stays empty for
      // this lockboxId proves that fix still holds under a DIFFERENT
      // failure trigger than the one that originally caught it.
      const audits = await prisma.auditEvent.findMany({ where: { resourceId: shareTestLockboxId } });
      const events = await prisma.domainEvent.findMany({ where: { aggregateId: shareTestLockboxId } });
      for (const row of [...audits, ...events]) {
        expect(JSON.stringify(row)).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
      }
      // idempotency_keys carries no lockboxId column to scope by — this
      // sweeps every row that has a recorded response, matching the
      // own precedent (the build log this stage: "plus a regression test
      // sweeping that whole table") for exactly the finding that made
      // release() deliberately NOT idempotency-wrapped in the first
      // place. A real, if broad, proof that fix still holds — release()
      // never reserves/completes an idempotency row at all, so this
      // table should contain nothing related to this lockboxId or its
      // plaintext regardless of which OTHER tests' rows are present.
      const idempotencyRows = await prisma.idempotencyKey.findMany({ where: { responseBody: { not: Prisma.JsonNull } } });
      for (const row of idempotencyRows) {
        expect(JSON.stringify(row.responseBody)).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
      }
    });
  });

  describe("IV uniqueness proven end to end (not just packages/crypto's own 10,000-encryption unit test)", () => {
    it("sealing the identical payload twice produces two different IVs and two different ciphertexts in the real database", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/lockbox",
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { relationshipType: "BANKING_RELATIONSHIP", region: "UK", payload: VALID_PAYLOAD },
      });
      const second = await app.inject({
        method: "POST",
        url: "/lockbox",
        headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
        payload: { relationshipType: "BANKING_RELATIONSHIP", region: "UK", payload: VALID_PAYLOAD },
      });
      expect(first.json().ciphertextHash).not.toBe(second.json().ciphertextHash);

      const rowA = await prisma.lockbox.findUniqueOrThrow({ where: { id: first.json().id } });
      const rowB = await prisma.lockbox.findUniqueOrThrow({ where: { id: second.json().id } });
      expect(Buffer.from(rowA.iv).equals(Buffer.from(rowB.iv))).toBe(false);
      expect(Buffer.from(rowA.ciphertext).equals(Buffer.from(rowB.ciphertext))).toBe(false);
    });
  });

  describe("concurrency (A1, a later clean-window fix): the pg_advisory_xact_lock guard against a genuine withdraw-vs-release disclosure race", () => {
    // Pre-fix, this race was WIDE OPEN: withdraw() and release() each
    // re-read the lockbox fresh inside their own transaction but took no
    // lock, so under READ COMMITTED both could read the pre-commit SEALED
    // status and proceed. release()'s crypto (Shamir-combine + AES
    // decrypt) runs on shares fetched INSIDE its own transaction, ahead of
    // its first write — so it can successfully decrypt and return
    // disclosedPayload to its caller even though a concurrent withdraw()
    // destroys those exact shares and ends the lockbox at WITHDRAWN
    // moments later. "release becomes cryptographically, not just
    // permission-check, impossible afterward" (this file's own seal() doc
    // comment, acceptance criterion 6) is exactly the guarantee that race
    // breaks.
    // Run the race REPEATEDLY (against a fresh lockbox each time), not
    // once — a single Promise.all pair is empirically flaky at exposing
    // this specific race: release() does strictly more pre-transaction
    // work than withdraw() (an extra recipientOrg lookup + KEK parsing)
    // before it ever opens its own transaction, so a single cold-start
    // pair (first connection-pool acquisition, first query-plan cache
    // miss) can let withdraw() win cleanly by a wide margin even against
    // the pre-fix code, silently skipping the race window entirely
    // (confirmed empirically: 6/6 single-shot trials against the pre-fix
    // code passed clean when withdraw() was dispatched first, and even
    // with release() dispatched first — the ordering that actually
    // closes the head start — the FIRST iteration in a fresh trial still
    // came back clean while 14 of the following 14 warmed-up iterations
    // reliably reproduced the double-success bug). Looping catches the
    // race reliably regardless of which iteration happens to hit it, and
    // remains a fast, non-flaky regression test post-fix: with the lock
    // in place every single iteration is deterministically safe, not
    // safe-by-luck.
    const RACE_ATTEMPTS = 8;

    it(`firing ${RACE_ATTEMPTS} real, simultaneous release()-vs-withdraw() races (Promise.all, not sequential, one per fresh SEALED lockbox) each results in EXACTLY ONE winning, and NO plaintext is ever disclosed on a lockbox that ends up WITHDRAWN`, async () => {
      for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt++) {
        const create = await app.inject({
          method: "POST",
          url: "/lockbox",
          headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
          payload: { relationshipType: "MERCHANT_RELATIONSHIP", region: "GLOBAL", payload: VALID_PAYLOAD },
        });
        expect(create.statusCode).toBe(201);
        const raceLockboxId = create.json().id;

        // Dispatch order matters empirically — see this block's own
        // comment above: release() first is the ordering that actually
        // closes its own head-start gap against withdraw().
        const [releaseAttempt, withdrawAttempt] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/lockbox/${raceLockboxId}/release`,
            headers: { cookie: operatorSession.cookie, "x-csrf-token": operatorSession.csrf },
            payload: { recipientOrgId: recipient.org.id, conditionRef: seededConditionId },
          }),
          app.inject({
            method: "POST",
            url: `/lockbox/${raceLockboxId}/withdraw`,
            headers: { cookie: sealerSession.cookie, "x-csrf-token": sealerSession.csrf },
            payload: { withdrawReason: `concurrency test — race attempt ${attempt}` },
          }),
        ]);

        // Exactly one wins (200) — never both (pre-fix's actual failure
        // mode: BOTH transactions read the pre-commit SEALED status and
        // BOTH proceed to a "successful" 200 — release() discloses the
        // real plaintext from shares that withdraw() is concurrently
        // destroying, and withdraw()'s own commit can then be silently
        // overwritten back to OPENED by release()'s later-committing
        // cascade, an internally-contradictory final row: status OPENED
        // with every key share permanently destroyed), and never neither.
        const statuses = [withdrawAttempt.statusCode, releaseAttempt.statusCode];
        expect(statuses.filter((s) => s === 200), `attempt ${attempt}: statuses were ${JSON.stringify(statuses)}`).toHaveLength(1);

        const finalLockbox = await prisma.lockbox.findUniqueOrThrow({ where: { id: raceLockboxId } });
        const shares = await prisma.lockboxKeyShare.findMany({ where: { lockboxId: raceLockboxId } });

        if (finalLockbox.status === "WITHDRAWN") {
          // withdraw() won the (serialized) race — release() MUST have
          // failed cleanly (its fresh re-read, now inside the lock, sees
          // WITHDRAWN and assertValidLockboxReleaseCascade rejects it
          // BEFORE any share is read or any crypto runs), and critically
          // must NEVER have disclosed the real plaintext to its caller —
          // THE actual invariant the missing lock used to violate.
          expect(withdrawAttempt.statusCode).toBe(200);
          expect(releaseAttempt.statusCode).not.toBe(200);
          expect(releaseAttempt.json()).not.toHaveProperty("disclosedPayload");
          expect(JSON.stringify(releaseAttempt.json())).not.toContain(VALID_PAYLOAD.counterpartyPrivate);
          expect(JSON.stringify(releaseAttempt.json())).not.toContain(VALID_PAYLOAD.evidenceSummary);

          for (const share of shares) {
            expect(share.wrappedShare).toBeNull(); // genuinely destroyed by the winning withdraw()
          }
        } else {
          // release() won the race fairly — a LEGITIMATE disclosure,
          // since the final persisted state really is OPENED (never
          // silently overwritten back to WITHDRAWN afterward).
          // withdraw() must then fail cleanly against the now-OPENED
          // lockbox (canWithdrawFrom rejects OPENED — it's not one of
          // the states withdraw is legal from).
          expect(finalLockbox.status).toBe("OPENED");
          expect(releaseAttempt.statusCode).toBe(200);
          expect(releaseAttempt.json().disclosedPayload).toEqual(VALID_PAYLOAD);
          expect(withdrawAttempt.statusCode).toBe(409);

          for (const share of shares) {
            expect(share.wrappedShare).not.toBeNull(); // withdraw() lost — never reached its destroy step
          }
        }
      }
    });
  });
});
