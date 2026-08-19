// packages/contracts/src/passport.ts — the spec (P6 Passport gate).
//
// EXPLAINABILITY DISCIPLINE (same as claim.ts's own header comment):
// ReadinessResultDTO mirrors @tol/evidence's ReadinessResultShape
// field-for-field — the wire response carries the SAME named
// blockers/warnings the engine computed, never just a bare score
// (p.29: "user can see exactly what blocks readiness and which
// evidence will cure it").

import { z } from "zod";
import { DisclosureClassSchema, UuidSchema } from "./common.js";

export const PASSPORT_STATUS_VALUES = ["DRAFT", "INCOMPLETE", "READY", "VERIFIED", "STALE", "SUSPENDED"] as const;
export const PassportStatusSchema = z.enum(PASSPORT_STATUS_VALUES);
export type PassportStatus = z.infer<typeof PassportStatusSchema>;

export const PASSPORT_SECTION_TYPE_VALUES = ["IDENTITY", "RELATIONSHIP_HISTORY", "PROCESSING_METRICS", "RISK", "COMMERCIAL", "TECHNICAL"] as const;
export const PassportSectionTypeSchema = z.enum(PASSPORT_SECTION_TYPE_VALUES);
export type PassportSectionType = z.infer<typeof PassportSectionTypeSchema>;

export const FACT_PROVENANCE_VALUES = [
  "SELF_REPORTED",
  "DOCUMENT_EXTRACTED",
  "API_VERIFIED",
  "COUNTERPARTY_CONFIRMED",
  "OPERATOR_VERIFIED",
  "OUTCOME_LEARNED",
  "INFERRED",
] as const;
export const FactProvenanceSchema = z.enum(FACT_PROVENANCE_VALUES);
export type FactProvenance = z.infer<typeof FactProvenanceSchema>;

export const EVIDENCE_SOURCE_KIND_VALUES = ["FILE", "API", "ATTESTATION"] as const;
export const EvidenceSourceKindSchema = z.enum(EVIDENCE_SOURCE_KIND_VALUES);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKindSchema>;

export const FactDTOSchema = z.object({
  id: UuidSchema,
  passportId: UuidSchema,
  sectionType: PassportSectionTypeSchema,
  fieldKey: z.string(),
  /** Polymorphic (string/number/boolean/small object) — see @tol/db's Fact.normalizedValue comment. */
  normalizedValue: z.unknown(),
  verification: FactProvenanceSchema,
  evidenceId: UuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FactDTO = z.infer<typeof FactDTOSchema>;

export const EvidenceDTOSchema = z.object({
  id: UuidSchema,
  passportId: UuidSchema,
  type: EvidenceSourceKindSchema,
  objectRef: z.string(),
  checksum: z.string().nullable(),
  issuer: z.string().nullable(),
  collectedAt: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EvidenceDTO = z.infer<typeof EvidenceDTOSchema>;

const ReadinessItemSchema = z.object({ fieldKey: z.string(), sectionType: PassportSectionTypeSchema, message: z.string() });

/** Mirrors @tol/evidence's ReadinessResultShape field-for-field (see this file's header comment). */
export const ReadinessResultDTOSchema = z.object({
  id: UuidSchema,
  passportId: UuidSchema,
  score: z.number(),
  blockers: z.array(ReadinessItemSchema),
  warnings: z.array(ReadinessItemSchema),
  ruleVersion: z.string(),
  algorithmVersion: z.string(),
  inputVersions: z.array(z.string()),
  computedAt: z.string(),
});
export type ReadinessResultDTO = z.infer<typeof ReadinessResultDTOSchema>;

export const PassportDTOSchema = z.object({
  id: UuidSchema,
  organizationId: UuidSchema,
  status: PassportStatusSchema,
  privacyClass: DisclosureClassSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PassportDTO = z.infer<typeof PassportDTOSchema>;

// ---- Requests ----

/** No body fields — the Passport is always created for the ACTOR's own organization (never client-supplied), matching every other own-org create endpoint in this codebase (e.g. capacity.create). */
export const CreatePassportRequestSchema = z.object({}).strict();
export type CreatePassportRequest = z.infer<typeof CreatePassportRequestSchema>;

export const UpsertFactRequestSchema = z.object({
  sectionType: PassportSectionTypeSchema,
  fieldKey: z.string().min(1).max(200),
  normalizedValue: z.unknown(),
  verification: FactProvenanceSchema.optional(),
  evidenceId: UuidSchema.optional(),
});
export type UpsertFactRequest = z.infer<typeof UpsertFactRequestSchema>;

export const CreateEvidenceRequestSchema = z.object({
  type: EvidenceSourceKindSchema,
  objectRef: z.string().min(1).max(2000),
  checksum: z.string().max(200).optional(),
  issuer: z.string().max(300).optional(),
  collectedAt: z.string(),
  expiresAt: z.string().optional(),
});
export type CreateEvidenceRequest = z.infer<typeof CreateEvidenceRequestSchema>;

export const VerifyPassportRequestSchema = z.object({
  reason: z.string().min(1).max(2000),
});
export type VerifyPassportRequest = z.infer<typeof VerifyPassportRequestSchema>;

// ---- Responses ----

export const ListPassportsResponseSchema = z.object({ passports: z.array(PassportDTOSchema) });
export type ListPassportsResponse = z.infer<typeof ListPassportsResponseSchema>;

export const PassportDetailResponseSchema = z.object({
  passport: PassportDTOSchema,
  facts: z.array(FactDTOSchema),
  evidence: z.array(EvidenceDTOSchema),
  /** null only before the very first fact/evidence mutation ever runs computeReadiness — every real Passport past creation has at least one ReadinessResult (create() computes one immediately, matching Claim's file-then-score-atomically precedent). */
  readiness: ReadinessResultDTOSchema.nullable(),
});
export type PassportDetailResponse = z.infer<typeof PassportDetailResponseSchema>;
