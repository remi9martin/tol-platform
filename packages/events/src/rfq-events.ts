// packages/events/src/rfq-events.ts
//
// the spec names "rfq.sent; rfq.acknowledged; quote.submitted;
// quote.selected" verbatim among its representative domain events; p.21's
// RFQ rules ("Providers never see competing quotes...", "Quote
// amendments never overwrite prior versions", declineReason) motivate the
// rest (rfq.declined, quote.withdrawn) needed to fully cover P13's
// "versioned disclosure + quote" exit condition end to end, not just the
// scope's own representative subset. `rfq.acknowledged` is modeled (the
// type exists, for forward-compat with @tol/domain's RfqRecipientState
// ACKNOWLEDGED value) but not emitted by an earlier apps/api code —
// same reasoning as that enum value's own comment.
//
// earlier: `rfq.expired` added — the one RFQ_STATUSES value (@tol/domain's
// rfq-states.ts) that had a real state but no timeline event, because
// nothing transitioned an RFQ into it until apps/worker's own rfq-expiry
// job (this day) existed to do so. Same "extend for full lifecycle
// coverage" precedent this file's own header already established for
// rfq.declined/quote.withdrawn.

import type { DomainEventEnvelope } from "./envelope.js";

export const RFQ_EVENT_TYPES = [
  "rfq.sent",
  "rfq.acknowledged",
  "rfq.declined",
  "rfq.expired",
  "quote.submitted",
  "quote.withdrawn",
  "quote.selected",
] as const;
export type RfqEventType = (typeof RFQ_EVENT_TYPES)[number];
export function isRfqEventType(value: string): value is RfqEventType {
  return (RFQ_EVENT_TYPES as readonly string[]).includes(value);
}

export interface RfqSentPayload {
  opportunityId: string;
  recipientOrgIds: string[];
  versionNumber: number;
}
export interface RfqAcknowledgedPayload {
  providerOrgId: string;
}
export interface RfqDeclinedPayload {
  providerOrgId: string;
  declineReason: string;
}
/** earlier: written by apps/worker's rfq-expiry job (event-triggered or scheduled-sweep — see that job's own header comment), never by apps/api directly — an RFQ transitions to EXPIRED only via the background job's own dueAt scan. */
export interface RfqExpiredPayload {
  from: string;
  dueAt: string;
}
export interface QuoteSubmittedPayload {
  quoteId: string;
  providerOrgId: string;
  quoteVersion: number;
}
export interface QuoteWithdrawnPayload {
  quoteId: string;
  providerOrgId: string;
}
export interface QuoteSelectedPayload {
  quoteId: string;
  dealRoomId: string;
}

/** Discriminated union — a switch over `eventType` narrows `payload` for free at every call site that builds one of these (apps/api's rfqs service). */
export type RfqTimelineEvent =
  | DomainEventEnvelope<"rfq.sent", RfqSentPayload>
  | DomainEventEnvelope<"rfq.acknowledged", RfqAcknowledgedPayload>
  | DomainEventEnvelope<"rfq.declined", RfqDeclinedPayload>
  | DomainEventEnvelope<"rfq.expired", RfqExpiredPayload>
  | DomainEventEnvelope<"quote.submitted", QuoteSubmittedPayload>
  | DomainEventEnvelope<"quote.withdrawn", QuoteWithdrawnPayload>
  | DomainEventEnvelope<"quote.selected", QuoteSelectedPayload>;
