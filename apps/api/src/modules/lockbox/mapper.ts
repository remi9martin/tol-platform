// apps/api/src/modules/lockbox/mapper.ts
//
// the spec. Same "mapper never queries, services decide access/scope"
// division of labor as every other mapper in this codebase (see
// rfqs/mapper.ts). CRITICAL: toLockboxDTO below intentionally has NO
// parameter and NO code path that could ever include `iv`/`ciphertext`/
// `authTag`/`aad` — acceptance criterion 9, grep-verifiable at this exact
// file.

import type { Lockbox, LockboxReceipt, LockboxReleaseEvidence } from "@tol/db";
import type { LockboxDTO, LockboxReceiptDTO, LockboxReleaseEvidenceDTO } from "@tol/contracts";

export function toLockboxDTO(lockbox: Lockbox): LockboxDTO {
  return {
    id: lockbox.id,
    sealerOrgId: lockbox.sealerOrgId,
    relationshipType: lockbox.relationshipType,
    region: lockbox.region,
    status: lockbox.status,
    metadataSummary: lockbox.metadataSummary,
    ciphertextHash: lockbox.ciphertextHash,
    sealedAt: lockbox.sealedAt.toISOString(),
    withdrawnAt: lockbox.withdrawnAt ? lockbox.withdrawnAt.toISOString() : null,
    withdrawnByUserId: lockbox.withdrawnByUserId,
    withdrawReason: lockbox.withdrawReason,
    recipientOrgId: lockbox.recipientOrgId,
    releasedAt: lockbox.releasedAt ? lockbox.releasedAt.toISOString() : null,
    conditionRef: lockbox.conditionRef,
    createdAt: lockbox.createdAt.toISOString(),
  };
}

export function toLockboxReceiptDTO(receipt: LockboxReceipt): LockboxReceiptDTO {
  return {
    id: receipt.id,
    lockboxId: receipt.lockboxId,
    version: receipt.version,
    ciphertextHash: receipt.ciphertextHash,
    sealerOrgId: receipt.sealerOrgId,
    sealedAt: receipt.sealedAt.toISOString(),
    signature: receipt.signature,
    algorithm: receipt.algorithm,
    createdAt: receipt.createdAt.toISOString(),
  };
}

export function toLockboxReleaseEvidenceDTO(evidence: LockboxReleaseEvidence): LockboxReleaseEvidenceDTO {
  return {
    id: evidence.id,
    lockboxId: evidence.lockboxId,
    recipientOrgId: evidence.recipientOrgId,
    releasedAt: evidence.releasedAt.toISOString(),
    authorizedByUserId: evidence.authorizedByUserId,
    authorizedRoles: evidence.authorizedRoles as LockboxReleaseEvidenceDTO["authorizedRoles"],
    conditionRef: evidence.conditionRef,
    ciphertextHash: evidence.ciphertextHash,
    receiptId: evidence.receiptId,
    createdAt: evidence.createdAt.toISOString(),
  };
}
