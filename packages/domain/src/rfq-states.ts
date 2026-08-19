// packages/domain/src/rfq-states.ts
//
// the spec (verbatim): "RFQ || DRAFT → SENT → ACKNOWLEDGED → QUESTIONS →
// QUOTED → EXPIRED/DECLINED/SELECTED". RFQRecipient.state and
// Quote.status aren't given explicit enumerated values anywhere in the
// the spec (p.21 names the RFQRecipient/Quote OBJECTS and their
// field lists — "providerOrgId, state, acknowledgedAt, declineReason" /
// "provider, version, currency, validity, status, submittedAt" — without
// spelling out the value sets) — both are INFERRED here, the same
// documented-inference discipline earlier used for OrganizationType/
// VerificationStatus (packages/db/prisma/schema.prisma comments), each
// grounded in the field's own name and the RFQ rules prose on p.21
// ("Providers never see competing quotes...", "Quote amendments never
// overwrite prior versions", "Expired quotes cannot be selected without
// an explicit revalidation event").

import { DomainTransitionError } from "./transition-error.js";

export const RFQ_STATUSES = [
  "DRAFT",
  "SENT",
  "ACKNOWLEDGED",
  "QUESTIONS",
  "QUOTED",
  "EXPIRED",
  "DECLINED",
  "SELECTED",
] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];
export function isRfqStatus(value: string): value is RfqStatus {
  return (RFQ_STATUSES as readonly string[]).includes(value);
}

const RFQ_TRANSITIONS: Record<RfqStatus, ReadonlySet<RfqStatus>> = {
  DRAFT: new Set(["SENT"]),
  SENT: new Set(["ACKNOWLEDGED", "QUESTIONS", "QUOTED", "EXPIRED", "DECLINED"]),
  ACKNOWLEDGED: new Set(["QUESTIONS", "QUOTED", "EXPIRED", "DECLINED"]),
  QUESTIONS: new Set(["QUOTED", "EXPIRED", "DECLINED"]),
  QUOTED: new Set(["SELECTED", "QUOTED", "EXPIRED", "DECLINED"]),
  EXPIRED: new Set([]),
  DECLINED: new Set([]),
  SELECTED: new Set([]),
};

export class InvalidRfqTransitionError extends DomainTransitionError {
  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidRfqTransitionError";
  }
}

/** RFQ.status may re-enter QUOTED (a second provider quotes after the first) — the only real same-state exception in this file, since "another recipient just quoted" isn't a no-op at the RFQ aggregate level even though the enum value is unchanged; callers that already know nothing changed still shouldn't call this needlessly, but it's not rejected structurally the way Opportunity/DealRoom same-state calls are. */
export function assertValidRfqTransition(from: RfqStatus, to: RfqStatus): void {
  // Runtime hardening: see opportunity-states.ts's identical comment — a
  // cast or unvalidated input could hand this an out-of-enum string, and
  // without this guard `RFQ_TRANSITIONS[from]` would be undefined, throwing
  // a raw TypeError instead of the typed error the central handler expects.
  if (!isRfqStatus(from) || !isRfqStatus(to)) {
    throw new InvalidRfqTransitionError("RFQ", from, to);
  }
  if (!RFQ_TRANSITIONS[from].has(to)) {
    throw new InvalidRfqTransitionError("RFQ", from, to);
  }
}

/**
 * Inferred (see file header). INVITED: the recipient has been sent this
 * RFQ's current version but hasn't acted. ACKNOWLEDGED: opened/viewed —
 * the API doesn't expose a separate "acknowledge" action (folded into
 * whichever of decline/submit-quote happens first, per
 * apps/api/src/modules/rfqs/service.ts's own comment on that
 * simplification), so this value is modeled but not reached by the
 * own code paths — kept in the enum for completeness/forward-compat, not
 * dead: a later day's "mark as viewed" action would use it.
 */
export const RFQ_RECIPIENT_STATES = ["INVITED", "ACKNOWLEDGED", "DECLINED", "QUOTED", "EXPIRED"] as const;
export type RfqRecipientState = (typeof RFQ_RECIPIENT_STATES)[number];
export function isRfqRecipientState(value: string): value is RfqRecipientState {
  return (RFQ_RECIPIENT_STATES as readonly string[]).includes(value);
}

const RFQ_RECIPIENT_TRANSITIONS: Record<RfqRecipientState, ReadonlySet<RfqRecipientState>> = {
  INVITED: new Set(["ACKNOWLEDGED", "DECLINED", "QUOTED", "EXPIRED"]),
  ACKNOWLEDGED: new Set(["DECLINED", "QUOTED", "EXPIRED"]),
  DECLINED: new Set([]),
  QUOTED: new Set(["DECLINED", "EXPIRED"]), // a provider may still withdraw-to-declined or expire after quoting; the Quote row itself (not this field) tracks selection.
  EXPIRED: new Set([]),
};

export function assertValidRfqRecipientTransition(from: RfqRecipientState, to: RfqRecipientState): void {
  // Runtime hardening: see assertValidRfqTransition's identical comment
  // above — a cast or unvalidated input could hand this an out-of-enum
  // string, and without this guard `RFQ_RECIPIENT_TRANSITIONS[from]` would
  // be undefined, throwing a raw TypeError instead of the typed error the
  // central handler expects.
  if (!isRfqRecipientState(from) || !isRfqRecipientState(to)) {
    throw new InvalidRfqTransitionError("RFQRecipient", from, to);
  }
  if (from === to || !RFQ_RECIPIENT_TRANSITIONS[from].has(to)) {
    throw new InvalidRfqTransitionError("RFQRecipient", from, to);
  }
}

/**
 * Inferred (see file header) — mirrors the prototype's lowercase
 * `"draft" | "issued" | "accepted" | "expired"` (../the prototype repo/
 * lib/model.ts Quote type, reuse-reference only) upgraded to the
 * uppercase enum convention plus a REJECTED value the prototype lacked
 * (needed because p.21's QuoteDecision explicitly names "selected/
 * rejected" as the two outcomes — earlier folds QuoteDecision into
 * Quote.status + DealDecision rather than a separate table, see
 * ADR-0008) and a WITHDRAWN value (p.21/this stage instruction
 * explicitly names "withdraw quote" as a first-class provider action).
 */
export const QUOTE_STATUSES = ["SUBMITTED", "SELECTED", "REJECTED", "EXPIRED", "WITHDRAWN"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export function isQuoteStatus(value: string): value is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(value);
}

const QUOTE_TRANSITIONS: Record<QuoteStatus, ReadonlySet<QuoteStatus>> = {
  SUBMITTED: new Set(["SELECTED", "REJECTED", "EXPIRED", "WITHDRAWN"]),
  SELECTED: new Set([]),
  REJECTED: new Set([]),
  EXPIRED: new Set([]),
  WITHDRAWN: new Set([]),
};

export function assertValidQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  // Runtime hardening: see assertValidRfqTransition's identical comment
  // above — a cast or unvalidated input could hand this an out-of-enum
  // string, and without this guard `QUOTE_TRANSITIONS[from]` would be
  // undefined, throwing a raw TypeError instead of the typed error the
  // central handler expects.
  if (!isQuoteStatus(from) || !isQuoteStatus(to)) {
    throw new InvalidRfqTransitionError("Quote", from, to);
  }
  if (from === to || !QUOTE_TRANSITIONS[from].has(to)) {
    throw new InvalidRfqTransitionError("Quote", from, to);
  }
}
