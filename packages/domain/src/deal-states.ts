// packages/domain/src/deal-states.ts
//
// the spec (verbatim): "DealRoom || OPEN → CONDITIONS →
// APPROVED/DECLINED → ACTIVATION → LIVE → ARCHIVED". an earlier API
// (apps/api/src/modules/deals/service.ts) only ever DRIVES OPEN ->
// CONDITIONS -> APPROVED/DECLINED — ACTIVATION/LIVE/ARCHIVED are modeled
// here (full p.5 fidelity, "decomposed per the scope") but have no
// earlier API action reaching them: p.22's "Activation checklist" and
// "Outcome" surfaces (credentials, technical integration, certification,
// live date, volume ramp, survival status) are their own, separate
// entities the build spec never decomposes on p.21-22 the way it does
// RFQ/Quote/Condition/Decision — building them now would be inventing
// schema the scope doesn't specify, not implementing P14's actual exit
// condition ("Conditions + decisions + timeline"). Flagged here, and in
// the build log's "what's NOT done" section, rather than silently
// stopping short.
//
// DealCondition.state is INFERRED (p.21/p.22 name the "state" field
// without enumerating values) — grounded in the field's own name plus
// p.21's separate, distinct "blocking" boolean (a Condition's blocking-
// ness is a SEPARATE axis from its resolution state, per p.21's object
// listing: "required evidence/action, owner, dueAt, state, blocking" —
// two different fields, not one).

import { DomainTransitionError } from "./transition-error.js";

export const DEAL_ROOM_STATUSES = [
  "OPEN",
  "CONDITIONS",
  "APPROVED",
  "DECLINED",
  "ACTIVATION",
  "LIVE",
  "ARCHIVED",
] as const;
export type DealRoomStatus = (typeof DEAL_ROOM_STATUSES)[number];
export function isDealRoomStatus(value: string): value is DealRoomStatus {
  return (DEAL_ROOM_STATUSES as readonly string[]).includes(value);
}

const DEAL_ROOM_TRANSITIONS: Record<DealRoomStatus, ReadonlySet<DealRoomStatus>> = {
  OPEN: new Set(["CONDITIONS", "APPROVED", "DECLINED"]),
  CONDITIONS: new Set(["APPROVED", "DECLINED"]),
  APPROVED: new Set(["ACTIVATION", "DECLINED"]),
  DECLINED: new Set([]),
  ACTIVATION: new Set(["LIVE", "DECLINED"]),
  LIVE: new Set(["ARCHIVED"]),
  ARCHIVED: new Set([]),
};

export class InvalidDealTransitionError extends DomainTransitionError {
  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidDealTransitionError";
  }
}

export function assertValidDealRoomTransition(from: DealRoomStatus, to: DealRoomStatus): void {
  // Runtime hardening: see opportunity-states.ts's identical comment — a
  // cast or unvalidated input could hand this an out-of-enum string, and
  // without this guard `DEAL_ROOM_TRANSITIONS[from]` would be undefined,
  // throwing a raw TypeError instead of the typed error the central handler
  // expects.
  if (!isDealRoomStatus(from) || !isDealRoomStatus(to)) {
    throw new InvalidDealTransitionError("DealRoom", from, to);
  }
  if (from === to || !DEAL_ROOM_TRANSITIONS[from].has(to)) {
    throw new InvalidDealTransitionError("DealRoom", from, to);
  }
}

export const DEAL_CONDITION_STATES = ["PENDING", "SATISFIED", "WAIVED", "REJECTED"] as const;
export type DealConditionState = (typeof DEAL_CONDITION_STATES)[number];
export function isDealConditionState(value: string): value is DealConditionState {
  return (DEAL_CONDITION_STATES as readonly string[]).includes(value);
}

const DEAL_CONDITION_TRANSITIONS: Record<DealConditionState, ReadonlySet<DealConditionState>> = {
  PENDING: new Set(["SATISFIED", "WAIVED", "REJECTED"]),
  SATISFIED: new Set([]),
  WAIVED: new Set([]),
  REJECTED: new Set(["PENDING"]), // a rejected condition can be reopened (new evidence resubmitted) — the only backward edge in this table.
};

export function assertValidDealConditionTransition(from: DealConditionState, to: DealConditionState): void {
  // Runtime hardening: see assertValidDealRoomTransition's identical
  // comment above — a cast or unvalidated input could hand this an
  // out-of-enum string, and without this guard
  // `DEAL_CONDITION_TRANSITIONS[from]` would be undefined, throwing a raw
  // TypeError instead of the typed error the central handler expects.
  if (!isDealConditionState(from) || !isDealConditionState(to)) {
    throw new InvalidDealTransitionError("DealCondition", from, to);
  }
  if (from === to || !DEAL_CONDITION_TRANSITIONS[from].has(to)) {
    throw new InvalidDealTransitionError("DealCondition", from, to);
  }
}

/**
 * the spec (verbatim): "Decisions: quote selection, approvals,
 * declines, exceptions and rationale." DealDecision rows are append-only
 * facts (create-only, like AuditEvent) — there is no transition table
 * here because a decision, once recorded, is never edited; a changed
 * mind is a NEW DealDecision row, not a mutation of the old one (same
 * immutable-history discipline as p.21's Quote versioning).
 */
export const DEAL_DECISION_TYPES = ["QUOTE_SELECTED", "APPROVAL", "DECLINE", "EXCEPTION"] as const;
export type DealDecisionType = (typeof DEAL_DECISION_TYPES)[number];
export function isDealDecisionType(value: string): value is DealDecisionType {
  return (DEAL_DECISION_TYPES as readonly string[]).includes(value);
}
