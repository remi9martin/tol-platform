import { describe, expect, it } from "vitest";
import {
  CLAIM_APPEAL_STATUSES,
  CLAIM_DECISION_OUTCOMES,
  CLAIM_DISPUTE_RESOLUTIONS,
  CLAIM_DISPUTE_STATUSES,
  CLAIM_EVIDENCE_TYPES,
  CLAIM_STATUSES,
  DIRECTNESS_TIERS,
  EVIDENCE_VERIFICATION_STATES,
  InvalidClaimTransitionError,
  assertValidClaimDisputeTransition,
  assertValidClaimTransition,
  isClaimAppealStatus,
  isClaimDecisionOutcome,
  isClaimDisputeResolution,
  isClaimDisputeStatus,
  isClaimEvidenceType,
  isClaimProvisionalExpired,
  isClaimStatus,
  isDirectnessTier,
  isEvidenceVerificationState,
} from "./claim-states.js";

describe("shared vocabulary — canonical copy, must stay byte-identical to @tol/attribution's own copy (same LOCKBOX_SHARE_ROLES precedent: literal-equality assertion, not a cross-package import)", () => {
  it("DIRECTNESS_TIERS matches the spec verbatim (D5 down to D0)", () => {
    expect(DIRECTNESS_TIERS).toEqual(["D5", "D4", "D3", "D2", "D1", "D0"]);
  });

  it("CLAIM_EVIDENCE_TYPES matches @tol/attribution's ClaimEvidenceType set", () => {
    expect(CLAIM_EVIDENCE_TYPES).toEqual(["CONTRACT", "COUNTERPARTY_ACKNOWLEDGMENT", "EMAIL_THREAD", "CRM_RECORD", "OTHER"]);
  });

  it("EVIDENCE_VERIFICATION_STATES matches @tol/attribution's EvidenceVerificationState set", () => {
    expect(EVIDENCE_VERIFICATION_STATES).toEqual(["SELF_REPORTED", "DOCUMENT_EXTRACTED", "API_VERIFIED", "COUNTERPARTY_CONFIRMED", "OPERATOR_VERIFIED"]);
  });

  it("type guards correctly accept/reject", () => {
    expect(isDirectnessTier("D3")).toBe(true);
    expect(isDirectnessTier("D9")).toBe(false);
    expect(isClaimEvidenceType("CONTRACT")).toBe(true);
    expect(isClaimEvidenceType("NOT_A_TYPE")).toBe(false);
    expect(isEvidenceVerificationState("OPERATOR_VERIFIED")).toBe(true);
    expect(isEvidenceVerificationState("NOT_A_STATE")).toBe(false);
  });
});

describe("CLAIM_STATUSES", () => {
  it("matches the full designed set", () => {
    expect(CLAIM_STATUSES).toEqual(["FILED", "SCORED", "VERIFIED", "PARTIAL", "DISPUTED", "REJECTED", "EXPIRED", "WITHDRAWN"]);
  });

  it("isClaimStatus is a correct type guard", () => {
    expect(isClaimStatus("SCORED")).toBe(true);
    expect(isClaimStatus("NOT_A_STATUS")).toBe(false);
  });
});

describe("assertValidClaimTransition — main happy paths", () => {
  it("allows FILED -> SCORED (the scoring hop apps/api's claims service performs synchronously on create)", () => {
    expect(() => assertValidClaimTransition("FILED", "SCORED")).not.toThrow();
  });

  it("allows every SCORED -> {VERIFIED, PARTIAL, REJECTED, DISPUTED, EXPIRED, WITHDRAWN} hop", () => {
    for (const to of ["VERIFIED", "PARTIAL", "REJECTED", "DISPUTED", "EXPIRED", "WITHDRAWN"] as const) {
      expect(() => assertValidClaimTransition("SCORED", to)).not.toThrow();
    }
  });

  it("allows FILED -> WITHDRAWN (claimant self-withdraws before scoring)", () => {
    expect(() => assertValidClaimTransition("FILED", "WITHDRAWN")).not.toThrow();
  });

  it('anti-gaming test (the spec): "a later direct executive relationship can defeat an earlier generic-mailbox claim" -- VERIFIED and PARTIAL can still be disputed', () => {
    expect(() => assertValidClaimTransition("VERIFIED", "DISPUTED")).not.toThrow();
    expect(() => assertValidClaimTransition("PARTIAL", "DISPUTED")).not.toThrow();
  });

  it("allows every DISPUTED -> {VERIFIED, PARTIAL, REJECTED} resolution", () => {
    for (const to of ["VERIFIED", "PARTIAL", "REJECTED"] as const) {
      expect(() => assertValidClaimTransition("DISPUTED", to)).not.toThrow();
    }
  });
});

describe("assertValidClaimTransition — illegal transitions", () => {
  it("rejects any same-state call (no legitimate re-entrant transition, same discipline as Lockbox)", () => {
    for (const s of CLAIM_STATUSES) {
      expect(() => assertValidClaimTransition(s, s)).toThrow(InvalidClaimTransitionError);
    }
  });

  it("rejects skipping straight from FILED to a decision (must be scored first)", () => {
    expect(() => assertValidClaimTransition("FILED", "VERIFIED")).toThrow(InvalidClaimTransitionError);
    expect(() => assertValidClaimTransition("FILED", "DISPUTED")).toThrow(InvalidClaimTransitionError);
  });

  it("rejects DISPUTED going back to DISPUTED-adjacent non-terminal states directly (must resolve to VERIFIED/PARTIAL/REJECTED)", () => {
    expect(() => assertValidClaimTransition("DISPUTED", "SCORED")).toThrow(InvalidClaimTransitionError);
    expect(() => assertValidClaimTransition("DISPUTED", "FILED")).toThrow(InvalidClaimTransitionError);
  });

  it("rejects WITHDRAWN from an already-decided claim (VERIFIED/PARTIAL/REJECTED/DISPUTED/EXPIRED cannot be unilaterally withdrawn)", () => {
    for (const from of ["VERIFIED", "PARTIAL", "DISPUTED", "REJECTED", "EXPIRED"] as const) {
      expect(() => assertValidClaimTransition(from, "WITHDRAWN")).toThrow(InvalidClaimTransitionError);
    }
  });

  it("every terminal state (REJECTED, EXPIRED, WITHDRAWN) has zero legal outgoing transitions", () => {
    for (const terminal of ["REJECTED", "EXPIRED", "WITHDRAWN"] as const) {
      for (const to of CLAIM_STATUSES) {
        if (to === terminal) continue;
        expect(() => assertValidClaimTransition(terminal, to)).toThrow(InvalidClaimTransitionError);
      }
    }
  });

  it("error message names the entity, from, and to", () => {
    expect(() => assertValidClaimTransition("FILED", "REJECTED")).toThrow(/Claim.*FILED.*REJECTED/);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidClaimTransition("NOT_A_STATUS" as never, "SCORED")).toThrow(InvalidClaimTransitionError);
  });
});

describe("ClaimDispute — status + resolution", () => {
  it("CLAIM_DISPUTE_STATUSES is exactly OPEN/DECIDED", () => {
    expect(CLAIM_DISPUTE_STATUSES).toEqual(["OPEN", "DECIDED"]);
  });

  it("isClaimDisputeStatus is a correct type guard", () => {
    expect(isClaimDisputeStatus("OPEN")).toBe(true);
    expect(isClaimDisputeStatus("PENDING")).toBe(false);
  });

  it("allows OPEN -> DECIDED", () => {
    expect(() => assertValidClaimDisputeTransition("OPEN", "DECIDED")).not.toThrow();
  });

  it("rejects DECIDED -> OPEN (a decided dispute cannot be reopened by this transition — a fresh dispute is a new row)", () => {
    expect(() => assertValidClaimDisputeTransition("DECIDED", "OPEN")).toThrow(InvalidClaimTransitionError);
  });

  it("rejects same-state re-transition for both states", () => {
    expect(() => assertValidClaimDisputeTransition("OPEN", "OPEN")).toThrow(InvalidClaimTransitionError);
    expect(() => assertValidClaimDisputeTransition("DECIDED", "DECIDED")).toThrow(InvalidClaimTransitionError);
  });

  it('error names "ClaimDispute" as the entity, distinguishing it from a Claim transition error', () => {
    expect(() => assertValidClaimDisputeTransition("OPEN", "OPEN")).toThrow(/ClaimDispute/);
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidClaimDisputeTransition("NOT_A_STATUS" as never, "DECIDED")).toThrow(
      InvalidClaimTransitionError,
    );
  });

  it("CLAIM_DISPUTE_RESOLUTIONS covers the spec's three-way framing (uphold / shared / reject)", () => {
    expect(CLAIM_DISPUTE_RESOLUTIONS).toEqual(["UPHELD_ORIGINAL", "PARTIAL_ATTRIBUTION", "REJECTED_ORIGINAL"]);
    expect(isClaimDisputeResolution("PARTIAL_ATTRIBUTION")).toBe(true);
    expect(isClaimDisputeResolution("MAYBE")).toBe(false);
  });
});

describe("ClaimDecision — outcome + appeal status", () => {
  it("CLAIM_DECISION_OUTCOMES is the narrower 3-value set (never DISPUTED -- a decision resolves OUT of disputed, not into it)", () => {
    expect(CLAIM_DECISION_OUTCOMES).toEqual(["VERIFIED", "PARTIAL", "REJECTED"]);
    expect((CLAIM_DECISION_OUTCOMES as readonly string[]).includes("DISPUTED")).toBe(false);
  });

  it("isClaimDecisionOutcome rejects DISPUTED explicitly", () => {
    expect(isClaimDecisionOutcome("DISPUTED")).toBe(false);
    expect(isClaimDecisionOutcome("VERIFIED")).toBe(true);
  });

  it('CLAIM_APPEAL_STATUSES defaults-friendly set exists (the spec: "...and appeal status") -- filing workflow itself out of scope this pass, see this file\'s header comment', () => {
    expect(CLAIM_APPEAL_STATUSES).toEqual(["NONE", "PENDING", "GRANTED", "DENIED"]);
    expect(isClaimAppealStatus("NONE")).toBe(true);
  });
});

describe("isClaimProvisionalExpired", () => {
  const window = new Date("2026-08-01T00:00:00.000Z");

  it("is false before the window elapses", () => {
    const now = new Date("2026-07-31T23:59:59.999Z");
    expect(isClaimProvisionalExpired("SCORED", window, now)).toBe(false);
  });

  it("is false exactly AT the boundary instant (strictly greater-than, not >=)", () => {
    expect(isClaimProvisionalExpired("SCORED", window, window)).toBe(false);
  });

  it("is true once the window has elapsed", () => {
    const now = new Date("2026-08-01T00:00:00.001Z");
    expect(isClaimProvisionalExpired("SCORED", window, now)).toBe(true);
  });

  it("is false for a null provisionalExpiresAt (no window configured)", () => {
    expect(isClaimProvisionalExpired("SCORED", null, new Date("2099-01-01"))).toBe(false);
  });

  it("is false for every status other than SCORED, even with a long-lapsed window", () => {
    const farFuture = new Date("2099-01-01T00:00:00.000Z");
    for (const status of CLAIM_STATUSES) {
      if (status === "SCORED") continue;
      expect(isClaimProvisionalExpired(status, window, farFuture)).toBe(false);
    }
  });
});
