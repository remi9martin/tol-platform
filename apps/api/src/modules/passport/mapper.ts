// apps/api/src/modules/passport/mapper.ts
//
// the spec (P6 Passport). No redactFields() call here — unlike
// organizations/mapper.ts, a Passport's OWN detail view has no
// per-field disclosure split within this pass's scope (its whole-record
// `privacyClass` governs who reaches passport.read at all, same
// "no analogous secret-vs-safe field split" precedent claim.ts's own
// header comment already established for ClaimDTO). The marketplace's
// ANONYMIZED view is a completely different DTO shape produced by
// marketplace/mapper.ts, never this one.

import type { Evidence, Fact, Passport, ReadinessResult } from "@tol/db";
import type { EvidenceDTO, FactDTO, PassportDetailResponse, PassportDTO, ReadinessResultDTO } from "@tol/contracts";

export function toPassportDTO(passport: Passport): PassportDTO {
  return {
    id: passport.id,
    organizationId: passport.organizationId,
    status: passport.status,
    privacyClass: passport.privacyClass,
    createdAt: passport.createdAt.toISOString(),
    updatedAt: passport.updatedAt.toISOString(),
  };
}

export function toFactDTO(fact: Fact): FactDTO {
  return {
    id: fact.id,
    passportId: fact.passportId,
    sectionType: fact.sectionType,
    fieldKey: fact.fieldKey,
    normalizedValue: fact.normalizedValue,
    verification: fact.verification,
    evidenceId: fact.evidenceId,
    createdAt: fact.createdAt.toISOString(),
    updatedAt: fact.updatedAt.toISOString(),
  };
}

export function toEvidenceDTO(evidence: Evidence): EvidenceDTO {
  return {
    id: evidence.id,
    passportId: evidence.passportId,
    type: evidence.type,
    objectRef: evidence.objectRef,
    checksum: evidence.checksum,
    issuer: evidence.issuer,
    collectedAt: evidence.collectedAt.toISOString(),
    expiresAt: evidence.expiresAt ? evidence.expiresAt.toISOString() : null,
    createdAt: evidence.createdAt.toISOString(),
  };
}

export function toReadinessResultDTO(result: ReadinessResult): ReadinessResultDTO {
  return {
    id: result.id,
    passportId: result.passportId,
    score: result.score,
    blockers: result.blockers as ReadinessResultDTO["blockers"],
    warnings: result.warnings as ReadinessResultDTO["warnings"],
    ruleVersion: result.ruleVersion,
    algorithmVersion: result.algorithmVersion,
    inputVersions: (result.inputVersions as string[] | null) ?? [],
    computedAt: result.computedAt.toISOString(),
  };
}

export function toPassportDetailResponse(
  passport: Passport,
  facts: Fact[],
  evidence: Evidence[],
  readiness: ReadinessResult | null,
): PassportDetailResponse {
  return {
    passport: toPassportDTO(passport),
    facts: facts.map(toFactDTO),
    evidence: evidence.map(toEvidenceDTO),
    readiness: readiness ? toReadinessResultDTO(readiness) : null,
  };
}
