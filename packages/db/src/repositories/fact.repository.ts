// packages/db/src/repositories/fact.repository.ts
//
// the spec: "Fact || Atomic asserted value || fieldKey,
// normalizedValue, source, verification, effective dates." A Fact is a
// MUTABLE current-value row (schema.prisma's `@@unique([passportId,
// fieldKey])`) — `upsertByFieldKey` is the one real write path a
// passport-facts submission uses; there is no separate create-vs-update
// distinction at the API layer the way Lockbox's DRAFT/SEALED split
// needs (see schema.prisma's Fact model comment for why the underlying
// Evidence trail, not the Fact row itself, is what stays append-only).

import type { DisclosureClass, Fact, FactProvenance, PassportSectionType, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSerializableValue } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface UpsertFactInput {
  passportId: string;
  sectionType: PassportSectionType;
  fieldKey: string;
  normalizedValue: unknown;
  verification?: FactProvenance;
  evidenceId?: string | null;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  updatedByUserId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const factRepository = {
  async findById(db: DbClient, id: string): Promise<Fact | null> {
    return db.fact.findUnique({ where: { id } });
  },

  async listByPassport(db: DbClient, passportId: string): Promise<Fact[]> {
    return db.fact.findMany({ where: { passportId }, orderBy: [{ sectionType: "asc" }, { fieldKey: "asc" }] });
  },

  /**
   * Insert-or-replace-in-place by (passportId, fieldKey) — a resubmission
   * of the same fieldKey UPDATES the existing row (version increments via
   * the base-audit column) rather than creating a duplicate, matching
   * this model's own "current value" semantics (schema.prisma's Fact
   * comment). `evidenceId` is intentionally repointable — see
   * evidence.repository.ts's own comment on why Evidence rows themselves
   * are append-only even though the Fact pointing at them is not.
   */
  async upsertByFieldKey(db: DbClient, input: UpsertFactInput): Promise<Fact> {
    assertJsonSerializableValue(input.normalizedValue, `Fact(${input.fieldKey}).normalizedValue`);
    return db.fact.upsert({
      where: { passportId_fieldKey: { passportId: input.passportId, fieldKey: input.fieldKey } },
      create: {
        id: newId(),
        passportId: input.passportId,
        sectionType: input.sectionType,
        fieldKey: input.fieldKey,
        normalizedValue: input.normalizedValue as object,
        verification: input.verification ?? "SELF_REPORTED",
        evidenceId: input.evidenceId ?? null,
        privacyClass: input.privacyClass ?? "MEMBER_MARKET",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
      update: {
        sectionType: input.sectionType,
        normalizedValue: input.normalizedValue as object,
        verification: input.verification ?? "SELF_REPORTED",
        evidenceId: input.evidenceId ?? null,
        updatedByUserId: input.updatedByUserId ?? null,
        version: { increment: 1 },
      },
    });
  },
};

export function newFactId(): string {
  return newId();
}
