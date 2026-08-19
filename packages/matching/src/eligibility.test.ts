import { describe, expect, it } from "vitest";
import { MATCHING_CONFIG } from "./config.js";
import { evaluateEligibility } from "./eligibility.js";
import { EligibilityInputError } from "./errors.js";
import { ELIGIBILITY_RULE_FAMILIES } from "./types.js";
import type { MatchCapacityInput, MatchContext, MatchOpportunityInput, RuleResult } from "./types.js";

function opportunity(overrides: Partial<MatchOpportunityInput> = {}): MatchOpportunityInput {
  return {
    id: "opp-1",
    currency: "USD",
    jurisdictions: ["US"],
    mccs: ["5411"],
    movable30dMinor: 1_000_000n,
    ...overrides,
  };
}

function capacity(overrides: Partial<MatchCapacityInput> = {}): MatchCapacityInput {
  return {
    id: "cap-1",
    currency: "USD",
    jurisdictions: ["US"],
    mccsAccepted: ["5411"],
    mccsExcluded: [],
    acceptingNewVolume: true,
    monthlyCapacityMinor: 5_000_000n,
    minTicketMinor: 100,
    maxTicketMinor: 100_000,
    maxChargebackBps: 200,
    maxFraudBps: 200,
    maxRefundBps: 500,
    settlementRail: "ACH",
    settlementCadenceDays: 2,
    freshnessClass: "FRESH",
    commercialTerms: { mdrBps: 250, fixedFeeMinor: 30, model: "blended" },
    ...overrides,
  };
}

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    now: new Date("2026-08-18T12:00:00.000Z"),
    providerPassportStatus: "READY",
    ...overrides,
  };
}

function resultFor(rule: string, results: readonly RuleResult[]): RuleResult[] {
  return results.filter((r) => r.rule === rule);
}

describe("evaluateEligibility — happy path", () => {
  it("a fully-compatible opportunity/capacity pair is eligible with zero blockers", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("every one of the ten the spec rule families appears at least once in `results`", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    for (const family of ELIGIBILITY_RULE_FAMILIES) {
      expect(result.results.some((r) => r.rule === family)).toBe(true);
    }
  });

  it("stamps ruleVersion from config by default", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    expect(result.ruleVersion).toBe(MATCHING_CONFIG.ruleVersion);
  });

  it("a caller-supplied ruleVersion overrides the config default", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ ruleVersion: "matching-eligibility-v2-preview" }));
    expect(result.ruleVersion).toBe("matching-eligibility-v2-preview");
  });

  it("echoes inputVersions verbatim, defaulting to an empty array when omitted", () => {
    expect(evaluateEligibility(opportunity(), capacity(), ctx()).inputVersions).toEqual([]);
    const withVersions = evaluateEligibility(opportunity(), capacity(), ctx({ inputVersions: ["opportunity:v3", "capacity:v1"] }));
    expect(withVersions.inputVersions).toEqual(["opportunity:v3", "capacity:v1"]);
  });

  it("evaluatedAt echoes context.now verbatim as ISO-8601 — never the live system clock", () => {
    const now = new Date("2020-01-01T00:00:00.000Z");
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ now }));
    expect(result.evaluatedAt).toBe(now.toISOString());
  });
});

describe("ROLE", () => {
  it("always passes (thin CapacityProfile schema, ADR-0012) — a dedicated row is still emitted, never omitted", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    const [role] = resultFor("ROLE", result.results);
    expect(role?.status).toBe("PASS");
    expect(role?.code).toBe("ROLE_ASSUMED_COMPATIBLE");
  });
});

describe("JURISDICTION", () => {
  it("passes when jurisdictions overlap", () => {
    const result = evaluateEligibility(opportunity({ jurisdictions: ["US", "CA"] }), capacity({ jurisdictions: ["CA", "MX"] }), ctx());
    expect(resultFor("JURISDICTION", result.results)[0]?.status).toBe("PASS");
    expect(result.eligible).toBe(true);
  });

  it("blocks (INELIGIBLE) when there is no overlap at all", () => {
    const result = evaluateEligibility(opportunity({ jurisdictions: ["US"] }), capacity({ jurisdictions: ["DE", "FR"] }), ctx());
    const finding = resultFor("JURISDICTION", result.results)[0]!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.code).toBe("JURISDICTION_NO_OVERLAP");
    expect(finding.blocking).toBe(true);
    expect(finding.overridable).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContainEqual(finding);
  });

  it("blocks with UNKNOWN (not a silent pass) when the opportunity has no jurisdictions configured", () => {
    const result = evaluateEligibility(opportunity({ jurisdictions: [] }), capacity(), ctx());
    const finding = resultFor("JURISDICTION", result.results)[0]!;
    expect(finding.status).toBe("UNKNOWN");
    expect(finding.blocking).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it("blocks with UNKNOWN when the capacity has no jurisdictions configured", () => {
    const result = evaluateEligibility(opportunity(), capacity({ jurisdictions: [] }), ctx());
    expect(resultFor("JURISDICTION", result.results)[0]?.status).toBe("UNKNOWN");
  });
});

describe("MCC_PRODUCT", () => {
  it("passes when every requested MCC is accepted", () => {
    const result = evaluateEligibility(opportunity({ mccs: ["5411", "5812"] }), capacity({ mccsAccepted: ["5411", "5812", "5999"] }), ctx());
    expect(resultFor("MCC_PRODUCT", result.results)[0]?.status).toBe("PASS");
  });

  it("blocks when an MCC is explicitly excluded, even if it's also in the accepted list", () => {
    const result = evaluateEligibility(opportunity({ mccs: ["5411"] }), capacity({ mccsAccepted: ["5411"], mccsExcluded: ["5411"] }), ctx());
    const finding = resultFor("MCC_PRODUCT", result.results)[0]!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.code).toBe("MCC_EXCLUDED");
    expect(finding.overridable).toBe(false);
  });

  it("blocks when an MCC is simply not in the accepted list", () => {
    const result = evaluateEligibility(opportunity({ mccs: ["7995"] }), capacity({ mccsAccepted: ["5411"] }), ctx());
    const finding = resultFor("MCC_PRODUCT", result.results)[0]!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.code).toBe("MCC_NOT_ACCEPTED");
  });

  it("blocks with UNKNOWN when the opportunity has no MCCs specified", () => {
    const result = evaluateEligibility(opportunity({ mccs: [] }), capacity(), ctx());
    expect(resultFor("MCC_PRODUCT", result.results)[0]?.status).toBe("UNKNOWN");
  });

  it("blocks with UNKNOWN when the provider's accepted-MCC list is empty (not yet configured)", () => {
    const result = evaluateEligibility(opportunity(), capacity({ mccsAccepted: [] }), ctx());
    const finding = resultFor("MCC_PRODUCT", result.results)[0]!;
    expect(finding.status).toBe("UNKNOWN");
    expect(finding.code).toBe("MCC_ACCEPTED_LIST_EMPTY");
  });
});

describe("VOLUME_TICKET", () => {
  it("contributes exactly two findings when ticket size is unsupplied (headroom + a non-blocking ticket UNKNOWN)", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    const findings = resultFor("VOLUME_TICKET", result.results);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.code)).toEqual(expect.arrayContaining(["VOLUME_HEADROOM_OK", "TICKET_SIZE_NOT_SUPPLIED"]));
    expect(findings.find((f) => f.code === "TICKET_SIZE_NOT_SUPPLIED")?.blocking).toBe(false);
  });

  it("blocks when the provider is not accepting new volume", () => {
    const result = evaluateEligibility(opportunity(), capacity({ acceptingNewVolume: false }), ctx());
    const finding = resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "VOLUME_NOT_ACCEPTING")!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.blocking).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it("blocks when capacity headroom is below the configured minimum ratio", () => {
    // demand 1,000,000 minor, capacity only 500,000 -> ratio 0.5x < 1.0x minimum
    const result = evaluateEligibility(opportunity({ movable30dMinor: 1_000_000n }), capacity({ monthlyCapacityMinor: 500_000n }), ctx());
    const finding = resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "VOLUME_INSUFFICIENT_HEADROOM")!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.blocking).toBe(true);
  });

  it("passes headroom exactly at the 1.0x floor", () => {
    const result = evaluateEligibility(opportunity({ movable30dMinor: 1_000_000n }), capacity({ monthlyCapacityMinor: 1_000_000n }), ctx());
    expect(resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "VOLUME_HEADROOM_OK")).toBeTruthy();
  });

  it("reports headroom as non-blocking UNKNOWN (deferring to SETTLEMENT) when currencies mismatch", () => {
    const result = evaluateEligibility(opportunity({ currency: "USD" }), capacity({ currency: "EUR" }), ctx());
    const finding = resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "VOLUME_CURRENCY_MISMATCH")!;
    expect(finding.status).toBe("UNKNOWN");
    expect(finding.blocking).toBe(false);
  });

  it("checks ticket size when context.averageTicketMinor is supplied — passes inside range", () => {
    const result = evaluateEligibility(opportunity(), capacity({ minTicketMinor: 100, maxTicketMinor: 10_000 }), ctx({ averageTicketMinor: 5_000 }));
    expect(resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "TICKET_SIZE_OK")).toBeTruthy();
  });

  it("blocks when the average ticket is below the provider's minimum", () => {
    const result = evaluateEligibility(opportunity(), capacity({ minTicketMinor: 1_000 }), ctx({ averageTicketMinor: 100 }));
    const finding = resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "TICKET_SIZE_OUT_OF_RANGE")!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(result.eligible).toBe(false);
  });

  it("blocks when the average ticket exceeds the provider's maximum", () => {
    const result = evaluateEligibility(opportunity(), capacity({ maxTicketMinor: 1_000 }), ctx({ averageTicketMinor: 50_000 }));
    expect(resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "TICKET_SIZE_OUT_OF_RANGE")).toBeTruthy();
  });

  it("a maxTicketMinor of 0 is treated as 'no configured ceiling', never a false breach", () => {
    const result = evaluateEligibility(opportunity(), capacity({ maxTicketMinor: 0, minTicketMinor: 0 }), ctx({ averageTicketMinor: 1_000_000 }));
    expect(resultFor("VOLUME_TICKET", result.results).find((f) => f.code === "TICKET_SIZE_OK")).toBeTruthy();
  });

  it("rejects a negative averageTicketMinor", () => {
    expect(() => evaluateEligibility(opportunity(), capacity(), ctx({ averageTicketMinor: -1 }))).toThrow(EligibilityInputError);
  });
});

describe("EVIDENCE_LICENSE (Passport readiness — earlier input)", () => {
  it("passes for READY", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ providerPassportStatus: "READY" }));
    expect(resultFor("EVIDENCE_LICENSE", result.results)[0]?.status).toBe("PASS");
  });

  it("passes for VERIFIED", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ providerPassportStatus: "VERIFIED" }));
    expect(resultFor("EVIDENCE_LICENSE", result.results)[0]?.status).toBe("PASS");
  });

  it.each(["DRAFT", "INCOMPLETE", "SUSPENDED"] as const)("blocks (BLOCKED, non-overridable) for %s — mandatory evidence absent", (status) => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ providerPassportStatus: status }));
    const finding = resultFor("EVIDENCE_LICENSE", result.results)[0]!;
    expect(finding.status).toBe("BLOCKED");
    expect(finding.code).toBe("EVIDENCE_LICENSE_NOT_READY");
    expect(finding.overridable).toBe(false);
    expect(result.eligible).toBe(false);
  });

  it("blocks for STALE — mandatory evidence expired", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ providerPassportStatus: "STALE" }));
    const finding = resultFor("EVIDENCE_LICENSE", result.results)[0]!;
    expect(finding.status).toBe("BLOCKED");
    expect(finding.message).toMatch(/expired/);
  });

  it("fails CLOSED (BLOCKED, non-overridable) when Passport status is not supplied at all", () => {
    const contextWithoutPassportStatus: MatchContext = { now: new Date("2026-08-18T12:00:00.000Z") };
    const result = evaluateEligibility(opportunity(), capacity(), contextWithoutPassportStatus);
    const finding = resultFor("EVIDENCE_LICENSE", result.results)[0]!;
    expect(finding.status).toBe("UNKNOWN");
    expect(finding.blocking).toBe(true);
    expect(finding.overridable).toBe(false);
    expect(result.eligible).toBe(false);
  });
});

describe("RISK", () => {
  it("is a non-blocking UNKNOWN when no merchant risk history is supplied (new entrant, not a data gap)", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    const finding = resultFor("RISK", result.results)[0]!;
    expect(finding.status).toBe("UNKNOWN");
    expect(finding.blocking).toBe(false);
    expect(result.eligible).toBe(true);
  });

  it("passes when every supplied risk figure is within its ceiling", () => {
    const result = evaluateEligibility(opportunity(), capacity({ maxChargebackBps: 200, maxFraudBps: 200, maxRefundBps: 500 }), ctx({ merchantRiskProfile: { chargebackBps: 50, fraudBps: 30, refundBps: 100 } }));
    expect(resultFor("RISK", result.results)[0]?.status).toBe("PASS");
  });

  it("blocks when chargeback rate exceeds the ceiling", () => {
    const result = evaluateEligibility(opportunity(), capacity({ maxChargebackBps: 100 }), ctx({ merchantRiskProfile: { chargebackBps: 150 } }));
    const finding = resultFor("RISK", result.results)[0]!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.code).toBe("RISK_CEILING_EXCEEDED");
    expect(finding.message).toMatch(/chargeback/);
  });

  it("blocks when fraud rate exceeds the ceiling", () => {
    const result = evaluateEligibility(opportunity(), capacity({ maxFraudBps: 100 }), ctx({ merchantRiskProfile: { fraudBps: 999 } }));
    expect(resultFor("RISK", result.results)[0]?.message).toMatch(/fraud/);
  });

  it("blocks when refund rate exceeds the ceiling", () => {
    const result = evaluateEligibility(opportunity(), capacity({ maxRefundBps: 100 }), ctx({ merchantRiskProfile: { refundBps: 999 } }));
    expect(resultFor("RISK", result.results)[0]?.message).toMatch(/refund/);
  });

  it("rejects a negative risk figure", () => {
    expect(() => evaluateEligibility(opportunity(), capacity(), ctx({ merchantRiskProfile: { chargebackBps: -1 } }))).toThrow(EligibilityInputError);
  });
});

describe("SETTLEMENT", () => {
  it("passes on matching currency and no required-rail check", () => {
    const result = evaluateEligibility(opportunity({ currency: "USD" }), capacity({ currency: "USD" }), ctx());
    expect(resultFor("SETTLEMENT", result.results)[0]?.status).toBe("PASS");
  });

  it("blocks on currency mismatch", () => {
    const result = evaluateEligibility(opportunity({ currency: "USD" }), capacity({ currency: "GBP" }), ctx());
    const finding = resultFor("SETTLEMENT", result.results)[0]!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.code).toBe("SETTLEMENT_CURRENCY_UNSUPPORTED");
    expect(result.eligible).toBe(false);
  });

  it("passes when the required rail matches", () => {
    const result = evaluateEligibility(opportunity(), capacity({ settlementRail: "WIRE" }), ctx({ requiredSettlementRail: "WIRE" }));
    expect(resultFor("SETTLEMENT", result.results)[0]?.status).toBe("PASS");
  });

  it("blocks when a required rail is supplied and doesn't match", () => {
    const result = evaluateEligibility(opportunity(), capacity({ settlementRail: "ACH" }), ctx({ requiredSettlementRail: "WIRE" }));
    const finding = resultFor("SETTLEMENT", result.results)[0]!;
    expect(finding.status).toBe("INELIGIBLE");
    expect(finding.code).toBe("SETTLEMENT_RAIL_UNSUPPORTED");
  });
});

describe("TECHNICAL", () => {
  it("always reports a non-blocking UNKNOWN (CapacityProfile has no TechnicalCapability field yet)", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    const finding = resultFor("TECHNICAL", result.results)[0]!;
    expect(finding.status).toBe("UNKNOWN");
    expect(finding.blocking).toBe(false);
    expect(result.eligible).toBe(true);
  });
});

describe("FRESHNESS (the spec)", () => {
  it("FRESH passes", () => {
    const result = evaluateEligibility(opportunity(), capacity({ freshnessClass: "FRESH" }), ctx());
    expect(resultFor("FRESHNESS", result.results)[0]?.status).toBe("PASS");
  });

  it("AGING is a non-blocking REFRESH_REQUIRED warning — still eligible", () => {
    const result = evaluateEligibility(opportunity(), capacity({ freshnessClass: "AGING" }), ctx());
    const finding = resultFor("FRESHNESS", result.results)[0]!;
    expect(finding.status).toBe("REFRESH_REQUIRED");
    expect(finding.blocking).toBe(false);
    expect(result.eligible).toBe(true);
    expect(result.warnings).toContainEqual(finding);
  });

  it("STALE hard-blocks but is operator-overridable", () => {
    const result = evaluateEligibility(opportunity(), capacity({ freshnessClass: "STALE" }), ctx());
    const finding = resultFor("FRESHNESS", result.results)[0]!;
    expect(finding.status).toBe("REFRESH_REQUIRED");
    expect(finding.code).toBe("FRESHNESS_STALE");
    expect(finding.blocking).toBe(true);
    expect(finding.overridable).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it("UNKNOWN hard-blocks and is NON-overridable (the spec: 'not counted as active marketplace capacity')", () => {
    const result = evaluateEligibility(opportunity(), capacity({ freshnessClass: "UNKNOWN" }), ctx());
    const finding = resultFor("FRESHNESS", result.results)[0]!;
    expect(finding.code).toBe("FRESHNESS_UNKNOWN");
    expect(finding.blocking).toBe(true);
    expect(finding.overridable).toBe(false);
  });

  it("rejects an out-of-enum freshnessClass at runtime (domain-guard hardening precedent) rather than silently passing", () => {
    expect(() => evaluateEligibility(opportunity(), capacity({ freshnessClass: "NOT_A_CLASS" as never }), ctx())).toThrow(EligibilityInputError);
  });
});

describe("COMPLIANCE_HOLD", () => {
  it("passes ('no known hold') when context.complianceHold is omitted — no screening system exists yet (ADR-0012)", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx());
    const finding = resultFor("COMPLIANCE_HOLD", result.results)[0]!;
    expect(finding.status).toBe("PASS");
    expect(finding.code).toBe("COMPLIANCE_HOLD_NONE_KNOWN");
  });

  it("passes when complianceHold.active is explicitly false", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ complianceHold: { active: false } }));
    expect(resultFor("COMPLIANCE_HOLD", result.results)[0]?.status).toBe("PASS");
  });

  it("blocks (BLOCKED, non-overridable) when a hold is active", () => {
    const result = evaluateEligibility(opportunity(), capacity(), ctx({ complianceHold: { active: true, reason: "OFAC list match pending review" } }));
    const finding = resultFor("COMPLIANCE_HOLD", result.results)[0]!;
    expect(finding.status).toBe("BLOCKED");
    expect(finding.overridable).toBe(false);
    expect(finding.message).toMatch(/OFAC list match pending review/);
    expect(result.eligible).toBe(false);
  });
});

describe("overridable flags — config completeness", () => {
  it("every non-PASS code this suite has exercised has an explicit (non-fallback) entry in MATCHING_CONFIG.overridableByCode", () => {
    // Runs a representative sweep and asserts every code seen is a REAL
    // key in the config map, not merely a value that happens to equal the
    // fallback — guards against a future new rule code silently relying
    // on overridableFor's fail-closed default instead of a deliberate
    // policy choice (same "config completeness" discipline as
    // @tol/attribution's scoring.test.ts).
    const scenarios: Array<[MatchOpportunityInput, MatchCapacityInput, MatchContext]> = [
      [opportunity({ jurisdictions: [] }), capacity(), ctx()],
      [opportunity({ jurisdictions: ["ZZ"] }), capacity(), ctx()],
      [opportunity({ mccs: [] }), capacity(), ctx()],
      [opportunity(), capacity({ mccsAccepted: [] }), ctx()],
      [opportunity(), capacity({ mccsExcluded: ["5411"] }), ctx()],
      [opportunity({ mccs: ["9999"] }), capacity(), ctx()],
      [opportunity(), capacity({ acceptingNewVolume: false }), ctx()],
      [opportunity({ currency: "EUR" }), capacity({ currency: "USD" }), ctx()],
      [opportunity({ movable30dMinor: 10_000_000n }), capacity({ monthlyCapacityMinor: 1n }), ctx()],
      [opportunity(), capacity(), ctx({ averageTicketMinor: 50 })],
      [opportunity(), capacity(), ctx()],
      [opportunity(), capacity(), ctx({ providerPassportStatus: "INCOMPLETE" })],
      [opportunity(), capacity(), { ...ctx(), providerPassportStatus: undefined }],
      [opportunity(), capacity(), ctx({ merchantRiskProfile: { chargebackBps: 9999 }, }) ],
      [opportunity(), capacity({ settlementRail: "ACH" }), ctx({ requiredSettlementRail: "WIRE" })],
      [opportunity(), capacity({ freshnessClass: "AGING" }), ctx()],
      [opportunity(), capacity({ freshnessClass: "STALE" }), ctx()],
      [opportunity(), capacity({ freshnessClass: "UNKNOWN" }), ctx()],
      [opportunity(), capacity(), ctx({ complianceHold: { active: true } })],
    ];
    const seenCodes = new Set<string>();
    for (const [opp, cap, c] of scenarios) {
      for (const r of evaluateEligibility(opp, cap, c).results) seenCodes.add(r.code);
    }
    expect(seenCodes.size).toBeGreaterThan(15);
    for (const code of seenCodes) {
      expect(MATCHING_CONFIG.overridableByCode).toHaveProperty(code);
    }
  });
});

describe("determinism (same inputs -> identical output, run many times — the spec)", () => {
  it("500 calls with identical opportunity/capacity/context produce a deep-equal EligibilityResult", () => {
    const opp = opportunity({ jurisdictions: ["US", "CA"], mccs: ["5411", "5812"] });
    const cap = capacity({ jurisdictions: ["US", "CA", "MX"], mccsAccepted: ["5411", "5812"] });
    const c = ctx({ merchantRiskProfile: { chargebackBps: 40, fraudBps: 20 }, averageTicketMinor: 2_500, inputVersions: ["opportunity:v2"] });
    const first = evaluateEligibility(opp, cap, c);
    for (let i = 0; i < 500; i++) {
      expect(evaluateEligibility(opp, cap, c)).toEqual(first);
    }
  });

  it("determinism holds for an INELIGIBLE result too (not just the happy path)", () => {
    const opp = opportunity({ jurisdictions: ["US"] });
    const cap = capacity({ jurisdictions: ["DE"], freshnessClass: "STALE" });
    const c = ctx({ providerPassportStatus: "SUSPENDED" });
    const first = evaluateEligibility(opp, cap, c);
    expect(first.eligible).toBe(false);
    for (let i = 0; i < 50; i++) {
      expect(evaluateEligibility(opp, cap, c)).toEqual(first);
    }
  });

  it("does not mutate its inputs", () => {
    const opp = opportunity();
    const cap = capacity();
    const oppCopy = JSON.parse(JSON.stringify(opp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const capCopy = JSON.parse(JSON.stringify(cap, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    evaluateEligibility(opp, cap, ctx());
    expect(JSON.parse(JSON.stringify(opp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))).toEqual(oppCopy);
    expect(JSON.parse(JSON.stringify(cap, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))).toEqual(capCopy);
  });
});

describe("invariant: eligible iff blockers is empty (the spec)", () => {
  it("a warning-only result (AGING freshness, no risk history) is still eligible", () => {
    const result = evaluateEligibility(opportunity(), capacity({ freshnessClass: "AGING" }), ctx());
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
  });

  it("results = blockers + warnings + passes, partitioned with no overlap and no loss", () => {
    const result = evaluateEligibility(opportunity({ jurisdictions: ["ZZ"] }), capacity({ freshnessClass: "AGING" }), ctx());
    const nonPass = result.results.filter((r) => r.status !== "PASS");
    expect(result.blockers.length + result.warnings.length).toBe(nonPass.length);
    for (const b of result.blockers) expect(result.warnings).not.toContainEqual(b);
  });
});

describe("input validation", () => {
  it("rejects a malformed opportunity currency", () => {
    expect(() => evaluateEligibility(opportunity({ currency: "US" }), capacity(), ctx())).toThrow(EligibilityInputError);
  });

  it("rejects a malformed capacity currency", () => {
    expect(() => evaluateEligibility(opportunity(), capacity({ currency: "DOLLARS" }), ctx())).toThrow(EligibilityInputError);
  });

  it("rejects a negative movable30dMinor", () => {
    expect(() => evaluateEligibility(opportunity({ movable30dMinor: -1n }), capacity(), ctx())).toThrow(EligibilityInputError);
  });

  it("rejects a negative monthlyCapacityMinor", () => {
    expect(() => evaluateEligibility(opportunity(), capacity({ monthlyCapacityMinor: -1n }), ctx())).toThrow(EligibilityInputError);
  });

  it("regression (review, real BLOCKER): rejects an empty settlementRail rather than letting it silently pass SETTLEMENT with a nonsensical empty-string message", () => {
    expect(() => evaluateEligibility(opportunity(), capacity({ settlementRail: "" }), ctx())).toThrow(EligibilityInputError);
    expect(() => evaluateEligibility(opportunity(), capacity({ settlementRail: "   " }), ctx())).toThrow(/settlementRail/);
  });

  it("regression (review, real MAJOR): rejects an inverted ticket range (maxTicketMinor < minTicketMinor) instead of silently reporting every ticket size out of range under a backwards-looking bound", () => {
    expect(() => evaluateEligibility(opportunity(), capacity({ minTicketMinor: 5_000, maxTicketMinor: 1_000 }), ctx())).toThrow(EligibilityInputError);
  });

  it("a maxTicketMinor of 0 (the documented 'no configured ceiling' sentinel) is exempt from the inverted-range check even when minTicketMinor is nonzero", () => {
    expect(() => evaluateEligibility(opportunity(), capacity({ minTicketMinor: 5_000, maxTicketMinor: 0 }), ctx())).not.toThrow();
  });
});
