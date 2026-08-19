// packages/db/src/repositories/evidence.repository.ts
//
// the spec: "Evidence || File/API/attestation source || type,
// objectRef, checksum, issuer, collectedAt, expiresAt." APPEND-ONLY — no
// `update` function exists here at all (deliberately, matching
// schema.prisma's Evidence model comment: p.14 verbatim, "Replacing a
// document does not erase the prior evidence version"). A refreshed
// document is always a NEW row via `create`; the caller (apps/api's
// passport service) is responsible for repointing the relevant Fact's
// `evidenceId` at the new row afterward via factRepository's own
// upsertByFieldKey.

import type { DisclosureClass, Evidence, EvidenceSourceKind, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface CreateEvidenceInput {
  passportId: string;
  type: EvidenceSourceKind;
  objectRef: string;
  checksum?: string | null;
  issuer?: string | null;
  collectedAt: Date;
  expiresAt?: Date | null;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const evidenceRepository = {
  async findById(db: DbClient, id: string): Promise<Evidence | null> {
    return db.evidence.findUnique({ where: { id } });
  },

  /**
   * Full history for a passport, newest first — includes superseded rows
   * a Fact no longer points at, per this file's own append-only header
   * note. `take: 500` is a defensive cap, not a real pagination story —
   * same precedent as claimRepository.listBySubject's identical cap
   * (added here after review-
   * evidence, review, flagged the original unbounded query;
   * realistic per-passport evidence counts are single/low-double digits,
   * so 500 is generous headroom against a pathological case without
   * truncating any plausible real one).
   */
  async listByPassport(db: DbClient, passportId: string): Promise<Evidence[]> {
    return db.evidence.findMany({ where: { passportId }, orderBy: { createdAt: "desc" }, take: 500 });
  },

  async create(db: DbClient, input: CreateEvidenceInput): Promise<Evidence> {
    return db.evidence.create({
      data: {
        id: newId(),
        passportId: input.passportId,
        type: input.type,
        objectRef: input.objectRef,
        checksum: input.checksum ?? null,
        issuer: input.issuer ?? null,
        collectedAt: input.collectedAt,
        expiresAt: input.expiresAt ?? null,
        privacyClass: input.privacyClass ?? "RESTRICTED",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },
};

export function newEvidenceId(): string {
  return newId();
}
