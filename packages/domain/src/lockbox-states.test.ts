import { describe, expect, it } from "vitest";
import {
  InvalidLockboxTransitionError,
  LOCKBOX_RELATIONSHIP_TYPES,
  LOCKBOX_RELEASE_CASCADE,
  LOCKBOX_REGIONS,
  LOCKBOX_SHARE_ROLES,
  LOCKBOX_STATUSES,
  assertValidLockboxReleaseCascade,
  assertValidLockboxTransition,
  canWithdrawFrom,
  isLockboxRegion,
  isLockboxRelationshipType,
  isLockboxShareRole,
  isLockboxStatus,
} from "./lockbox-states.js";

describe("LOCKBOX_STATUSES", () => {
  it("matches the spec verbatim (DRAFT -> SEALED -> COMMITTED -> FROZEN -> OPENED -> MATCH_ELIGIBLE; WITHDRAWN/DISPUTED side states)", () => {
    expect(LOCKBOX_STATUSES).toEqual([
      "DRAFT",
      "SEALED",
      "COMMITTED",
      "FROZEN",
      "OPENED",
      "MATCH_ELIGIBLE",
      "WITHDRAWN",
      "DISPUTED",
    ]);
  });

  it("isLockboxStatus is a correct type guard", () => {
    expect(isLockboxStatus("SEALED")).toBe(true);
    expect(isLockboxStatus("NOT_A_STATUS")).toBe(false);
  });
});

describe("assertValidLockboxTransition — main happy path", () => {
  it("allows the full main-line sequence DRAFT -> SEALED -> COMMITTED -> FROZEN -> OPENED -> MATCH_ELIGIBLE", () => {
    expect(() => assertValidLockboxTransition("DRAFT", "SEALED")).not.toThrow();
    expect(() => assertValidLockboxTransition("SEALED", "COMMITTED")).not.toThrow();
    expect(() => assertValidLockboxTransition("COMMITTED", "FROZEN")).not.toThrow();
    expect(() => assertValidLockboxTransition("FROZEN", "OPENED")).not.toThrow();
    expect(() => assertValidLockboxTransition("OPENED", "MATCH_ELIGIBLE")).not.toThrow();
  });

  it("allows SEALED -> WITHDRAWN directly (the only path an earlier API exercises for withdraw)", () => {
    expect(() => assertValidLockboxTransition("SEALED", "WITHDRAWN")).not.toThrow();
  });

  it("rejects skipping states (SEALED -> OPENED directly is not a single legal hop — release must cascade through COMMITTED/FROZEN)", () => {
    expect(() => assertValidLockboxTransition("SEALED", "OPENED")).toThrow(InvalidLockboxTransitionError);
  });

  it("rejects any same-state call (no legitimate re-entrant transition for a Lockbox, unlike RFQ's re-entrant QUOTED)", () => {
    for (const s of LOCKBOX_STATUSES) {
      expect(() => assertValidLockboxTransition(s, s)).toThrow(InvalidLockboxTransitionError);
    }
  });

  it("WITHDRAWN is terminal — nothing transitions out of it", () => {
    for (const to of LOCKBOX_STATUSES) {
      if (to === "WITHDRAWN") continue;
      expect(() => assertValidLockboxTransition("WITHDRAWN", to)).toThrow(InvalidLockboxTransitionError);
    }
  });

  it("throws the typed error (not a raw TypeError) for an out-of-enum 'from' value — proves the runtime guard, not just the type system, rejects a cast/unvalidated bad status", () => {
    expect(() => assertValidLockboxTransition("NOT_A_STATUS" as never, "SEALED")).toThrow(
      InvalidLockboxTransitionError,
    );
  });
});

describe("FROZEN's withdrawal-disabled rule (the spec: 'entries move to FROZEN and withdrawal is disabled')", () => {
  it("FROZEN has no WITHDRAWN edge — the one state (besides WITHDRAWN itself) that cannot go straight to WITHDRAWN", () => {
    expect(() => assertValidLockboxTransition("FROZEN", "WITHDRAWN")).toThrow(InvalidLockboxTransitionError);
  });

  it("canWithdrawFrom is true only for SEALED, COMMITTED, MATCH_ELIGIBLE, and DISPUTED — false for DRAFT (nothing sealed yet), FROZEN (explicitly disabled), OPENED (contents already disclosed — withdrawing can't undo that), and WITHDRAWN (terminal)", () => {
    const withdrawable: readonly (typeof LOCKBOX_STATUSES)[number][] = ["SEALED", "COMMITTED", "MATCH_ELIGIBLE", "DISPUTED"];
    const notWithdrawable: readonly (typeof LOCKBOX_STATUSES)[number][] = ["DRAFT", "FROZEN", "OPENED", "WITHDRAWN"];
    expect([...withdrawable, ...notWithdrawable].sort()).toEqual([...LOCKBOX_STATUSES].sort()); // exhaustiveness check on this test itself
    for (const s of withdrawable) expect(canWithdrawFrom(s)).toBe(true);
    for (const s of notWithdrawable) expect(canWithdrawFrom(s)).toBe(false);
  });

  it("FROZEN can still resolve via DISPUTED (its only outgoing edge besides OPENED)", () => {
    expect(() => assertValidLockboxTransition("FROZEN", "DISPUTED")).not.toThrow();
  });
});

describe("DISPUTED side state", () => {
  it("resolves back to FROZEN or closes via WITHDRAWN (the spec: 'works back to FROZEN or closes out via WITHDRAWN')", () => {
    expect(() => assertValidLockboxTransition("DISPUTED", "FROZEN")).not.toThrow();
    expect(() => assertValidLockboxTransition("DISPUTED", "WITHDRAWN")).not.toThrow();
  });

  it("every non-terminal state can reach DISPUTED except DRAFT and SEALED (the spec lists DISPUTED as a side state reachable from COMMITTED onward, not pre-seal)", () => {
    expect(() => assertValidLockboxTransition("COMMITTED", "DISPUTED")).not.toThrow();
    expect(() => assertValidLockboxTransition("FROZEN", "DISPUTED")).not.toThrow();
    expect(() => assertValidLockboxTransition("OPENED", "DISPUTED")).not.toThrow();
    expect(() => assertValidLockboxTransition("MATCH_ELIGIBLE", "DISPUTED")).not.toThrow();
    expect(() => assertValidLockboxTransition("DRAFT", "DISPUTED")).toThrow(InvalidLockboxTransitionError);
    expect(() => assertValidLockboxTransition("SEALED", "DISPUTED")).toThrow(InvalidLockboxTransitionError);
  });
});

describe("LOCKBOX_RELEASE_CASCADE / assertValidLockboxReleaseCascade", () => {
  it("the cascade is exactly SEALED -> COMMITTED -> FROZEN -> OPENED", () => {
    expect(LOCKBOX_RELEASE_CASCADE).toEqual(["SEALED", "COMMITTED", "FROZEN", "OPENED"]);
  });

  it("every hop in the cascade is independently a legal transition per the main table (the cascade is a real path through the state machine, not a bypass of it)", () => {
    for (let i = 0; i < LOCKBOX_RELEASE_CASCADE.length - 1; i++) {
      expect(() => assertValidLockboxTransition(LOCKBOX_RELEASE_CASCADE[i]!, LOCKBOX_RELEASE_CASCADE[i + 1]!)).not.toThrow();
    }
  });

  it("accepts SEALED as the starting point (the only status an earlier API ever persists a Lockbox at before release)", () => {
    expect(() => assertValidLockboxReleaseCascade("SEALED")).not.toThrow();
  });

  it("also accepts COMMITTED or FROZEN as a starting point (forward-compatible with a future standalone commit/freeze action)", () => {
    expect(() => assertValidLockboxReleaseCascade("COMMITTED")).not.toThrow();
    expect(() => assertValidLockboxReleaseCascade("FROZEN")).not.toThrow();
  });

  it("rejects DRAFT, OPENED, MATCH_ELIGIBLE, WITHDRAWN, and DISPUTED as release-cascade starting points", () => {
    for (const s of ["DRAFT", "OPENED", "MATCH_ELIGIBLE", "WITHDRAWN", "DISPUTED"] as const) {
      expect(() => assertValidLockboxReleaseCascade(s)).toThrow(InvalidLockboxTransitionError);
    }
  });

  it("an already-OPENED lockbox gets a distinct 'already released, nothing to do' message, not the generic 'invalid transition' wording used for starting points that can never reach OPENED at all (a review finding on this exact edge case)", () => {
    try {
      assertValidLockboxReleaseCascade("OPENED");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("already released");
    }
    // Contrast: DRAFT (can never reach OPENED via this cascade at all) keeps the generic message.
    try {
      assertValidLockboxReleaseCascade("DRAFT");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("already released");
    }
  });

  it("a WITHDRAWN lockbox can never be released via the cascade — proves acceptance criterion 6 ('can NEVER be released afterward') at the state-machine level, independent of the crypto-level proof in packages/crypto", () => {
    expect(() => assertValidLockboxReleaseCascade("WITHDRAWN")).toThrow(InvalidLockboxTransitionError);
  });
});

describe("LOCKBOX_RELATIONSHIP_TYPES / LOCKBOX_REGIONS / LOCKBOX_SHARE_ROLES", () => {
  it("has the 7 relationship types ported from the reuse-reference prototype", () => {
    expect(LOCKBOX_RELATIONSHIP_TYPES).toHaveLength(7);
    expect(isLockboxRelationshipType("ACQUIRER_RELATIONSHIP")).toBe(true);
    expect(isLockboxRelationshipType("not_a_type")).toBe(false);
  });

  it("has the 7 macro-regions ported from the reuse-reference prototype", () => {
    expect(LOCKBOX_REGIONS).toHaveLength(7);
    expect(isLockboxRegion("GLOBAL")).toBe(true);
    expect(isLockboxRegion("MARS")).toBe(false);
  });

  it("has exactly the 3 threshold-share roles (SEALER/OPERATOR/ESCROW), matching @tol/crypto's own LOCKBOX_SHARE_ROLES byte-for-byte (guards against the two packages' copies silently drifting apart)", () => {
    expect(LOCKBOX_SHARE_ROLES).toEqual(["SEALER", "OPERATOR", "ESCROW"]);
    expect(isLockboxShareRole("ESCROW")).toBe(true);
    expect(isLockboxShareRole("NOBODY")).toBe(false);
  });
});
