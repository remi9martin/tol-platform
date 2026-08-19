// packages/domain/src/opportunity-states.ts
//
// the spec (Object || States table, verbatim): "Opportunity || DRAFT →
// READINESS_BLOCKED → MATCH_READY → INVITED → QUOTED → SELECTED →
// ACTIVATING → LIVE → CLOSED". the spec STATE RULE (verbatim):
// "Transitions happen through domain services, never arbitrary UI field
// edits. Every transition writes a DomainEvent and AuditEvent." This file
// is the domain service's transition table — apps/api's opportunities
// service calls assertValidOpportunityTransition() before persisting any
// status change; it never lets a repository update `status` to an
// arbitrary caller-supplied value.

import { DomainTransitionError } from "./transition-error.js";

export const OPPORTUNITY_STATUSES = [
  "DRAFT",
  "READINESS_BLOCKED",
  "MATCH_READY",
  "INVITED",
  "QUOTED",
  "SELECTED",
  "ACTIVATING",
  "LIVE",
  "CLOSED",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export function isOpportunityStatus(value: string): value is OpportunityStatus {
  return (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}

/**
 * The scope's diagram is drawn as one linear happy path, but a real
 * system needs backward edges too (e.g. a MATCH_READY opportunity whose
 * evidence goes stale drops back to READINESS_BLOCKED). earlier drives
 * DRAFT/MATCH_READY at Opportunity creation, then cascades INVITED ->
 * QUOTED -> SELECTED as side effects of the RFQ lifecycle reaching the
 * matching milestone (apps/api/src/modules/rfqs/service.ts: create ->
 * INVITED, first quote submitted -> QUOTED, quote selected -> SELECTED)
 * — each cascade is a real, validated call through
 * assertValidOpportunityTransition, not a bypassed field write, and each
 * only fires when the Opportunity is actually at the expected prior
 * status (a second RFQ against an already-INVITED opportunity does not
 * re-fire the same transition). ACTIVATING/LIVE/CLOSED remain unreached
 * by an earlier code — those track the DealRoom's own
 * ACTIVATION/LIVE stages (deal-states.ts), which earlier models but does
 * not wire API actions for (see that file's header) — a later day owns
 * cascading those two, symmetrically.
 */
const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, ReadonlySet<OpportunityStatus>> = {
  DRAFT: new Set(["READINESS_BLOCKED", "MATCH_READY"]),
  READINESS_BLOCKED: new Set(["DRAFT", "MATCH_READY"]),
  MATCH_READY: new Set(["READINESS_BLOCKED", "INVITED"]),
  INVITED: new Set(["MATCH_READY", "QUOTED"]),
  QUOTED: new Set(["INVITED", "SELECTED"]),
  SELECTED: new Set(["ACTIVATING", "QUOTED"]),
  ACTIVATING: new Set(["LIVE", "SELECTED"]),
  LIVE: new Set(["CLOSED"]),
  CLOSED: new Set([]),
};

export class InvalidOpportunityTransitionError extends DomainTransitionError {
  constructor(from: OpportunityStatus, to: OpportunityStatus) {
    super(`invalid Opportunity transition: ${from} -> ${to}`);
    this.name = "InvalidOpportunityTransitionError";
  }
}

/** Throws InvalidOpportunityTransitionError on an illegal edge; a same-state "transition" (from === to) is always rejected too — callers that don't actually change status shouldn't be calling this at all. */
export function assertValidOpportunityTransition(from: OpportunityStatus, to: OpportunityStatus): void {
  // Runtime hardening: `from`/`to` are typed as closed unions, so TypeScript
  // blocks bad values at every real call site — but a cast, unvalidated
  // input, or a future bug could still hand this an out-of-enum string at
  // runtime, in which case `OPPORTUNITY_TRANSITIONS[from]` is undefined and
  // `.has(to)` below would throw a raw TypeError instead of the typed error
  // apps/api's central handler knows how to turn into a clean 400.
  if (!isOpportunityStatus(from) || !isOpportunityStatus(to)) {
    throw new InvalidOpportunityTransitionError(from, to);
  }
  if (from === to || !OPPORTUNITY_TRANSITIONS[from].has(to)) {
    throw new InvalidOpportunityTransitionError(from, to);
  }
}
