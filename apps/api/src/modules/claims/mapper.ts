// apps/api/src/modules/claims/mapper.ts
//
// the spec/p.18. Same "mapper never queries, services decide access/
// scope" division of labor as every other mapper in this codebase (see
// lockbox/mapper.ts). Json columns (claimScope/scoreBreakdown/
// inputVersions/evidence) are cast to their typed contract shapes here —
// @tol/contracts' Zod schemas are the wire CONTRACT, not re-validated on
// the way OUT (only on the way IN, at the route layer, same convention
// as every other mapper).

import type { Claim, ClaimDecision, ClaimDispute, ClaimEvidence } from "@tol/db";
import type { ClaimDTO, ClaimDecisionDTO, ClaimDisputeDTO, ClaimEvidenceDTO, ClaimRankEntry, ClaimScope, ClaimScoreBreakdown } from "@tol/contracts";
import type { ClaimRankEntry as AttributionClaimRankEntry } from "@tol/attribution";

export function toClaimDTO(claim: Claim): ClaimDTO {
  return {
    id: claim.id,
    claimantOrgId: claim.claimantOrgId,
    claimantUserId: claim.claimantUserId,
    subjectOrgId: claim.subjectOrgId,
    relationshipType: claim.relationshipType,
    directnessTier: claim.directnessTier,
    opportunityId: claim.opportunityId,
    claimScope: claim.claimScope as ClaimScope,
    status: claim.status,
    priorCommercialHistoryMonths: claim.priorCommercialHistoryMonths,
    submissionLagDays: claim.submissionLagDays,
    scoreBreakdown: claim.scoreBreakdown as ClaimScoreBreakdown | null,
    scoreTotal: claim.scoreTotal,
    algorithmVersion: claim.algorithmVersion,
    inputVersions: (claim.inputVersions as string[] | null) ?? [],
    scoredAt: claim.scoredAt ? claim.scoredAt.toISOString() : null,
    provisionalExpiresAt: claim.provisionalExpiresAt ? claim.provisionalExpiresAt.toISOString() : null,
    createdAt: claim.createdAt.toISOString(),
  };
}

export function toClaimEvidenceDTO(evidence: ClaimEvidence): ClaimEvidenceDTO {
  return {
    id: evidence.id,
    claimId: evidence.claimId,
    evidenceType: evidence.evidenceType,
    assertedFact: evidence.assertedFact,
    verificationState: evidence.verificationState,
    evidenceRef: evidence.evidenceRef,
    createdAt: evidence.createdAt.toISOString(),
  };
}

export function toClaimDecisionDTO(decision: ClaimDecision): ClaimDecisionDTO {
  return {
    id: decision.id,
    claimId: decision.claimId,
    disputeId: decision.disputeId,
    decision: decision.decision,
    scoreBreakdown: decision.scoreBreakdown as ClaimScoreBreakdown,
    algorithmVersion: decision.algorithmVersion,
    ruleVersion: decision.ruleVersion,
    reviewerUserId: decision.reviewerUserId,
    reviewerOrgId: decision.reviewerOrgId,
    reason: decision.reason,
    appealStatus: decision.appealStatus,
    effectiveFrom: decision.effectiveFrom.toISOString(),
    effectiveTo: decision.effectiveTo ? decision.effectiveTo.toISOString() : null,
    createdAt: decision.createdAt.toISOString(),
  };
}

export function toClaimDisputeDTO(dispute: ClaimDispute): ClaimDisputeDTO {
  return {
    id: dispute.id,
    claimId: dispute.claimId,
    challengerOrgId: dispute.challengerOrgId,
    challengerUserId: dispute.challengerUserId,
    basis: dispute.basis,
    evidence: dispute.evidence as Record<string, unknown>[],
    status: dispute.status,
    resolution: dispute.resolution,
    createdAt: dispute.createdAt.toISOString(),
  };
}

export function toClaimRankEntryDTO(entry: AttributionClaimRankEntry): ClaimRankEntry {
  return { claimId: entry.claimId, rank: entry.rank, total: entry.total, tiedWith: [...entry.tiedWith] };
}
