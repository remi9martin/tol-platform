// packages/events/src/passport-events.ts
//
// the spec does not name Passport-specific event strings verbatim the
// way it does for RFQ/Deal Room/Lockbox (rfq.sent, lockbox.sealed,
// etc.) — this catalog is a documented inference, following the SAME
// "past-tense, dot-namespaced" convention every other event catalog in
// this package already uses, extended to the actions the Passport
// module actually exposes (create / upsert a fact / add evidence /
// verify), plus a system-computed readiness event mirroring the
// claim.scored precedent (a derived-output computation gets its own
// named event, distinct from the mutation that triggered it).
//
// Every payload below is safe-fields-only — never the full
// normalizedValue content of a Fact (which could be sensitive) or any
// Evidence objectRef/checksum beyond what's needed to identify WHICH
// evidence changed — same "safe references only" discipline as every
// other event catalog in this package (p.12: "Event payloads store safe
// references; secret payload content is not copied into general logs").

import type { DomainEventEnvelope } from "./envelope.js";

export const PASSPORT_EVENT_TYPES = [
  "passport.created",
  "passport.fact_updated",
  "passport.evidence_added",
  "passport.readiness_computed",
  "passport.verified",
  "passport.status_changed",
] as const;
export type PassportEventType = (typeof PASSPORT_EVENT_TYPES)[number];
export function isPassportEventType(value: string): value is PassportEventType {
  return (PASSPORT_EVENT_TYPES as readonly string[]).includes(value);
}

export interface PassportCreatedPayload {
  organizationId: string;
}

export interface PassportFactUpdatedPayload {
  fieldKey: string;
  sectionType: string;
  verification: string;
}

export interface PassportEvidenceAddedPayload {
  evidenceId: string;
  type: string;
}

/** Mirrors claim.scored's precedent (earlier) — a system-computed derived output gets its own named event, distinct from the human action (fact_updated/evidence_added) that triggered the recompute. */
export interface PassportReadinessComputedPayload {
  score: number;
  blockerCount: number;
  warningCount: number;
  algorithmVersion: string;
}

export interface PassportVerifiedPayload {
  reviewerOrgId: string;
  reason: string;
}

export interface PassportStatusChangedPayload {
  from: string;
  to: string;
}

/** Discriminated union — a switch over `eventType` narrows `payload` for free at every call site that builds one of these (apps/api's passport service). */
export type PassportTimelineEvent =
  | DomainEventEnvelope<"passport.created", PassportCreatedPayload>
  | DomainEventEnvelope<"passport.fact_updated", PassportFactUpdatedPayload>
  | DomainEventEnvelope<"passport.evidence_added", PassportEvidenceAddedPayload>
  | DomainEventEnvelope<"passport.readiness_computed", PassportReadinessComputedPayload>
  | DomainEventEnvelope<"passport.verified", PassportVerifiedPayload>
  | DomainEventEnvelope<"passport.status_changed", PassportStatusChangedPayload>;
