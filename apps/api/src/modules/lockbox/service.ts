// apps/api/src/modules/lockbox/service.ts
//
// the spec (P9 gate). Real cryptography end to end: seal encrypts with
// @tol/crypto's real AES-256-GCM + Shamir threshold split (DECISIONS.md
// D1/D9) — never a mock/deterministic hash. Every mutation follows earlier/
// the pattern exactly: can() first, @tol/domain state-transition
// validation second, then a transaction that persists + writes BOTH an
// AuditEvent and a DomainEvent — same discipline as rfqs/service.ts.
//
// THE ANTI-FABRICATION DISCIPLINE THIS FILE EXISTS TO ENFORCE (earlier
// brief, acceptance criterion 9 — grep-verifiable): no AuditEvent/
// DomainEvent payload, no log line, and no persisted column anywhere in
// this file ever carries plaintext payload content or DEK/share material
// — only `ciphertextHash` (a sha256 hex digest). The ONE place real
// plaintext ever exists after this file returns is `release()`'s
// response `disclosedPayload` field, which is never written to a
// database row, never logged, and never included in any audit/timeline
// write — search this file for every `afterValue`/`payload` object
// passed to `auditWriter`/`timelineWriter` to verify that directly.

import { can, type Actor } from "@tol/authz";
import {
  assertValidLockboxReleaseCascade,
  assertValidLockboxTransition,
  canWithdrawFrom,
  LOCKBOX_RELEASE_CASCADE,
} from "@tol/domain";
import {
  lockboxKeyShareRepository,
  lockboxReceiptRepository,
  lockboxReleaseEvidenceRepository,
  lockboxRepository,
  newLockboxId,
  organizationRepository,
  prisma,
  type Lockbox,
  type LockboxReceipt,
  type LockboxReleaseEvidence,
  type LockboxShareRole,
} from "@tol/db";
import {
  parseKeyHex,
  releasePayload,
  sealPayload,
  signReceipt,
  type RoleKeks,
  type WrappedShare,
} from "@tol/crypto";
import { getConfig } from "@tol/config";
import {
  LockboxPayloadSchema,
  type LockboxPayload,
  type ReleaseLockboxRequest,
  type SealLockboxRequest,
  type WithdrawLockboxRequest,
} from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

const CROSS_ORG_LOCKBOX_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

/** The 2 threshold roles this build's `release()` always combines — the "escrowed" path (no fresh sealer cooperation required, ADR-0001/ADR-0009). The GENERAL 2-of-3 flexibility (any pair of the 3 roles) is proven at the @tol/crypto layer (envelope.test.ts); this constant is the one concrete combination the API actually wires. */
const RELEASE_AUTHORIZING_ROLES: readonly LockboxShareRole[] = ["OPERATOR", "ESCROW"];

/**
 * KMS stand-in (acceptance criterion 8) — reads the 4 required 32-byte
 * hex keys from @tol/config's typed env loader and converts them via
 * @tol/crypto's parseKeyHex, which fails loud (MissingKeyMaterialError)
 * on anything missing/malformed. @tol/config itself only checks
 * presence; format validation lives here, at the point of use, per
 * ADR-0009.
 */
function loadRoleKeks(): RoleKeks {
  const config = getConfig();
  return {
    SEALER: parseKeyHex(config.lockboxKekSealer, "LOCKBOX_KEK_SEALER"),
    OPERATOR: parseKeyHex(config.lockboxKekOperator, "LOCKBOX_KEK_OPERATOR"),
    ESCROW: parseKeyHex(config.lockboxKekEscrow, "LOCKBOX_KEK_ESCROW"),
  };
}
function loadReceiptHmacKey(): Buffer {
  return parseKeyHex(getConfig().lockboxReceiptHmacKey, "LOCKBOX_RECEIPT_HMAC_KEY");
}

function serializePayload(payload: LockboxPayload): Buffer {
  // `payload` is already validated against LockboxPayloadSchema by the
  // route (SealLockboxRequestSchema includes it) before this is ever
  // called — re-validating here would be redundant with the established
  // "validate once, at the wire boundary" convention every other service
  // in this codebase follows (rfqs/service.ts never re-validates its own
  // already-Zod-checked inputs either).
  return Buffer.from(JSON.stringify(payload), "utf8");
}

/**
 * Parses AND schema-validates the just-decrypted plaintext, wrapped in a
 * try/catch that turns any failure (malformed JSON, or JSON that doesn't
 * match LockboxPayloadSchema) into a clean ProblemError rather than an
 * uncaught SyntaxError/ZodError. This runs only AFTER releasePayload()'s
 * own try/catch has already confirmed the ciphertext decrypted
 * successfully (a real auth-tag pass) — so in ordinary operation this
 * function's input is always exactly the JSON.stringify'd bytes
 * serializePayload produced at seal time, and cannot fail. The guard
 * exists as defense in depth against a genuinely impossible-today but
 * cheap-to-close scenario (e.g. a future sealing path that writes
 * something other than LockboxPayloadSchema-shaped JSON) — belt and
 * suspenders, not a load-bearing security control (that's GCM's auth tag,
 * proven in packages/crypto's own tamper-evidence tests).
 */
function deserializePayload(plaintext: Buffer): LockboxPayload {
  try {
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    return LockboxPayloadSchema.parse(parsed);
  } catch {
    throw ProblemError.internal(
      "Lockbox release decrypted successfully but the resulting content did not match the expected payload shape — internal consistency error.",
    );
  }
}
/** GCM's additional authenticated data: this build's convention is the lockbox's own id, generated app-side before the row exists (see schema.prisma's Lockbox.aad comment) — ALWAYS recomputed from the row's own `id`, never read back from a stored `aad` column, so a tampered `aad` value can never defeat the binding it exists to enforce. */
function lockboxAad(lockboxId: string): Buffer {
  return Buffer.from(lockboxId, "utf8");
}

/**
 * Prisma reads back every `Bytes` column as `Uint8Array<ArrayBuffer>`
 * (its own generated type), while @tol/crypto's functions are typed to
 * take `Buffer` (matching what `node:crypto`'s primitives naturally
 * produce/consume) — the same well-known `@types/node`-vs-Prisma generic
 * mismatch `packages/db/src/repositories/types.ts`'s `toBytesInput`
 * documents, in the opposite direction (read-back, not write). Unlike
 * that helper (a type-only assertion, safe because Node's `crypto` never
 * produces `SharedArrayBuffer`-backed output), this is a REAL runtime
 * conversion — `Buffer.from(u8)` copies the bytes into a genuine `Buffer`
 * instance — because the input here is Prisma's own generic `Uint8Array`,
 * not a value this codebase already knows is Buffer-backed.
 */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

export interface ReleaseResult {
  lockbox: Lockbox;
  releaseEvidence: LockboxReleaseEvidence;
  disclosedPayload: LockboxPayload;
}

export const lockboxService = {
  async list(actor: Actor): Promise<Lockbox[]> {
    const decision = can(actor, "lockbox.read_receipt", { type: "lockbox", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (actor.role !== null && CROSS_ORG_LOCKBOX_ROLES.has(actor.role)) {
      return lockboxRepository.list(prisma);
    }
    if (!actor.organizationId) return [];
    return lockboxRepository.listBySealer(prisma, actor.organizationId);
  },

  async getById(actor: Actor, lockboxId: string): Promise<Lockbox> {
    const lockbox = await lockboxRepository.findById(prisma, lockboxId);
    if (!lockbox) throw ProblemError.notFound("Lockbox not found.");

    const decision = can(actor, "lockbox.read_receipt", { type: "lockbox", id: lockbox.id, ownerOrgId: lockbox.sealerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return lockbox;
  },

  async getReceipt(actor: Actor, lockboxId: string): Promise<LockboxReceipt> {
    const lockbox = await lockboxRepository.findById(prisma, lockboxId);
    if (!lockbox) throw ProblemError.notFound("Lockbox not found.");

    const decision = can(actor, "lockbox.read_receipt", { type: "lockbox", id: lockbox.id, ownerOrgId: lockbox.sealerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const receipt = await lockboxReceiptRepository.findLatestByLockbox(prisma, lockboxId);
    if (!receipt) throw ProblemError.internal("Lockbox has no receipt on record — this should never happen for a sealed lockbox.");
    return receipt;
  },

  /**
   * The ONLY action that creates a Lockbox row — always already SEALED
   * (there is no persisted DRAFT; see @tol/domain/src/lockbox-states.ts's
   * header comment). Real AES-256-GCM encryption + Shamir 2-of-3 split
   * happens here, via @tol/crypto — not simulated, not a hash standing in
   * for encryption (the exact fabrication this whole day exists to
   * eliminate; see the reuse-reference prototype's `mockSealHash`,
   * intentionally never called anywhere in this file).
   */
  async seal(actor: Actor, input: SealLockboxRequest, context: RequestContext): Promise<Lockbox> {
    if (!actor.organizationId) throw ProblemError.forbidden("No active organization membership.");

    const decision = can(actor, "lockbox.seal", { type: "lockbox", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const lockboxId = newLockboxId();
    const keks = loadRoleKeks();
    const plaintext = serializePayload(input.payload);
    const sealed = sealPayload(plaintext, keks, lockboxAad(lockboxId));

    const sealedAt = new Date();
    const receiptPayload = {
      lockboxId,
      ciphertextHash: sealed.ciphertextHash,
      sealerOrgId: actor.organizationId,
      sealedAt: sealedAt.toISOString(),
      state: "SEALED",
    };
    const signature = signReceipt(receiptPayload, loadReceiptHmacKey());

    return withTransaction(async (tx) => {
      const lockbox = await lockboxRepository.createSealed(tx, {
        id: lockboxId,
        sealerOrgId: actor.organizationId!,
        relationshipType: input.relationshipType,
        region: input.region,
        metadataSummary: input.metadataSummary ?? null,
        iv: sealed.iv,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
        aad: lockboxAad(lockboxId),
        ciphertextHash: sealed.ciphertextHash,
        sealedAt,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      await lockboxKeyShareRepository.createMany(
        tx,
        sealed.shares.map((share: WrappedShare) => ({
          lockboxId,
          holderRole: share.role,
          shareIndex: share.index,
          threshold: 2,
          totalShares: 3,
          wrappedShare: share.wrapped.ciphertext,
          shareIv: share.wrapped.iv,
          shareAuthTag: share.wrapped.authTag,
        })),
      );

      await lockboxReceiptRepository.create(tx, {
        lockboxId,
        version: 1,
        ciphertextHash: sealed.ciphertextHash,
        sealerOrgId: actor.organizationId!,
        sealedAt,
        signature,
        algorithm: "HMAC-SHA256",
      });

      // SAFE-FIELD DISCIPLINE: afterValue/payload below carry ONLY
      // ciphertextHash + non-sensitive metadata — never `input.payload`
      // (the plaintext) or any share/DEK material.
      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: actor.organizationId,
        action: "lockbox.sealed",
        resourceType: "lockbox",
        resourceId: lockboxId,
        afterValue: {
          relationshipType: input.relationshipType,
          region: input.region,
          ciphertextHash: sealed.ciphertextHash,
          metadataSummary: input.metadataSummary ?? null,
        },
      });
      await timelineWriter(context).write(tx, {
        eventType: "lockbox.sealed",
        aggregateType: "lockbox",
        aggregateId: lockboxId,
        payload: {
          sealerOrgId: actor.organizationId,
          relationshipType: input.relationshipType,
          region: input.region,
          ciphertextHash: sealed.ciphertextHash,
        },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return lockbox;
    });
  },

  /**
   * Acceptance criterion 6: destroys ALL 3 wrapped shares (not just the
   * sealer's own), not merely a status flag — release becomes
   * cryptographically, not just permission-check, impossible afterward
   * (proven in the integration test that withdraws, then attempts
   * release, and asserts it fails).
   */
  async withdraw(actor: Actor, lockboxId: string, input: WithdrawLockboxRequest, context: RequestContext): Promise<Lockbox> {
    const lockbox = await lockboxRepository.findById(prisma, lockboxId);
    if (!lockbox) throw ProblemError.notFound("Lockbox not found.");

    const decision = can(actor, "lockbox.withdraw", { type: "lockbox", id: lockbox.id, ownerOrgId: lockbox.sealerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (!canWithdrawFrom(lockbox.status)) {
      throw ProblemError.conflict(`Lockbox cannot be withdrawn from its current state (${lockbox.status}).`);
    }
    assertValidLockboxTransition(lockbox.status, "WITHDRAWN");

    return withTransaction(async (tx) => {
      // ADVISORY LOCK, keyed by the lockbox's own id — closes a genuine
      // gap the re-read-fresh-inside-tx pattern alone does NOT close
      // (concurrency-audit clean-window pass, a later): under
      // Postgres's default READ COMMITTED isolation, a concurrent
      // release() could read this SAME lockbox's still-non-destroyed
      // shares, Shamir-combine them, and AES-decrypt + DISCLOSE the real
      // plaintext to ITS caller BEFORE this withdraw() commits — the
      // crypto/read happens inside release()'s own transaction body,
      // ahead of its first write, so re-reading status alone (without a
      // lock) cannot prevent the disclosure once it's already happened,
      // only prevent the FINAL row from ending up wrong. Same idiom as
      // claims/service.ts's fileDispute()/decide(): pg_advisory_xact_lock
      // serializes concurrent transactions on the SAME lockboxId (hashed
      // to a bigint key) — the second transaction blocks here until the
      // first commits or rolls back, so its own fresh read below is
      // guaranteed to observe the first transaction's committed result.
      // Automatically released at transaction end, no separate unlock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockboxId}))`;

      // Re-read fresh INSIDE the transaction (and now inside the lock) —
      // same check-then-act race guard the rfqs/service.ts established
      // (review): a concurrent release()
      // could have already moved this lockbox past SEALED between the
      // pre-checks above and this transaction actually starting.
      const freshLockbox = await lockboxRepository.findById(tx, lockboxId);
      if (!freshLockbox) throw ProblemError.internal("Lockbox disappeared mid-transaction.");
      if (!canWithdrawFrom(freshLockbox.status)) {
        throw ProblemError.conflict(`Lockbox cannot be withdrawn from its current state (${freshLockbox.status}).`);
      }
      assertValidLockboxTransition(freshLockbox.status, "WITHDRAWN");

      const withdrawnAt = new Date();
      const updated = await lockboxRepository.withdraw(tx, lockboxId, {
        withdrawnAt,
        withdrawnByUserId: actor.userId,
        withdrawReason: input.withdrawReason ?? null,
      });

      // Destroys ALL shares (all 3 roles), not just SEALER's — see this
      // function's own doc comment. Asserts the expected count actually
      // matches LOCKBOX_SHARE_TOTAL (3): the anti-fabrication discipline
      // this whole day is built around means never silently trusting a
      // destructive operation "probably" did what it claims — verify the
      // count, not just the absence of a thrown error.
      const destroyedCount = await lockboxKeyShareRepository.destroyAllByLockbox(
        tx,
        lockboxId,
        withdrawnAt,
        `withdrawn by sealer org ${actor.organizationId}`,
      );
      if (destroyedCount !== 3) {
        throw ProblemError.internal(
          `Expected to destroy 3 key shares on withdraw, destroyed ${destroyedCount} — internal consistency error.`,
        );
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: lockbox.sealerOrgId,
        action: "lockbox.withdrawn",
        resourceType: "lockbox",
        resourceId: lockboxId,
        reason: input.withdrawReason ?? null,
        afterValue: { withdrawReason: input.withdrawReason ?? null, sharesDestroyed: destroyedCount },
      });
      await timelineWriter(context).write(tx, {
        eventType: "lockbox.withdrawn",
        aggregateType: "lockbox",
        aggregateId: lockboxId,
        payload: { withdrawReason: input.withdrawReason ?? null },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return updated;
    });
  },

  /**
   * The escrowed-release path (ADR-0001/ADR-0009): only PLATFORM_OWNER/
   * MARKETPLACE_OPERATOR ever reach here (packages/authz's matrix) — no
   * fresh cooperation from the sealer is required. Performs the full
   * SEALED -> COMMITTED -> FROZEN -> OPENED cascade atomically as ONE
   * transaction (LOCKBOX_RELEASE_CASCADE, same "no separate deal.open
   * action" precedent as ADR-0008 part 5), combines the OPERATOR +
   * ESCROW threshold shares via REAL Shamir reconstruction + REAL
   * AES-256-GCM decryption (@tol/crypto), and discloses the real
   * plaintext ONLY in this function's return value.
   */
  async release(actor: Actor, lockboxId: string, input: ReleaseLockboxRequest, context: RequestContext): Promise<ReleaseResult> {
    const lockbox = await lockboxRepository.findById(prisma, lockboxId);
    if (!lockbox) throw ProblemError.notFound("Lockbox not found.");

    const decision = can(actor, "lockbox.release", { type: "lockbox", id: lockbox.id, ownerOrgId: lockbox.sealerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const recipientOrg = await organizationRepository.findById(prisma, input.recipientOrgId);
    if (!recipientOrg) throw ProblemError.badRequest("recipientOrgId does not reference a real organization.");

    // Fast, cheap pre-transaction rejection for the common case (same
    // discipline as rfqs/service.ts's selectQuote) — the AUTHORITATIVE
    // check is the re-read-inside-the-transaction below.
    assertValidLockboxReleaseCascade(lockbox.status);

    const keks = loadRoleKeks();

    return withTransaction(async (tx) => {
      // ADVISORY LOCK — same key/reasoning as withdraw()'s own lock
      // above (see that function's comment for the full TOCTOU analysis:
      // without this, a concurrent withdraw() and release() could each
      // read the pre-commit SEALED status, and release() could disclose
      // real plaintext to its caller from shares a concurrent withdraw()
      // was simultaneously trying to destroy — "release becomes
      // cryptographically, not just permission-check, impossible
      // afterward" (this file's own seal() doc comment, acceptance
      // criterion 6) only holds if the two can never interleave).
      // Acquired FIRST, before the status re-read AND before the share
      // read/crypto below — whichever of withdraw()/release() gets here
      // first runs its entire body (including the decrypt) to completion
      // before the other's lock acquisition is even granted.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockboxId}))`;

      // Re-read fresh INSIDE the transaction (and now inside the lock) —
      // closes the SAME check-then-act race window withdraw() guards
      // against, the other direction: a concurrent withdraw() could have
      // destroyed this lockbox's shares between the pre-checks above and
      // this transaction starting. If it did, the fresh status re-read
      // below already fails closed (WITHDRAWN can never satisfy
      // assertValidLockboxReleaseCascade) BEFORE any crypto runs.
      const freshLockbox = await lockboxRepository.findById(tx, lockboxId);
      if (!freshLockbox) throw ProblemError.internal("Lockbox disappeared mid-transaction.");
      assertValidLockboxReleaseCascade(freshLockbox.status);

      // Fetch the 2 authorizing shares FRESH inside the same transaction
      // — reads only non-destroyed (wrappedShare IS NOT NULL) rows, so a
      // just-committed withdraw() is reflected here too, not just in the
      // status check above (belt and suspenders: the status check alone
      // already prevents this path from being reached post-withdraw, but
      // the share query's own filter is an independent, structural second
      // guarantee — see lockbox-key-share.repository.ts's own comment).
      const activeShares = await lockboxKeyShareRepository.findActiveByLockboxAndRoles(tx, lockboxId, [...RELEASE_AUTHORIZING_ROLES]);
      if (activeShares.length < 2) {
        throw ProblemError.conflict(
          `Release requires ${RELEASE_AUTHORIZING_ROLES.join("+")} shares; only ${activeShares.length} active share(s) found (lockbox may have been withdrawn).`,
        );
      }

      const wrappedShares: WrappedShare[] = activeShares.map((row) => ({
        role: row.holderRole,
        index: row.shareIndex,
        wrapped: {
          ciphertext: toBuffer(row.wrappedShare!),
          iv: toBuffer(row.shareIv!),
          authTag: toBuffer(row.shareAuthTag!),
        },
      }));

      // THE REAL CRYPTOGRAPHIC RELEASE: Shamir-combines the 2 threshold
      // shares into a candidate DEK, then AES-256-GCM-decrypts the real
      // ciphertext. Throws TamperOrWrongKeyError if anything doesn't
      // check out (wrong/insufficient shares, tampered ciphertext) —
      // caught below and turned into a clean 500, never silently
      // producing a wrong/partial plaintext.
      let plaintext: Buffer;
      try {
        plaintext = releasePayload(
          {
            ciphertext: toBuffer(freshLockbox.ciphertext),
            iv: toBuffer(freshLockbox.iv),
            authTag: toBuffer(freshLockbox.authTag),
          },
          wrappedShares,
          keks,
          lockboxAad(lockboxId),
        );
      } catch (cause) {
        throw new ProblemError({
          status: 500,
          code: "internal_error",
          message: "Lockbox release failed cryptographic verification — the release was NOT performed and no plaintext was disclosed.",
          retryable: false,
          details: { cause: cause instanceof Error ? cause.name : "unknown" },
        });
      }
      const disclosedPayload = deserializePayload(plaintext);

      // The cascade: SEALED -> COMMITTED -> FROZEN -> OPENED, one
      // transaction, matching LOCKBOX_RELEASE_CASCADE exactly. Each hop
      // re-validated via assertValidLockboxTransition (the same table a
      // future standalone commit/freeze action would use).
      const startIdx = LOCKBOX_RELEASE_CASCADE.indexOf(freshLockbox.status);
      let currentStatus = freshLockbox.status;
      for (let i = startIdx; i < LOCKBOX_RELEASE_CASCADE.length - 2; i++) {
        const next = LOCKBOX_RELEASE_CASCADE[i + 1]!;
        assertValidLockboxTransition(currentStatus, next);
        await lockboxRepository.updateStatus(tx, lockboxId, next, actor.userId);
        currentStatus = next;
      }
      // Final hop (FROZEN -> OPENED) carries the release metadata in the same write.
      assertValidLockboxTransition(currentStatus, "OPENED");
      const releasedAt = new Date();
      const updatedLockbox = await lockboxRepository.markOpened(tx, lockboxId, {
        releasedAt,
        recipientOrgId: input.recipientOrgId,
        conditionRef: input.conditionRef,
        updatedByUserId: actor.userId!,
      });

      const receipt = await lockboxReceiptRepository.findLatestByLockbox(tx, lockboxId);

      const releaseEvidence = await lockboxReleaseEvidenceRepository.create(tx, {
        lockboxId,
        recipientOrgId: input.recipientOrgId,
        releasedAt,
        authorizedByUserId: actor.userId!,
        authorizedRoles: [...RELEASE_AUTHORIZING_ROLES],
        conditionRef: input.conditionRef,
        ciphertextHash: freshLockbox.ciphertextHash,
        receiptId: receipt?.id ?? null,
      });

      // SAFE-FIELD DISCIPLINE (same as seal() above): NEVER disclosedPayload here.
      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: lockbox.sealerOrgId,
        action: "lockbox.released",
        resourceType: "lockbox",
        resourceId: lockboxId,
        afterValue: {
          recipientOrgId: input.recipientOrgId,
          conditionRef: input.conditionRef,
          authorizedRoles: [...RELEASE_AUTHORIZING_ROLES],
          ciphertextHash: freshLockbox.ciphertextHash,
        },
      });
      const timeline = timelineWriter(context);
      await timeline.write(tx, {
        eventType: "lockbox.committed",
        aggregateType: "lockbox",
        aggregateId: lockboxId,
        payload: { ciphertextHash: freshLockbox.ciphertextHash },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });
      await timeline.write(tx, {
        eventType: "lockbox.opened",
        aggregateType: "lockbox",
        aggregateId: lockboxId,
        payload: {
          recipientOrgId: input.recipientOrgId,
          conditionRef: input.conditionRef,
          authorizedRoles: [...RELEASE_AUTHORIZING_ROLES],
          ciphertextHash: freshLockbox.ciphertextHash,
        },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return { lockbox: updatedLockbox, releaseEvidence, disclosedPayload };
    });
  },
};
