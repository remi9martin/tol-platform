// packages/evidence — public surface. Consumers import ONLY from here via
// the @tol/evidence workspace alias, never a deep path (the spec).

export {
  FRESHNESS_CLASSES,
  isFreshnessClass,
  FACT_PROVENANCE_STATES,
  isFactProvenance,
  PASSPORT_SECTION_TYPES,
  isPassportSectionType,
} from "./types.js";
export type {
  FreshnessClass,
  FactProvenance,
  PassportSectionType,
  FactSnapshot,
  RequiredFact,
  ReadinessBlocker,
  ReadinessWarning,
  ReadinessResultShape,
} from "./types.js";

export { EVIDENCE_CONFIG } from "./config.js";

export { classifyCapacityFreshness, classifyFactFreshness } from "./freshness.js";
export type { CapacityFreshnessInput, FactFreshnessInput } from "./freshness.js";

export { computeReadiness, isReadinessBlocked } from "./readiness.js";
