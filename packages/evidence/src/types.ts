// packages/evidence/src/types.ts
//
// the spec (Passport/Fact/Evidence/ReadinessResult schema + Evidence
// provenance vocabulary, verbatim) + p.16 ("Freshness classes",
// verbatim). @tol/evidence has ZERO runtime dependencies (same
// discipline as @tol/domain/@tol/authz/@tol/crypto/@tol/attribution —
// see this package's README for why) and therefore declares its OWN
// copy of the shared FreshnessClass/FactProvenance/PassportSectionType
// vocabulary rather than importing @tol/domain at runtime.
// @tol/domain/src/passport-states.ts declares the SAME vocabulary as the
// canonical, DB/authz-facing copy; the two are cross-checked by a
// hardcoded literal-equality assertion in EACH package's own test suite
// — the established LOCKBOX_SHARE_ROLES / DirectnessTier precedent
// (see @tol/attribution/src/types.ts's identical header comment).

export const FRESHNESS_CLASSES = ["FRESH", "AGING", "STALE", "UNKNOWN"] as const;
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];
export function isFreshnessClass(value: string): value is FreshnessClass {
  return (FRESHNESS_CLASSES as readonly string[]).includes(value);
}

export const FACT_PROVENANCE_STATES = [
  "SELF_REPORTED",
  "DOCUMENT_EXTRACTED",
  "API_VERIFIED",
  "COUNTERPARTY_CONFIRMED",
  "OPERATOR_VERIFIED",
  "OUTCOME_LEARNED",
  "INFERRED",
] as const;
export type FactProvenance = (typeof FACT_PROVENANCE_STATES)[number];
export function isFactProvenance(value: string): value is FactProvenance {
  return (FACT_PROVENANCE_STATES as readonly string[]).includes(value);
}

export const PASSPORT_SECTION_TYPES = ["IDENTITY", "RELATIONSHIP_HISTORY", "PROCESSING_METRICS", "RISK", "COMMERCIAL", "TECHNICAL"] as const;
export type PassportSectionType = (typeof PASSPORT_SECTION_TYPES)[number];
export function isPassportSectionType(value: string): value is PassportSectionType {
  return (PASSPORT_SECTION_TYPES as readonly string[]).includes(value);
}

// =================================================================
// Readiness engine input/output shapes (the spec: Passport / Fact /
// ReadinessResult). The engine itself (computeReadiness) is this stage —
// this file only defines the shapes so the db/domain layer and
// the engine agree on a contract before either is wired together.
// =================================================================

/** One Fact as the readiness engine sees it — a plain, already-loaded snapshot, never a live DB read (this package has zero DB access). */
export interface FactSnapshot {
  fieldKey: string;
  sectionType: PassportSectionType;
  /** True when a non-null normalizedValue is present — the engine only needs presence/absence, not the value's own content, to judge completeness. */
  hasValue: boolean;
  verification: FactProvenance;
  /** The Fact's own effectiveTo (if any) OR its linked Evidence's expiresAt — whichever this Fact's freshness should be judged against. Null when neither is set (no expiry information at all). */
  expiresAt: Date | null;
  updatedAt: Date;
}

/** the spec's "Evidence examples"-style per-fieldKey requirement — see config.ts's REQUIRED_FACTS for the concrete, documented-inference list this engine checks against. */
export interface RequiredFact {
  fieldKey: string;
  sectionType: PassportSectionType;
  /** Missing this fieldKey BLOCKS readiness (p.5 STATE RULE-adjacent: a Passport cannot reach READY with an unmet required fact). */
  blocking: boolean;
  label: string;
}

export interface ReadinessBlocker {
  fieldKey: string;
  sectionType: PassportSectionType;
  message: string;
}

export interface ReadinessWarning {
  fieldKey: string;
  sectionType: PassportSectionType;
  message: string;
}

/** Mirrors schema.prisma's ReadinessResult columns field-for-field (minus the base-audit/persistence columns, which are apps/api's concern, not this pure package's). `computedAt` deliberately is NOT set by this package's own compute function — see readiness.ts's header comment for why (same "caller stamps the clock read" precedent as @tol/attribution's scoreClaim / @tol/crypto's sealPayload). */
export interface ReadinessResultShape {
  score: number;
  blockers: readonly ReadinessBlocker[];
  warnings: readonly ReadinessWarning[];
  ruleVersion: string;
  algorithmVersion: string;
  inputVersions: readonly string[];
}
