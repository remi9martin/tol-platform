// packages/db/src/repositories/readiness-result.repository.ts
//
// the spec ReadinessResult + p.12 ("record... computedAt... so
// historical decisions can be reproduced"). APPEND-ONLY, one row per
// recompute — see schema.prisma's ReadinessResult model comment for why
// this matches ClaimDecision's snapshot precedent rather than a mutable
// "current result" row. `findLatestByPassport` is the read path every
// caller actually wants; there is no `update`.

import type { DisclosureClass, ReadinessResult, SourceType } from "@prisma/client";
import { newId } from "../ids.js";
import { assertJsonSafeObjectArray, assertStringArray } from "../json-guards.js";
import type { DbClient } from "./types.js";

export interface CreateReadinessResultInput {
  passportId: string;
  score: number;
  blockers: readonly Record<string, unknown>[];
  warnings: readonly Record<string, unknown>[];
  ruleVersion: string;
  algorithmVersion: string;
  inputVersions: readonly string[];
  computedAt: Date;
  privacyClass?: DisclosureClass;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
  sourceReference?: string | null;
}

export const readinessResultRepository = {
  async findLatestByPassport(db: DbClient, passportId: string): Promise<ReadinessResult | null> {
    return db.readinessResult.findFirst({ where: { passportId }, orderBy: { computedAt: "desc" } });
  },

  /** Full history — newest first. Used by apps/web's Passport view to show a readiness trend, and by the P6 determinism proof (two independent recomputes on unchanged inputs must be byte-identical). */
  async listByPassport(db: DbClient, passportId: string, opts: { limit?: number } = {}): Promise<ReadinessResult[]> {
    return db.readinessResult.findMany({ where: { passportId }, orderBy: { computedAt: "desc" }, take: opts.limit ?? 50 });
  },

  async create(db: DbClient, input: CreateReadinessResultInput): Promise<ReadinessResult> {
    assertJsonSafeObjectArray(input.blockers, "ReadinessResult.blockers");
    assertJsonSafeObjectArray(input.warnings, "ReadinessResult.warnings");
    assertStringArray(input.inputVersions as unknown, "ReadinessResult.inputVersions");
    return db.readinessResult.create({
      data: {
        id: newId(),
        passportId: input.passportId,
        score: input.score,
        blockers: input.blockers as object,
        warnings: input.warnings as object,
        ruleVersion: input.ruleVersion,
        algorithmVersion: input.algorithmVersion,
        inputVersions: [...input.inputVersions],
        computedAt: input.computedAt,
        privacyClass: input.privacyClass ?? "MEMBER_MARKET",
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
        sourceReference: input.sourceReference ?? null,
      },
    });
  },
};

export function newReadinessResultId(): string {
  return newId();
}
