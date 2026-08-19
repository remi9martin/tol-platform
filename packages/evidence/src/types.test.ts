import { describe, expect, it } from "vitest";
import {
  FACT_PROVENANCE_STATES,
  FRESHNESS_CLASSES,
  PASSPORT_SECTION_TYPES,
  isFactProvenance,
  isFreshnessClass,
  isPassportSectionType,
} from "./types.js";

describe("shared vocabulary — canonical copy, must stay byte-identical to @tol/domain's passport-states.ts copy (same LOCKBOX_SHARE_ROLES / DirectnessTier precedent: literal-equality assertion, not a cross-package import)", () => {
  it("FRESHNESS_CLASSES matches the spec verbatim", () => {
    expect(FRESHNESS_CLASSES).toEqual(["FRESH", "AGING", "STALE", "UNKNOWN"]);
  });

  it("FACT_PROVENANCE_STATES matches @tol/domain's passport-states.ts FACT_PROVENANCE_STATES (the spec's full 7-value list)", () => {
    expect(FACT_PROVENANCE_STATES).toEqual([
      "SELF_REPORTED",
      "DOCUMENT_EXTRACTED",
      "API_VERIFIED",
      "COUNTERPARTY_CONFIRMED",
      "OPERATOR_VERIFIED",
      "OUTCOME_LEARNED",
      "INFERRED",
    ]);
  });

  it("PASSPORT_SECTION_TYPES matches @tol/domain's passport-states.ts PASSPORT_SECTION_TYPES", () => {
    expect(PASSPORT_SECTION_TYPES).toEqual(["IDENTITY", "RELATIONSHIP_HISTORY", "PROCESSING_METRICS", "RISK", "COMMERCIAL", "TECHNICAL"]);
  });

  it("every isX guard is a real type guard, not a stub always returning true", () => {
    expect(isFreshnessClass("FRESH")).toBe(true);
    expect(isFreshnessClass("bogus")).toBe(false);
    expect(isFactProvenance("INFERRED")).toBe(true);
    expect(isFactProvenance("bogus")).toBe(false);
    expect(isPassportSectionType("RISK")).toBe(true);
    expect(isPassportSectionType("bogus")).toBe(false);
  });
});
