import { describe, expect, it } from "vitest";
import { LoginRequestSchema } from "./auth.js";
import { UpdateOrganizationRequestSchema } from "./organization.js";
import { CreateMembershipRequestSchema } from "./membership.js";
import { CreateOpportunityRequestSchema } from "./opportunity.js";
import { CreateCapacityProfileRequestSchema } from "./capacity.js";
import { CreateRfqRequestSchema, QuoteTermsSchema, SubmitQuoteRequestSchema } from "./rfq.js";
import { PostConditionRequestSchema, RecordDecisionRequestSchema } from "./deal.js";
import { LockboxPayloadSchema, ReleaseLockboxRequestSchema, SealLockboxRequestSchema, WithdrawLockboxRequestSchema } from "./lockbox.js";
import { ClaimScopeSchema, CreateClaimRequestSchema, DecideClaimRequestSchema, FileClaimDisputeRequestSchema } from "./claim.js";
import { AdjustLedgerRequestSchema, CommissionComponentInputSchema, CreateScheduleRequestSchema, RecordPaymentRequestSchema, RecordRevenueEventRequestSchema } from "./economics.js";

describe("LoginRequestSchema", () => {
  it("accepts a well-formed login request", () => {
    expect(LoginRequestSchema.safeParse({ email: "a@b.com", password: "x" }).success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(LoginRequestSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(LoginRequestSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });
});

describe("UpdateOrganizationRequestSchema", () => {
  it("rejects an empty patch object (nothing to update)", () => {
    expect(UpdateOrganizationRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a partial patch", () => {
    expect(UpdateOrganizationRequestSchema.safeParse({ displayName: "New Name" }).success).toBe(true);
  });

  it("rejects a non-URL website", () => {
    expect(UpdateOrganizationRequestSchema.safeParse({ website: "not a url" }).success).toBe(false);
  });
});

describe("CreateMembershipRequestSchema", () => {
  it("rejects an invalid PersonaRole value", () => {
    const result = CreateMembershipRequestSchema.safeParse({
      userId: "01a0133d-5a16-7e60-9fb1-10e87cbab6f8",
      role: "SUPER_ADMIN",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid request", () => {
    const result = CreateMembershipRequestSchema.safeParse({
      userId: "01a0133d-5a16-7e60-9fb1-10e87cbab6f8",
      role: "MERCHANT_PSP_USER",
    });
    expect(result.success).toBe(true);
  });
});

describe("earlier: CreateOpportunityRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    expect(
      CreateOpportunityRequestSchema.safeParse({
        opportunityType: "ACQUIRING",
        requestedService: "US e-commerce acquiring",
        currency: "USD",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-integer-string money field (p.12: never floating point)", () => {
    const result = CreateOpportunityRequestSchema.safeParse({
      opportunityType: "ACQUIRING",
      requestedService: "x",
      currency: "USD",
      totalPaymentVolumeMinor: "45000000.50",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid opportunityType", () => {
    const result = CreateOpportunityRequestSchema.safeParse({
      opportunityType: "NOT_A_TYPE",
      requestedService: "x",
      currency: "USD",
    });
    expect(result.success).toBe(false);
  });
});

describe("earlier: CreateCapacityProfileRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    expect(
      CreateCapacityProfileRequestSchema.safeParse({ currency: "USD", settlementRail: "ACH" }).success,
    ).toBe(true);
  });

  it("rejects a bps value above the 1,000,000 ceiling", () => {
    const result = CreateCapacityProfileRequestSchema.safeParse({
      currency: "USD",
      settlementRail: "ACH",
      maxChargebackBps: 2_000_000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative bps value", () => {
    const result = CreateCapacityProfileRequestSchema.safeParse({
      currency: "USD",
      settlementRail: "ACH",
      maxFraudBps: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("earlier: QuoteTermsSchema", () => {
  const validTerms = {
    rate: { basisType: "blended", bps: 285, scope: "all_volume", passThrough: false },
    reserve: { type: "rolling", bps: 500, durationDays: 90 },
    settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
    capacityOffer: { monthlyAmountMinor: 3_000_000_000, rampSchedule: "90-day ramp", confidenceBps: 8000 },
  };

  it("accepts well-formed terms", () => {
    expect(QuoteTermsSchema.safeParse(validTerms).success).toBe(true);
  });

  it("rejects a floating-point bps value (p.12: never floating point)", () => {
    const bad = { ...validTerms, rate: { ...validTerms.rate, bps: 285.5 } };
    expect(QuoteTermsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a negative capacityOffer.monthlyAmountMinor", () => {
    const bad = { ...validTerms, capacityOffer: { ...validTerms.capacityOffer, monthlyAmountMinor: -1 } };
    expect(QuoteTermsSchema.safeParse(bad).success).toBe(false);
  });

  it("SubmitQuoteRequestSchema wraps QuoteTermsSchema and rejects a missing terms field", () => {
    const result = SubmitQuoteRequestSchema.safeParse({ currency: "USD", validUntil: new Date().toISOString() });
    expect(result.success).toBe(false);
  });
});

describe("earlier: CreateRfqRequestSchema", () => {
  const base = {
    opportunityId: "01a0133d-5a16-7e60-9fb1-10e87cbab6f8",
    providerOrgIds: ["01a0133d-5a2b-742f-af72-962cb6287e26"],
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    disclosureSnapshot: {
      opportunitySummary: { requestedService: "x", jurisdictions: ["US"], mccs: ["5411"] },
      evidenceRefs: [],
    },
  };

  it("accepts a well-formed request", () => {
    expect(CreateRfqRequestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an empty providerOrgIds invite set — an RFQ with no recipients isn't a real RFQ", () => {
    const result = CreateRfqRequestSchema.safeParse({ ...base, providerOrgIds: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID opportunityId", () => {
    const result = CreateRfqRequestSchema.safeParse({ ...base, opportunityId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate providerOrgIds in the invite set — fixed after review (review)", () => {
    const dupeId = "01a0133d-5a2b-742f-af72-962cb6287e26";
    const result = CreateRfqRequestSchema.safeParse({ ...base, providerOrgIds: [dupeId, dupeId] });
    expect(result.success).toBe(false);
  });
});

describe("earlier: QuoteRateSchema requires at least one pricing mechanism", () => {
  it("rejects a rate with neither bps nor fixedMinor — fixed after review (review)", () => {
    const result = QuoteTermsSchema.safeParse({
      rate: { basisType: "blended", scope: "all_volume", passThrough: false },
      reserve: { type: "none", durationDays: 0 },
      settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
      capacityOffer: { monthlyAmountMinor: 1000, rampSchedule: "x", confidenceBps: 5000 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a rate with only fixedMinor set (no bps)", () => {
    const result = QuoteTermsSchema.safeParse({
      rate: { basisType: "flat", fixedMinor: 500, scope: "all_volume", passThrough: false },
      reserve: { type: "none", durationDays: 0 },
      settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
      capacityOffer: { monthlyAmountMinor: 1000, rampSchedule: "x", confidenceBps: 5000 },
    });
    expect(result.success).toBe(true);
  });
});

describe("earlier: Deal Room request schemas", () => {
  it("PostConditionRequestSchema rejects an empty description", () => {
    const result = PostConditionRequestSchema.safeParse({
      description: "",
      ownerOrgId: "01a0133d-5a16-7e60-9fb1-10e87cbab6f8",
    });
    expect(result.success).toBe(false);
  });

  it("RecordDecisionRequestSchema rejects decisionType QUOTE_SELECTED — system-recorded only, never a direct client request", () => {
    const result = RecordDecisionRequestSchema.safeParse({ decisionType: "QUOTE_SELECTED", reason: "x" });
    expect(result.success).toBe(false);
  });

  it("RecordDecisionRequestSchema accepts APPROVAL/DECLINE/EXCEPTION", () => {
    for (const decisionType of ["APPROVAL", "DECLINE", "EXCEPTION"]) {
      expect(RecordDecisionRequestSchema.safeParse({ decisionType, reason: "x" }).success).toBe(true);
    }
  });
});

describe("earlier: Lockbox request schemas", () => {
  const validPayload = { counterpartyPrivate: "Acme Acquiring", evidenceSummary: "signed MSA on file", priorDealHistory: "3 prior deals, 2024-2025" };

  it("SealLockboxRequestSchema accepts a well-formed seal request", () => {
    const result = SealLockboxRequestSchema.safeParse({
      relationshipType: "ACQUIRER_RELATIONSHIP",
      region: "EU",
      payload: validPayload,
    });
    expect(result.success).toBe(true);
  });

  it("SealLockboxRequestSchema rejects an invalid relationshipType", () => {
    const result = SealLockboxRequestSchema.safeParse({ relationshipType: "NOT_A_TYPE", region: "EU", payload: validPayload });
    expect(result.success).toBe(false);
  });

  it("SealLockboxRequestSchema rejects an invalid region", () => {
    const result = SealLockboxRequestSchema.safeParse({ relationshipType: "ACQUIRER_RELATIONSHIP", region: "MARS", payload: validPayload });
    expect(result.success).toBe(false);
  });

  it("LockboxPayloadSchema rejects an empty counterpartyPrivate/evidenceSummary/priorDealHistory field", () => {
    expect(LockboxPayloadSchema.safeParse({ ...validPayload, counterpartyPrivate: "" }).success).toBe(false);
    expect(LockboxPayloadSchema.safeParse({ ...validPayload, evidenceSummary: "" }).success).toBe(false);
    expect(LockboxPayloadSchema.safeParse({ ...validPayload, priorDealHistory: "" }).success).toBe(false);
  });

  it("WithdrawLockboxRequestSchema accepts an empty body (withdrawReason is optional)", () => {
    expect(WithdrawLockboxRequestSchema.safeParse({}).success).toBe(true);
  });

  it("ReleaseLockboxRequestSchema requires both recipientOrgId and conditionRef as UUIDs", () => {
    expect(
      ReleaseLockboxRequestSchema.safeParse({
        recipientOrgId: "01a0133d-5a16-7e60-9fb1-10e87cbab6f8",
        conditionRef: "01a0133d-5a2b-742f-af72-962cb6287e26",
      }).success,
    ).toBe(true);
    expect(ReleaseLockboxRequestSchema.safeParse({ recipientOrgId: "not-a-uuid", conditionRef: "01a0133d-5a2b-742f-af72-962cb6287e26" }).success).toBe(false);
    expect(ReleaseLockboxRequestSchema.safeParse({ recipientOrgId: "01a0133d-5a16-7e60-9fb1-10e87cbab6f8" }).success).toBe(false); // conditionRef missing
  });
});

describe("earlier: Attribution (Claim) request schemas", () => {
  const validClaim = {
    subjectOrgId: "01a0133d-5a2b-742f-af72-962cb6287e26",
    relationshipType: "ACQUIRER_INTRODUCTION",
    directnessTier: "D4",
    priorCommercialHistoryMonths: 8,
    submissionLagDays: 3,
    evidenceItems: [{ evidenceType: "EMAIL_THREAD", assertedFact: "Intro thread on file." }],
  };

  it("CreateClaimRequestSchema accepts a well-formed claim with evidence", () => {
    expect(CreateClaimRequestSchema.safeParse(validClaim).success).toBe(true);
  });

  it("CreateClaimRequestSchema accepts an empty evidenceItems array (scope's own anti-gaming test needs a claim with NO evidence to be a structurally valid, if weak, input)", () => {
    expect(CreateClaimRequestSchema.safeParse({ ...validClaim, evidenceItems: [] }).success).toBe(true);
  });

  it("CreateClaimRequestSchema rejects an invalid directnessTier", () => {
    expect(CreateClaimRequestSchema.safeParse({ ...validClaim, directnessTier: "D9" }).success).toBe(false);
  });

  it("CreateClaimRequestSchema rejects negative priorCommercialHistoryMonths/submissionLagDays", () => {
    expect(CreateClaimRequestSchema.safeParse({ ...validClaim, priorCommercialHistoryMonths: -1 }).success).toBe(false);
    expect(CreateClaimRequestSchema.safeParse({ ...validClaim, submissionLagDays: -1 }).success).toBe(false);
  });

  it("CreateClaimRequestSchema rejects a malformed subjectOrgId", () => {
    expect(CreateClaimRequestSchema.safeParse({ ...validClaim, subjectOrgId: "not-a-uuid" }).success).toBe(false);
  });

  it("CreateClaimRequestSchema rejects an evidence item with an invalid evidenceType", () => {
    const result = CreateClaimRequestSchema.safeParse({
      ...validClaim,
      evidenceItems: [{ evidenceType: "NOT_A_TYPE", assertedFact: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("ClaimScopeSchema accepts an empty object (maximally broad scope) and rejects unknown keys (.strict())", () => {
    expect(ClaimScopeSchema.safeParse({}).success).toBe(true);
    expect(ClaimScopeSchema.safeParse({ geography: "US" }).success).toBe(true);
    expect(ClaimScopeSchema.safeParse({ notARealField: "x" }).success).toBe(false);
  });

  it("FileClaimDisputeRequestSchema requires a non-empty basis, evidence is optional", () => {
    expect(FileClaimDisputeRequestSchema.safeParse({ basis: "A later direct executive relationship supersedes." }).success).toBe(true);
    expect(FileClaimDisputeRequestSchema.safeParse({ basis: "" }).success).toBe(false);
  });

  it("FileClaimDisputeRequestSchema accepts basis AND evidence combined (review: the basis-only and evidence-omitted cases were both covered, not the combined happy path)", () => {
    const result = FileClaimDisputeRequestSchema.safeParse({
      basis: "A later direct executive relationship supersedes.",
      evidence: [{ evidenceType: "COUNTERPARTY_ACKNOWLEDGMENT", note: "Subject org acknowledged the executive contact directly." }],
    });
    expect(result.success).toBe(true);
  });

  it("DecideClaimRequestSchema requires a valid ClaimDecisionOutcome and non-empty reason, and has NO disputeId field — the server infers which dispute (if any) resolves from the claim's own current state", () => {
    expect(DecideClaimRequestSchema.safeParse({ decision: "VERIFIED", reason: "Evidence corroborated." }).success).toBe(true);
    expect(DecideClaimRequestSchema.safeParse({ decision: "DISPUTED", reason: "x" }).success).toBe(false); // DISPUTED is a Claim.status, never a ClaimDecision.decision — see claim-states.ts
    expect(DecideClaimRequestSchema.safeParse({ decision: "VERIFIED", reason: "" }).success).toBe(false);
    expect("disputeId" in DecideClaimRequestSchema.shape).toBe(false);
  });
});

describe("earlier Economics (P15) request schemas", () => {
  const ORG = "00000000-0000-7000-8000-00000000000a";

  it("CommissionComponentInputSchema requires bps XOR fixedAmountMinor to match componentType", () => {
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", bps: 2000, priority: 1 }).success).toBe(true);
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "FIXED_AMOUNT", fixedAmountMinor: "100", priority: 1 }).success).toBe(true);
    // Wrong field for the type — rejected.
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", fixedAmountMinor: "100", priority: 1 }).success).toBe(false);
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "FIXED_AMOUNT", bps: 2000, priority: 1 }).success).toBe(false);
    // Both, or neither — also rejected.
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", bps: 2000, fixedAmountMinor: "100", priority: 1 }).success).toBe(false);
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", priority: 1 }).success).toBe(false);
  });

  it("CommissionComponentInputSchema rejects bps outside 0-10000", () => {
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", bps: 10_001, priority: 1 }).success).toBe(false);
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", bps: -1, priority: 1 }).success).toBe(false);
    expect(CommissionComponentInputSchema.safeParse({ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", bps: 10_000, priority: 1 }).success).toBe(true);
  });

  it("CreateScheduleRequestSchema requires at least one component", () => {
    expect(CreateScheduleRequestSchema.safeParse({ basis: "GROSS_PROCESSING_VOLUME", components: [] }).success).toBe(false);
    expect(
      CreateScheduleRequestSchema.safeParse({
        basis: "GROSS_PROCESSING_VOLUME",
        components: [{ recipientType: "PLATFORM", recipientOrgId: ORG, componentType: "PERCENTAGE_BPS", bps: 10_000, priority: 1 }],
      }).success,
    ).toBe(true);
  });

  it("RecordRevenueEventRequestSchema has NO netDistributableMinor field — the server always computes it, never trusts a client-supplied figure", () => {
    expect("netDistributableMinor" in RecordRevenueEventRequestSchema.shape).toBe(false);
    expect(
      RecordRevenueEventRequestSchema.safeParse({ basis: "GROSS_PROCESSING_VOLUME", period: "2026-08", source: "processing_volume", grossAmountMinor: "50000000", currency: "USD" }).success,
    ).toBe(true);
  });

  it("RecordRevenueEventRequestSchema rejects a non-integer-string grossAmountMinor (never a JSON number, never a decimal)", () => {
    expect(RecordRevenueEventRequestSchema.safeParse({ basis: "GROSS_PROCESSING_VOLUME", period: "2026-08", source: "x", grossAmountMinor: "not-a-number", currency: "USD" }).success).toBe(false);
    expect(RecordRevenueEventRequestSchema.safeParse({ basis: "GROSS_PROCESSING_VOLUME", period: "2026-08", source: "x", grossAmountMinor: "100.50", currency: "USD" }).success).toBe(false);
  });

  it("RecordPaymentRequestSchema requires at least one payment line", () => {
    expect(RecordPaymentRequestSchema.safeParse({ payments: [], reference: "ref-1" }).success).toBe(false);
    expect(RecordPaymentRequestSchema.safeParse({ payments: [{ accrualRootId: ORG, amountMinor: "100" }], reference: "ref-1" }).success).toBe(true);
  });

  it("AdjustLedgerRequestSchema requires a non-empty reason (the spec's Adjustment.reason)", () => {
    expect(AdjustLedgerRequestSchema.safeParse({ direction: "CREDIT", amountMinor: "100", reason: "" }).success).toBe(false);
    expect(AdjustLedgerRequestSchema.safeParse({ direction: "CREDIT", amountMinor: "100", reason: "Correction for a misapplied rate." }).success).toBe(true);
  });
});
