// packages/contracts/src/rfq.ts — the spec. P13's "versioned
// disclosure + quote" gate exit condition, wire-contracted.

import { z } from "zod";
import { DisclosureClassSchema, UuidSchema } from "./common.js";

export const RFQ_STATUS_VALUES = [
  "DRAFT",
  "SENT",
  "ACKNOWLEDGED",
  "QUESTIONS",
  "QUOTED",
  "EXPIRED",
  "DECLINED",
  "SELECTED",
] as const;
export const RfqStatusSchema = z.enum(RFQ_STATUS_VALUES);

export const RFQ_RECIPIENT_STATE_VALUES = ["INVITED", "ACKNOWLEDGED", "DECLINED", "QUOTED", "EXPIRED"] as const;
export const RfqRecipientStateSchema = z.enum(RFQ_RECIPIENT_STATE_VALUES);

export const QUOTE_STATUS_VALUES = ["SUBMITTED", "SELECTED", "REJECTED", "EXPIRED", "WITHDRAWN"] as const;
export const QuoteStatusSchema = z.enum(QUOTE_STATUS_VALUES);

export const DISCLOSURE_PACKET_TYPE_VALUES = ["MATCH_SUMMARY", "QUALIFIED_RFQ", "DUE_DILIGENCE", "RESTRICTED"] as const;
export const DisclosurePacketTypeSchema = z.enum(DISCLOSURE_PACKET_TYPE_VALUES);

const MinorUnitsSchema = z.number().int().nonnegative();
const BpsSchema = z.number().int().min(0).max(1_000_000);

// ---- p.21: RFQVersion.disclosureSnapshot ("Named entity + normalized opportunity + selected evidence") ----
export const DisclosureSnapshotSchema = z.object({
  opportunitySummary: z.object({
    requestedService: z.string(),
    jurisdictions: z.array(z.string()),
    mccs: z.array(z.string()),
  }),
  evidenceRefs: z.array(z.string()).default([]),
});
export type DisclosureSnapshot = z.infer<typeof DisclosureSnapshotSchema>;

export const RFQVersionDTOSchema = z.object({
  id: UuidSchema,
  rfqId: UuidSchema,
  versionNumber: z.number().int().positive(),
  packetType: DisclosurePacketTypeSchema,
  disclosureSnapshot: DisclosureSnapshotSchema,
  changeSummary: z.string().nullable(),
  createdAt: z.string(),
});
export type RFQVersionDTO = z.infer<typeof RFQVersionDTOSchema>;

export const RFQRecipientDTOSchema = z.object({
  id: UuidSchema,
  rfqId: UuidSchema,
  providerOrgId: UuidSchema,
  providerDisplayName: z.string().optional(),
  state: RfqRecipientStateSchema,
  acknowledgedAt: z.string().nullable(),
  declineReason: z.string().nullable(),
});
export type RFQRecipientDTO = z.infer<typeof RFQRecipientDTOSchema>;

// ---- p.21: Quote.terms (QuoteRate/ReserveTerm/SettlementTerm/CapacityOffer folded together, ADR-0008) ----
export const QuoteRateSchema = z
  .object({
    basisType: z.enum(["blended", "interchange_plus", "flat"]),
    bps: BpsSchema.optional(),
    fixedMinor: MinorUnitsSchema.optional(),
    scope: z.enum(["all_volume", "card_present", "card_not_present"]),
    passThrough: z.boolean(),
  })
  // Fixed after review (review,
  // 2026-08-18): a rate with neither bps nor a fixed amount prices
  // nothing — a real gap that would let an empty-pricing quote reach a
  // merchant's comparison view.
  .refine((v) => v.bps !== undefined || v.fixedMinor !== undefined, {
    message: "at least one of bps or fixedMinor must be provided — a rate with neither prices nothing",
  });
export const ReserveTermSchema = z.object({
  type: z.enum(["rolling", "fixed", "none"]),
  bps: BpsSchema.optional(),
  amountMinor: MinorUnitsSchema.optional(),
  durationDays: z.number().int().nonnegative(),
});
export const SettlementTermSchema = z.object({
  currency: z.string().length(3),
  rail: z.string().min(1).max(50),
  cadenceDays: z.number().int().nonnegative(),
});
export const CapacityOfferSchema = z.object({
  monthlyAmountMinor: MinorUnitsSchema,
  rampSchedule: z.string().max(200),
  confidenceBps: BpsSchema,
});
export const QuoteTermsSchema = z.object({
  rate: QuoteRateSchema,
  reserve: ReserveTermSchema,
  settlement: SettlementTermSchema,
  capacityOffer: CapacityOfferSchema,
});
export type QuoteTerms = z.infer<typeof QuoteTermsSchema>;

export const QuoteDTOSchema = z.object({
  id: UuidSchema,
  rfqId: UuidSchema,
  rfqRecipientId: UuidSchema,
  providerOrgId: UuidSchema,
  quoteVersion: z.number().int().positive(),
  currency: z.string().length(3),
  status: QuoteStatusSchema,
  validUntil: z.string(),
  submittedAt: z.string(),
  terms: QuoteTermsSchema,
});
export type QuoteDTO = z.infer<typeof QuoteDTOSchema>;

export const RFQDTOSchema = z.object({
  id: UuidSchema,
  opportunityId: UuidSchema,
  status: RfqStatusSchema,
  dueAt: z.string(),
  currentVersionNumber: z.number().int().positive(),
  currentVersion: RFQVersionDTOSchema.optional(),
  recipients: z.array(RFQRecipientDTOSchema).optional(),
  /** Populated per-viewer: a provider sees only their OWN quote(s) (p.21: "Providers never see competing quotes"); the merchant/operator sees all. Mapper-computed, never a blanket field. */
  quotes: z.array(QuoteDTOSchema).optional(),
  privacyClass: DisclosureClassSchema,
});
export type RFQDTO = z.infer<typeof RFQDTOSchema>;

// ---- Requests ----

export const CreateRfqRequestSchema = z
  .object({
    opportunityId: UuidSchema,
    providerOrgIds: z.array(UuidSchema).min(1).max(50),
    dueAt: z.string().datetime(),
    packetType: DisclosurePacketTypeSchema.optional(),
    disclosureSnapshot: DisclosureSnapshotSchema,
  })
  // Fixed after review (review,
  // 2026-08-18): a duplicate providerOrgId would let the SECOND
  // rfqRecipientRepository.create() call for the same (rfqId,
  // providerOrgId) pair hit the @@unique constraint mid-transaction,
  // surfacing as an unhandled 500 instead of a clean 400 — caught here,
  // at the wire boundary, before it ever reaches the service.
  .refine((v) => new Set(v.providerOrgIds).size === v.providerOrgIds.length, {
    message: "providerOrgIds must not contain duplicates",
    path: ["providerOrgIds"],
  });
export type CreateRfqRequest = z.infer<typeof CreateRfqRequestSchema>;

export const DeclineRfqRequestSchema = z.object({
  declineReason: z.string().min(1).max(1000),
});
export type DeclineRfqRequest = z.infer<typeof DeclineRfqRequestSchema>;

export const SubmitQuoteRequestSchema = z.object({
  currency: z.string().length(3),
  validUntil: z.string().datetime(),
  terms: QuoteTermsSchema,
});
export type SubmitQuoteRequest = z.infer<typeof SubmitQuoteRequestSchema>;

export const SelectQuoteRequestSchema = z.object({
  quoteId: UuidSchema,
  reason: z.string().min(1).max(1000),
});
export type SelectQuoteRequest = z.infer<typeof SelectQuoteRequestSchema>;

export const ListRfqsResponseSchema = z.object({ rfqs: z.array(RFQDTOSchema) });
export type ListRfqsResponse = z.infer<typeof ListRfqsResponseSchema>;
