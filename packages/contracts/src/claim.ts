// packages/contracts/src/claim.ts — the spec/p.18. the P10 gate exit
// condition, wire-contracted: "Claim scoring + dispute path."
//
// EXPLAINABILITY DISCIPLINE: ClaimScoreBreakdownSchema mirrors
// @tol/attribution's own ClaimScoreBreakdown field-for-field — the wire
// response carries the SAME per-factor/per-evidence-item breakdown the
// engine computed, never just a bare total (ADR-0004: deterministic,
// explainable, rule-based scoring — a black-box score would fail this
// gate). `computedAt` deliberately still doesn't exist anywhere (see
// @tol/attribution's own header comment) — `Claim.scoredAt` is the wire
// analog, carried on `ClaimDTO`, not duplicated onto the breakdown object.

import { z } from "zod";
import { UuidSchema } from "./common.js";

export const DIRECTNESS_TIER_VALUES = ["D5", "D4", "D3", "D2", "D1", "D0"] as const;
export const DirectnessTierSchema = z.enum(DIRECTNESS_TIER_VALUES);
export type DirectnessTier = z.infer<typeof DirectnessTierSchema>;

export const CLAIM_EVIDENCE_TYPE_VALUES = ["CONTRACT", "COUNTERPARTY_ACKNOWLEDGMENT", "EMAIL_THREAD", "CRM_RECORD", "OTHER"] as const;
export const ClaimEvidenceTypeSchema = z.enum(CLAIM_EVIDENCE_TYPE_VALUES);
export type ClaimEvidenceType = z.infer<typeof ClaimEvidenceTypeSchema>;

export const EVIDENCE_VERIFICATION_STATE_VALUES = [
  "SELF_REPORTED",
  "DOCUMENT_EXTRACTED",
  "API_VERIFIED",
  "COUNTERPARTY_CONFIRMED",
  "OPERATOR_VERIFIED",
] as const;
export const EvidenceVerificationStateSchema = z.enum(EVIDENCE_VERIFICATION_STATE_VALUES);
export type EvidenceVerificationState = z.infer<typeof EvidenceVerificationStateSchema>;

export const CLAIM_STATUS_VALUES = ["FILED", "SCORED", "VERIFIED", "PARTIAL", "DISPUTED", "REJECTED", "EXPIRED", "WITHDRAWN"] as const;
export const ClaimStatusSchema = z.enum(CLAIM_STATUS_VALUES);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const CLAIM_DISPUTE_STATUS_VALUES = ["OPEN", "DECIDED"] as const;
export const ClaimDisputeStatusSchema = z.enum(CLAIM_DISPUTE_STATUS_VALUES);
export type ClaimDisputeStatus = z.infer<typeof ClaimDisputeStatusSchema>;

export const CLAIM_DISPUTE_RESOLUTION_VALUES = ["UPHELD_ORIGINAL", "PARTIAL_ATTRIBUTION", "REJECTED_ORIGINAL"] as const;
export const ClaimDisputeResolutionSchema = z.enum(CLAIM_DISPUTE_RESOLUTION_VALUES);
export type ClaimDisputeResolution = z.infer<typeof ClaimDisputeResolutionSchema>;

export const CLAIM_DECISION_OUTCOME_VALUES = ["VERIFIED", "PARTIAL", "REJECTED"] as const;
export const ClaimDecisionOutcomeSchema = z.enum(CLAIM_DECISION_OUTCOME_VALUES);
export type ClaimDecisionOutcome = z.infer<typeof ClaimDecisionOutcomeSchema>;

export const CLAIM_APPEAL_STATUS_VALUES = ["NONE", "PENDING", "GRANTED", "DENIED"] as const;
export const ClaimAppealStatusSchema = z.enum(CLAIM_APPEAL_STATUS_VALUES);
export type ClaimAppealStatus = z.infer<typeof ClaimAppealStatusSchema>;

/** the spec's ClaimScope dimensions not already covered by Claim.subjectOrgId/opportunityId — "organization/product/geography/channel/opportunity". Every field optional; an empty object is a valid (maximally broad) scope. */
export const ClaimScopeSchema = z
  .object({
    geography: z.string().max(100).optional(),
    channel: z.string().max(100).optional(),
    product: z.string().max(100).optional(),
    programId: z.string().max(200).optional(),
  })
  .strict();
export type ClaimScope = z.infer<typeof ClaimScopeSchema>;

/** One item of the evidence array a claimant submits with a claim. */
export const ClaimEvidenceItemInputSchema = z.object({
  evidenceType: ClaimEvidenceTypeSchema,
  assertedFact: z.string().min(1).max(2000),
  verificationState: EvidenceVerificationStateSchema.optional(),
  evidenceRef: z.string().max(500).optional(),
});
export type ClaimEvidenceItemInput = z.infer<typeof ClaimEvidenceItemInputSchema>;

export const ClaimEvidenceDTOSchema = z.object({
  id: UuidSchema,
  claimId: UuidSchema,
  evidenceType: ClaimEvidenceTypeSchema,
  assertedFact: z.string(),
  verificationState: EvidenceVerificationStateSchema,
  evidenceRef: z.string().nullable(),
  createdAt: z.string(),
});
export type ClaimEvidenceDTO = z.infer<typeof ClaimEvidenceDTOSchema>;

/** Mirrors @tol/attribution's ClaimEvidenceContribution field-for-field — the per-item explainability. */
export const ClaimEvidenceContributionSchema = z.object({
  index: z.number().int(),
  evidenceType: ClaimEvidenceTypeSchema,
  verificationState: EvidenceVerificationStateSchema,
  basePoints: z.number(),
  multiplier: z.number(),
  contribution: z.number(),
});

/** Mirrors @tol/attribution's ClaimScoreBreakdown field-for-field (see this file's header comment). */
export const ClaimScoreBreakdownSchema = z.object({
  history: z.number(),
  proximity: z.number(),
  evidence: z.number(),
  time: z.number(),
  weighted: z.number(),
  total: z.number(),
  cappedFrom: z.number().optional(),
  evidenceRawTotal: z.number().optional(),
  evidenceBreakdown: z.array(ClaimEvidenceContributionSchema),
  algorithmVersion: z.string(),
  inputVersions: z.array(z.string()),
});
export type ClaimScoreBreakdown = z.infer<typeof ClaimScoreBreakdownSchema>;

/** Safe fields only — every field here is intended for the claimant, the subject org, and any reviewer with claim.read; there is no separate "restricted" ClaimDTO variant this pass (unlike Lockbox's ciphertext/plaintext split — a Claim has no analogous secret-vs-safe field split, its RESTRICTED privacyClass governs who reaches this DTO at all, not which fields within it). */
export const ClaimDTOSchema = z.object({
  id: UuidSchema,
  claimantOrgId: UuidSchema,
  claimantUserId: UuidSchema,
  subjectOrgId: UuidSchema,
  relationshipType: z.string(),
  directnessTier: DirectnessTierSchema,
  opportunityId: UuidSchema.nullable(),
  claimScope: ClaimScopeSchema,
  status: ClaimStatusSchema,
  priorCommercialHistoryMonths: z.number().int(),
  submissionLagDays: z.number().int(),
  scoreBreakdown: ClaimScoreBreakdownSchema.nullable(),
  scoreTotal: z.number().nullable(),
  algorithmVersion: z.string().nullable(),
  inputVersions: z.array(z.string()),
  scoredAt: z.string().nullable(),
  provisionalExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ClaimDTO = z.infer<typeof ClaimDTOSchema>;

export const ClaimDecisionDTOSchema = z.object({
  id: UuidSchema,
  claimId: UuidSchema,
  disputeId: UuidSchema.nullable(),
  decision: ClaimDecisionOutcomeSchema,
  scoreBreakdown: ClaimScoreBreakdownSchema,
  algorithmVersion: z.string(),
  ruleVersion: z.string(),
  reviewerUserId: UuidSchema,
  reviewerOrgId: UuidSchema,
  reason: z.string(),
  appealStatus: ClaimAppealStatusSchema,
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  createdAt: z.string(),
});
export type ClaimDecisionDTO = z.infer<typeof ClaimDecisionDTOSchema>;

export const ClaimDisputeEvidenceItemSchema = z.object({ evidenceType: z.string().max(100).optional(), note: z.string().max(2000) }).catchall(z.unknown());

export const ClaimDisputeDTOSchema = z.object({
  id: UuidSchema,
  claimId: UuidSchema,
  challengerOrgId: UuidSchema,
  challengerUserId: UuidSchema,
  basis: z.string(),
  evidence: z.array(z.record(z.string(), z.unknown())),
  status: ClaimDisputeStatusSchema,
  resolution: ClaimDisputeResolutionSchema.nullable(),
  createdAt: z.string(),
});
export type ClaimDisputeDTO = z.infer<typeof ClaimDisputeDTOSchema>;

/** Mirrors @tol/attribution's ClaimRankEntry — populated ONLY for reviewer-tier callers (see apps/api's claims service); a claimant-side actor never sees a competing claim's rank/total, matching the spec's "cannot inspect private competing records". */
export const ClaimRankEntrySchema = z.object({
  claimId: UuidSchema,
  rank: z.number().int().positive(),
  total: z.number(),
  tiedWith: z.array(UuidSchema),
});
export type ClaimRankEntry = z.infer<typeof ClaimRankEntrySchema>;

// ---- Requests ----

export const CreateClaimRequestSchema = z.object({
  subjectOrgId: UuidSchema,
  relationshipType: z.string().min(1).max(100),
  directnessTier: DirectnessTierSchema,
  opportunityId: UuidSchema.optional(),
  claimScope: ClaimScopeSchema.optional(),
  priorCommercialHistoryMonths: z.number().int().min(0).max(600),
  submissionLagDays: z.number().int().min(0).max(3650),
  evidenceItems: z.array(ClaimEvidenceItemInputSchema).max(50),
});
export type CreateClaimRequest = z.infer<typeof CreateClaimRequestSchema>;

export const FileClaimDisputeRequestSchema = z.object({
  basis: z.string().min(1).max(2000),
  evidence: z.array(ClaimDisputeEvidenceItemSchema).max(50).optional(),
});
export type FileClaimDisputeRequest = z.infer<typeof FileClaimDisputeRequestSchema>;

/** No `disputeId` field — the server determines whether this decision resolves a fresh SCORED claim or the claim's current OPEN dispute purely from the claim's own current status (see apps/api's claims service `decide()`), never from client-supplied state. */
export const DecideClaimRequestSchema = z.object({
  decision: ClaimDecisionOutcomeSchema,
  reason: z.string().min(1).max(2000),
});
export type DecideClaimRequest = z.infer<typeof DecideClaimRequestSchema>;

// ---- Responses ----

export const ListClaimsResponseSchema = z.object({ claims: z.array(ClaimDTOSchema) });
export type ListClaimsResponse = z.infer<typeof ListClaimsResponseSchema>;

export const ClaimDetailResponseSchema = z.object({
  claim: ClaimDTOSchema,
  evidence: z.array(ClaimEvidenceDTOSchema),
  decisions: z.array(ClaimDecisionDTOSchema),
  disputes: z.array(ClaimDisputeDTOSchema),
  /** null for claimant-side callers (own claim, no competing-claim visibility) and whenever no competing claims exist at all; populated for reviewer-tier callers. */
  rank: ClaimRankEntrySchema.nullable(),
});
export type ClaimDetailResponse = z.infer<typeof ClaimDetailResponseSchema>;
