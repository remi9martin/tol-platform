import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SOURCE_KINDS,
  FACT_PROVENANCE_STATES,
  FRESHNESS_CLASSES,
  InvalidPassportTransitionError,
  PASSPORT_SECTION_TYPES,
  PASSPORT_STATUSES,
  assertValidPassportTransition,
  isEvidenceSourceKind,
  isFactProvenance,
  isFreshnessClass,
  isPassportReadinessStale,
  isPassportSectionType,
  isPassportStatus,
  targetStatusAfterRecompute,
} from "./passport-states.js";

describe("PASSPORT_STATUSES", () => {
  it("has exactly the 6 values from the spec, in order", () => {
    expect(PASSPORT_STATUSES).toEqual(["DRAFT", "INCOMPLETE", "READY", "VERIFIED", "STALE", "SUSPENDED"]);
  });

  it("isPassportStatus is a real type guard", () => {
    expect(isPassportStatus("DRAFT")).toBe(true);
    expect(isPassportStatus("NOT_A_STATUS")).toBe(false);
  });
});

describe("assertValidPassportTransition", () => {
  it("allows the documented happy path DRAFT -> INCOMPLETE -> READY -> VERIFIED", () => {
    expect(() => assertValidPassportTransition("DRAFT", "INCOMPLETE")).not.toThrow();
    expect(() => assertValidPassportTransition("INCOMPLETE", "READY")).not.toThrow();
    expect(() => assertValidPassportTransition("READY", "VERIFIED")).not.toThrow();
  });

  it("allows DRAFT -> READY directly (zero-required-facts degenerate case)", () => {
    expect(() => assertValidPassportTransition("DRAFT", "READY")).not.toThrow();
  });

  it("allows the READY <-> INCOMPLETE regression pair", () => {
    expect(() => assertValidPassportTransition("READY", "INCOMPLETE")).not.toThrow();
    expect(() => assertValidPassportTransition("INCOMPLETE", "READY")).not.toThrow();
  });

  it("allows VERIFIED to regress to INCOMPLETE or READY (a retracted Fact invalidates verification)", () => {
    expect(() => assertValidPassportTransition("VERIFIED", "INCOMPLETE")).not.toThrow();
    expect(() => assertValidPassportTransition("VERIFIED", "READY")).not.toThrow();
  });

  it("allows READY and VERIFIED to go STALE, and STALE to recover to any of INCOMPLETE/READY/VERIFIED", () => {
    expect(() => assertValidPassportTransition("READY", "STALE")).not.toThrow();
    expect(() => assertValidPassportTransition("VERIFIED", "STALE")).not.toThrow();
    expect(() => assertValidPassportTransition("STALE", "INCOMPLETE")).not.toThrow();
    expect(() => assertValidPassportTransition("STALE", "READY")).not.toThrow();
    expect(() => assertValidPassportTransition("STALE", "VERIFIED")).not.toThrow();
  });

  it("rejects DRAFT or INCOMPLETE going straight to STALE — never reached readiness to go stale FROM", () => {
    expect(() => assertValidPassportTransition("DRAFT", "STALE")).toThrow(InvalidPassportTransitionError);
    expect(() => assertValidPassportTransition("INCOMPLETE", "STALE")).toThrow(InvalidPassportTransitionError);
  });

  it("allows SUSPENDED from every non-terminal state (operator compliance hold)", () => {
    for (const from of ["DRAFT", "INCOMPLETE", "READY", "VERIFIED", "STALE"] as const) {
      expect(() => assertValidPassportTransition(from, "SUSPENDED")).not.toThrow();
    }
  });

  it("SUSPENDED recovers ONLY to INCOMPLETE — never a silent snap-back to READY/VERIFIED/STALE", () => {
    expect(() => assertValidPassportTransition("SUSPENDED", "INCOMPLETE")).not.toThrow();
    expect(() => assertValidPassportTransition("SUSPENDED", "READY")).toThrow(InvalidPassportTransitionError);
    expect(() => assertValidPassportTransition("SUSPENDED", "VERIFIED")).toThrow(InvalidPassportTransitionError);
    expect(() => assertValidPassportTransition("SUSPENDED", "STALE")).toThrow(InvalidPassportTransitionError);
    expect(() => assertValidPassportTransition("SUSPENDED", "DRAFT")).toThrow(InvalidPassportTransitionError);
  });

  it("rejects a same-state 'transition' for every status — callers must not call this as a no-op", () => {
    for (const status of PASSPORT_STATUSES) {
      expect(() => assertValidPassportTransition(status, status)).toThrow(InvalidPassportTransitionError);
    }
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidPassportTransition("NOT_A_STATUS" as never, "READY")).toThrow(
      InvalidPassportTransitionError,
    );
  });
});

describe("shared freshness/provenance/section vocabulary", () => {
  it("FRESHNESS_CLASSES matches the spec verbatim", () => {
    expect(FRESHNESS_CLASSES).toEqual(["FRESH", "AGING", "STALE", "UNKNOWN"]);
    expect(isFreshnessClass("FRESH")).toBe(true);
    expect(isFreshnessClass("BOGUS")).toBe(false);
  });

  it("FACT_PROVENANCE_STATES matches the spec's full 7-value list (wider than Claim's 5-value EvidenceVerificationState)", () => {
    expect(FACT_PROVENANCE_STATES).toEqual([
      "SELF_REPORTED",
      "DOCUMENT_EXTRACTED",
      "API_VERIFIED",
      "COUNTERPARTY_CONFIRMED",
      "OPERATOR_VERIFIED",
      "OUTCOME_LEARNED",
      "INFERRED",
    ]);
    expect(isFactProvenance("OUTCOME_LEARNED")).toBe(true);
    expect(isFactProvenance("INFERRED")).toBe(true);
  });

  it("PASSPORT_SECTION_TYPES and EVIDENCE_SOURCE_KINDS are real, closed type guards", () => {
    expect(PASSPORT_SECTION_TYPES).toContain("IDENTITY");
    expect(isPassportSectionType("RISK")).toBe(true);
    expect(isPassportSectionType("NOT_A_SECTION")).toBe(false);
    expect(EVIDENCE_SOURCE_KINDS).toEqual(["FILE", "API", "ATTESTATION"]);
    expect(isEvidenceSourceKind("ATTESTATION")).toBe(true);
  });
});

describe("isPassportReadinessStale", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("is false for DRAFT/INCOMPLETE regardless of age — never reached readiness to go stale from", () => {
    const ancientDate = new Date("2020-01-01T00:00:00.000Z");
    expect(isPassportReadinessStale("DRAFT", ancientDate, now, 30)).toBe(false);
    expect(isPassportReadinessStale("INCOMPLETE", ancientDate, now, 30)).toBe(false);
  });

  it("is false when lastComputedAt is null (never yet computed)", () => {
    expect(isPassportReadinessStale("READY", null, now, 30)).toBe(false);
  });

  it("is false within the window, true strictly past it, for both READY and VERIFIED", () => {
    const within = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const past = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    expect(isPassportReadinessStale("READY", within, now, 30)).toBe(false);
    expect(isPassportReadinessStale("READY", past, now, 30)).toBe(true);
    expect(isPassportReadinessStale("VERIFIED", within, now, 30)).toBe(false);
    expect(isPassportReadinessStale("VERIFIED", past, now, 30)).toBe(true);
  });

  it("is deterministic — same inputs, same reference time, identical output across repeated calls", () => {
    const computedAt = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    const results = Array.from({ length: 50 }, () => isPassportReadinessStale("READY", computedAt, now, 30));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(true);
  });

  it("throws TypeError on a non-positive or non-finite maxAgeDays instead of silently returning a nonsensical result", () => {
    const computedAt = new Date(now.getTime() - 1000);
    expect(() => isPassportReadinessStale("READY", computedAt, now, 0)).toThrow(TypeError);
    expect(() => isPassportReadinessStale("READY", computedAt, now, -30)).toThrow(TypeError);
    expect(() => isPassportReadinessStale("READY", computedAt, now, Number.NaN)).toThrow(TypeError);
    expect(() => isPassportReadinessStale("READY", computedAt, now, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("targetStatusAfterRecompute (earlier: moved here from apps/api's own local copy — shared by apps/api's on-read recompute AND apps/worker's passport-readiness job, so both agree on the exact same decision)", () => {
  it("SUSPENDED never auto-transitions, regardless of blocked/hasFacts", () => {
    expect(targetStatusAfterRecompute("SUSPENDED", true, true)).toBe("SUSPENDED");
    expect(targetStatusAfterRecompute("SUSPENDED", false, false)).toBe("SUSPENDED");
  });

  it("a DRAFT passport with zero facts stays DRAFT even though it's technically blocked", () => {
    expect(targetStatusAfterRecompute("DRAFT", false, true)).toBe("DRAFT");
  });

  it("blocked + has facts -> INCOMPLETE, from any non-SUSPENDED origin", () => {
    expect(targetStatusAfterRecompute("DRAFT", true, true)).toBe("INCOMPLETE");
    expect(targetStatusAfterRecompute("INCOMPLETE", true, true)).toBe("INCOMPLETE");
    expect(targetStatusAfterRecompute("READY", true, true)).toBe("INCOMPLETE");
    expect(targetStatusAfterRecompute("VERIFIED", true, true)).toBe("INCOMPLETE");
    expect(targetStatusAfterRecompute("STALE", true, true)).toBe("INCOMPLETE");
  });

  it("VERIFIED persists across a still-unblocked recompute — a new fact arriving doesn't invalidate human verification", () => {
    expect(targetStatusAfterRecompute("VERIFIED", true, false)).toBe("VERIFIED");
  });

  it("unblocked and not VERIFIED -> READY, from any non-SUSPENDED, non-VERIFIED origin", () => {
    expect(targetStatusAfterRecompute("DRAFT", true, false)).toBe("READY");
    expect(targetStatusAfterRecompute("INCOMPLETE", true, false)).toBe("READY");
    expect(targetStatusAfterRecompute("READY", true, false)).toBe("READY");
    expect(targetStatusAfterRecompute("STALE", true, false)).toBe("READY");
  });

  it("is deterministic — a pure function of its 3 inputs, no hidden state", () => {
    const results = Array.from({ length: 50 }, () => targetStatusAfterRecompute("READY", true, true));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("INCOMPLETE");
  });
});
