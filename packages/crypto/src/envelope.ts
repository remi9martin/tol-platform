// packages/crypto/src/envelope.ts
//
// High-level Lockbox envelope operations — the module apps/api's lockbox
// service imports directly for seal/release (aes-gcm.ts, shamir.ts,
// gf256.ts are its implementation, still exported from index.ts so unit
// tests and docs/adr/0009-lockbox-crypto.md's "how this works" narrative
// can address them directly).
//
// SEAL: payload -> fresh random DEK -> AES-256-GCM encrypt payload under
// DEK -> split DEK into LOCKBOX_SHARE_TOTAL Shamir shares (SEALER/
// OPERATOR/ESCROW roles, threshold LOCKBOX_SHARE_THRESHOLD) -> wrap
// (AES-256-GCM, again) each share under its own role-specific KEK. The
// DEK itself is never returned, logged, or persisted anywhere by this
// function (acceptance criteria 2 and 9) — only sealPayload's return
// value (ciphertext + wrapped shares + safe hash) is meant to be
// persisted; the DEK buffer is explicitly zeroed before this function
// returns (best-effort defense in depth — see the comment at the zero
// site for what this does and doesn't guarantee).
//
// RELEASE: >= LOCKBOX_SHARE_THRESHOLD wrapped shares (by role) + the KEKs
// to unwrap them -> unwrap each share -> Shamir-combine -> candidate DEK
// -> AES-256-GCM decrypt the payload. If fewer than the true threshold's
// worth of VALID shares were supplied, or any wrapped share/KEK/
// ciphertext was tampered with, this throws TamperOrWrongKeyError or
// InsufficientSharesError — it never returns partial or wrong plaintext
// silently accepted as real (see errors.ts).
//
// Role assignment (SEALER=1, OPERATOR=2, ESCROW=3) is fixed and never
// reordered — see roleToIndex/indexToRole below — so a share's Shamir
// x-coordinate always identifies which role it belongs to, both
// directions, without needing a separate lookup table anywhere else in
// the codebase.

import { createHash } from "node:crypto";
import { type AesGcmCiphertext, decrypt, encrypt, generateKey } from "./aes-gcm.js";
import { InsufficientSharesError } from "./errors.js";
import { combineShares, splitSecret, type ShamirShare } from "./shamir.js";

export const LOCKBOX_SHARE_ROLES = ["SEALER", "OPERATOR", "ESCROW"] as const;
export type LockboxShareRole = (typeof LOCKBOX_SHARE_ROLES)[number];

/** Any 2 of the 3 roles reconstruct the DEK — "escrowed" release in practice combines OPERATOR+ESCROW (no fresh sealer cooperation required, matching D1's "TOL... can release" framing); SEALER+OPERATOR (a cooperative early-release path) and SEALER+ESCROW are equally valid combinations cryptographically. See docs/adr/0009-lockbox-crypto.md. */
export const LOCKBOX_SHARE_THRESHOLD = 2;
export const LOCKBOX_SHARE_TOTAL = 3;

export interface WrappedShare {
  role: LockboxShareRole;
  /** Shamir x-coordinate, 1..3 — see roleToIndex. */
  index: number;
  /** The share's y-values, AES-256-GCM-encrypted under that role's KEK. */
  wrapped: AesGcmCiphertext;
}

export interface SealedEnvelope {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** sha256(ciphertext), hex — safe to persist/audit/log (acceptance criterion 9). */
  ciphertextHash: string;
  shares: WrappedShare[];
}

export interface RoleKeks {
  SEALER: Buffer;
  OPERATOR: Buffer;
  ESCROW: Buffer;
}

function roleToIndex(role: LockboxShareRole): number {
  return LOCKBOX_SHARE_ROLES.indexOf(role) + 1;
}
function indexToRole(index: number): LockboxShareRole {
  const role = LOCKBOX_SHARE_ROLES[index - 1];
  if (!role) throw new RangeError(`indexToRole: no role for index ${index}`);
  return role;
}

/**
 * Seals `plaintext`: generates a fresh DEK, encrypts under it, splits the
 * DEK into LOCKBOX_SHARE_TOTAL Shamir shares (threshold
 * LOCKBOX_SHARE_THRESHOLD), wraps each share under its role's KEK from
 * `keks`. Pass `aad` as the lockbox's own ID (UTF-8 bytes) once one
 * exists — binds the ciphertext to that specific record so it can never
 * be silently swapped onto a different row's metadata even if both
 * happened to share a DEK (they never do, but AAD makes the binding
 * explicit and verified rather than merely-true-by-construction).
 */
export function sealPayload(plaintext: Buffer, keks: RoleKeks, aad?: Buffer): SealedEnvelope {
  const dek = generateKey();
  try {
    const { iv, ciphertext, authTag } = encrypt(plaintext, dek, aad);
    const ciphertextHash = createHash("sha256").update(ciphertext).digest("hex");

    const rawShares = splitSecret(dek, LOCKBOX_SHARE_THRESHOLD, LOCKBOX_SHARE_TOTAL);
    const shares: WrappedShare[] = rawShares.map((share) => {
      const role = indexToRole(share.index);
      const wrapped = encrypt(share.ys, keks[role]);
      return { role, index: share.index, wrapped };
    });

    return { ciphertext, iv, authTag, ciphertextHash, shares };
  } finally {
    // Best-effort scrub: overwrites this function's own reference to the
    // DEK bytes once neither encrypt() nor splitSecret() need it anymore.
    // This is defense in depth, not a hard guarantee — V8 may have made
    // additional copies during `randomBytes`/Buffer operations above that
    // this cannot reach, and Node has no guaranteed-secure-erase primitive
    // for arbitrary past copies. Documented as such in
    // docs/adr/0009-lockbox-crypto.md rather than oversold as a real
    // memory-safety boundary.
    dek.fill(0);
  }
}

/**
 * Releases (decrypts) a sealed payload given >= LOCKBOX_SHARE_THRESHOLD
 * wrapped shares (distinct roles) and the KEKs to unwrap them.
 *
 * Throws InsufficientSharesError if fewer than 2 DISTINCT roles are
 * supplied — a structural check, before any cryptographic work runs.
 * Throws TamperOrWrongKeyError if a share fails to unwrap under its
 * claimed role's KEK, OR if the reconstructed DEK is wrong, OR if the
 * ciphertext itself was tampered with — this is the actual cryptographic
 * enforcement of the threshold property (see shamir.ts's combineShares
 * doc comment for why an under-threshold combine doesn't throw by
 * itself; this function's downstream AES-GCM decrypt calls are what turn
 * "wrong/insufficient key material" into a hard, fail-closed failure).
 */
export function releasePayload(
  envelope: Pick<SealedEnvelope, "ciphertext" | "iv" | "authTag">,
  wrappedShares: WrappedShare[],
  keks: RoleKeks,
  aad?: Buffer,
): Buffer {
  if (wrappedShares.length < LOCKBOX_SHARE_THRESHOLD) {
    throw new InsufficientSharesError(
      `releasePayload: need at least ${LOCKBOX_SHARE_THRESHOLD} shares, got ${wrappedShares.length}`,
    );
  }
  const roles = new Set(wrappedShares.map((s) => s.role));
  if (roles.size < wrappedShares.length) {
    throw new InsufficientSharesError("releasePayload: duplicate share roles supplied");
  }

  const unwrapped: ShamirShare[] = wrappedShares.map((s) => ({
    index: s.index,
    ys: decrypt(s.wrapped, keks[s.role]), // throws TamperOrWrongKeyError here if the wrong KEK is used for this role, or the wrapped share was tampered with
  }));

  const dek = combineShares(unwrapped);
  try {
    return decrypt({ ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.authTag }, dek, aad);
  } finally {
    dek.fill(0); // see sealPayload's matching comment — best-effort, not a hard guarantee
  }
}

export { roleToIndex, indexToRole };
