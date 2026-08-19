// packages/contracts/src/lockbox.ts — the spec. the P9 gate exit
// condition, wire-contracted: "Ciphertext/receipt/withdraw/release
// evidence."
//
// CRITICAL DISCIPLINE (earlier brief acceptance criterion 9): no DTO in
// this file ever carries a raw ciphertext/iv/authTag/wrapped-share byte,
// and no request/response shape here is named or typed to hold a
// plaintext DEK. `LockboxDTO` exposes `ciphertextHash` (safe, a sha256
// hex digest) — never `ciphertext` itself. The ONE deliberate exception
// is `ReleaseLockboxResponseSchema.disclosedPayload` — release's entire
// point is disclosing the sealed plaintext to an authorized caller, and
// that field is exactly and only where it appears; it is never written
// to any other DTO, and apps/api's service layer never persists it
// anywhere (see apps/api/src/modules/lockbox/service.ts's own comment on
// this exact point).

import { z } from "zod";
import { UuidSchema } from "./common.js";

export const LOCKBOX_STATUS_VALUES = [
  "DRAFT",
  "SEALED",
  "COMMITTED",
  "FROZEN",
  "OPENED",
  "MATCH_ELIGIBLE",
  "WITHDRAWN",
  "DISPUTED",
] as const;
export const LockboxStatusSchema = z.enum(LOCKBOX_STATUS_VALUES);
export type LockboxStatus = z.infer<typeof LockboxStatusSchema>;

export const LOCKBOX_RELATIONSHIP_TYPE_VALUES = [
  "ACQUIRER_RELATIONSHIP",
  "PROCESSOR_RELATIONSHIP",
  "PSP_RELATIONSHIP",
  "MERCHANT_RELATIONSHIP",
  "BANKING_RELATIONSHIP",
  "INFRASTRUCTURE_RELATIONSHIP",
  "QUALIFIED_OPPORTUNITY",
] as const;
export const LockboxRelationshipTypeSchema = z.enum(LOCKBOX_RELATIONSHIP_TYPE_VALUES);
export type LockboxRelationshipType = z.infer<typeof LockboxRelationshipTypeSchema>;

export const LOCKBOX_REGION_VALUES = ["EU", "UK", "US", "LATAM", "APAC", "MENA", "GLOBAL"] as const;
export const LockboxRegionSchema = z.enum(LOCKBOX_REGION_VALUES);
export type LockboxRegion = z.infer<typeof LockboxRegionSchema>;

export const LOCKBOX_SHARE_ROLE_VALUES = ["SEALER", "OPERATOR", "ESCROW"] as const;
export const LockboxShareRoleSchema = z.enum(LOCKBOX_SHARE_ROLE_VALUES);
export type LockboxShareRole = z.infer<typeof LockboxShareRoleSchema>;

/**
 * The structured shape of a sealed Lockbox's PLAINTEXT payload, before
 * encryption / after decryption. Ported field-for-field from the
 * reuse-reference prototype's ContributeForm
 * (../../the prototype repo/components/lockbox/ContributeForm.tsx) so
 * apps/web's SealSubmissionForm can port that component's visual
 * structure directly (earlier brief) — the ONLY thing that changes is what
 * happens to this object after the form submits: the prototype called
 * `mockSealHash()` on a stringified version of fields like these; this
 * build's apps/api encrypts the real JSON-stringified object with real
 * AES-256-GCM (ADR-0009).
 */
export const LockboxPayloadSchema = z.object({
  counterpartyPrivate: z.string().min(1).max(2000),
  evidenceSummary: z.string().min(1).max(4000),
  priorDealHistory: z.string().min(1).max(4000),
});
export type LockboxPayload = z.infer<typeof LockboxPayloadSchema>;

/**
 * Safe, non-sensitive fields only — mirrors `packages/db`'s `Lockbox`
 * model minus `iv`/`ciphertext`/`authTag`/`aad` (acceptance criterion 9).
 */
export const LockboxDTOSchema = z.object({
  id: UuidSchema,
  sealerOrgId: UuidSchema,
  relationshipType: LockboxRelationshipTypeSchema,
  region: LockboxRegionSchema,
  status: LockboxStatusSchema,
  metadataSummary: z.string().nullable(),
  ciphertextHash: z.string().length(64),
  sealedAt: z.string(),
  withdrawnAt: z.string().nullable(),
  withdrawnByUserId: UuidSchema.nullable(),
  withdrawReason: z.string().nullable(),
  recipientOrgId: UuidSchema.nullable(),
  releasedAt: z.string().nullable(),
  conditionRef: z.string().nullable(),
  createdAt: z.string(),
});
export type LockboxDTO = z.infer<typeof LockboxDTOSchema>;

/** the spec's LockboxReceipt record — proof-of-existence, independently verifiable via @tol/crypto's verifyReceipt. Never carries plaintext. */
export const LockboxReceiptDTOSchema = z.object({
  id: UuidSchema,
  lockboxId: UuidSchema,
  version: z.number().int().positive(),
  ciphertextHash: z.string().length(64),
  sealerOrgId: UuidSchema,
  sealedAt: z.string(),
  signature: z.string(),
  algorithm: z.string(),
  createdAt: z.string(),
});
export type LockboxReceiptDTO = z.infer<typeof LockboxReceiptDTOSchema>;

/** the spec's ReleaseEvent record. */
export const LockboxReleaseEvidenceDTOSchema = z.object({
  id: UuidSchema,
  lockboxId: UuidSchema,
  recipientOrgId: UuidSchema,
  releasedAt: z.string(),
  authorizedByUserId: UuidSchema,
  authorizedRoles: z.array(LockboxShareRoleSchema),
  conditionRef: z.string(),
  ciphertextHash: z.string().length(64),
  receiptId: UuidSchema.nullable(),
  createdAt: z.string(),
});
export type LockboxReleaseEvidenceDTO = z.infer<typeof LockboxReleaseEvidenceDTOSchema>;

// ---- Requests ----

export const SealLockboxRequestSchema = z.object({
  relationshipType: LockboxRelationshipTypeSchema,
  region: LockboxRegionSchema,
  metadataSummary: z.string().max(200).optional(),
  payload: LockboxPayloadSchema,
});
export type SealLockboxRequest = z.infer<typeof SealLockboxRequestSchema>;

export const WithdrawLockboxRequestSchema = z.object({
  withdrawReason: z.string().max(1000).optional(),
});
export type WithdrawLockboxRequest = z.infer<typeof WithdrawLockboxRequestSchema>;

/**
 * `conditionRef` is a required UUID this pass — structurally validated
 * (format only), not cross-checked against a live DealCondition row yet
 * (ADR-0009's documented "thin but honest" scope cut — same
 * discipline as D8 part 2's Opportunity/CapacityProfile). No
 * `authorizedRoles` field: this build's release always combines
 * OPERATOR+ESCROW server-side (the "escrowed" path, no fresh sealer
 * cooperation required, matching ADR-0001) — the general 2-of-3
 * flexibility is proven at the packages/crypto layer
 * (envelope.test.ts), not re-exposed as a client-choosable API parameter
 * this pass.
 */
export const ReleaseLockboxRequestSchema = z.object({
  recipientOrgId: UuidSchema,
  conditionRef: UuidSchema,
});
export type ReleaseLockboxRequest = z.infer<typeof ReleaseLockboxRequestSchema>;

/**
 * Release's response — the ONE place `disclosedPayload` (real plaintext)
 * ever appears on the wire, returned only to the already-authz-gated
 * caller of a successful release (earlier brief: "Discloses plaintext ONLY
 * to the authorized recipient").
 */
export const ReleaseLockboxResponseSchema = z.object({
  lockbox: LockboxDTOSchema,
  releaseEvidence: LockboxReleaseEvidenceDTOSchema,
  disclosedPayload: LockboxPayloadSchema,
});
export type ReleaseLockboxResponse = z.infer<typeof ReleaseLockboxResponseSchema>;

export const ListLockboxesResponseSchema = z.object({ lockboxes: z.array(LockboxDTOSchema) });
export type ListLockboxesResponse = z.infer<typeof ListLockboxesResponseSchema>;
