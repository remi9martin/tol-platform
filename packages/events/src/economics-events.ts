// packages/events/src/economics-events.ts
//
// the spec names two Economics events verbatim among its "Domain
// events" list: "commission.accrued; commission.paid" (see
// apps/api/src/modules/economics/service.ts's own inline citations at
// each call site). Extended here with 3 more for full lifecycle
// coverage — same "match the representative names, extend for the
// rest" precedent claim-events.ts/passport-events.ts already
// established for their own verticals:
//   - economics.schedule_created / economics.schedule_superseded — a
//     schedule mutation is ONE service call (`schedule.manage` covers
//     create + activate + supersede, see packages/authz/src/actions.ts's
//     own comment on why there's no separate create/activate action),
//     but the timeline event forks on whether a previous ACTIVE version
//     existed (packages/domain's CommissionSchedule version-chain,
//     ADR-0013) — mirrors claim-events.ts's own precedent of one
//     call site choosing between named events based on real state, not
//     a 1:1 call-site-to-event-name mapping.
//   - commission.adjusted — the named, not-yet-HTTP-exposed REVERSAL
//     path stays out of this vocabulary on purpose (ADR-0013);
//     ADJUSTMENT entries (rate corrections, non-reversal balance
//     changes) are the only ledger.adjust action this pass, so this is
//     the one adjustment-shaped event name, not a family of them.
//
// Every payload below is safe-fields-only — money as minor-units
// STRINGS (never a bare number, matching every other money-bearing
// event/DTO in this codebase — @tol/contracts/src/economics.ts's own
// MinorUnitsStringSchema), IDs and enum-ish strings, never a component's
// bps/fixedAmountMinor rate or a payment's `evidenceRef` — same "safe
// references only" discipline as every other event catalog in this
// package (p.12: "Event payloads store safe references; secret payload
// content is not copied into general logs").

import type { DomainEventEnvelope } from "./envelope.js";

export const ECONOMICS_EVENT_TYPES = [
  "economics.schedule_created",
  "economics.schedule_superseded",
  "commission.accrued",
  "commission.paid",
  "commission.adjusted",
] as const;
export type EconomicsEventType = (typeof ECONOMICS_EVENT_TYPES)[number];
export function isEconomicsEventType(value: string): value is EconomicsEventType {
  return (ECONOMICS_EVENT_TYPES as readonly string[]).includes(value);
}

/** Shared by both economics.schedule_created and economics.schedule_superseded — apps/api/src/modules/economics/service.ts's createSchedule() sends this same payload shape for either eventType, chosen by whether a previous ACTIVE version existed. */
export interface EconomicsScheduleEventPayload {
  scheduleId: string;
  versionNumber: number;
  basis: string;
}

export interface CommissionAccruedPayload {
  revenueEventId: string;
  scheduleId: string;
  /** Minor-units string — the whole net amount just split into ledger entries, never a float. */
  netDistributableMinor: string;
  entryCount: number;
}

export interface CommissionPaidPayload {
  paymentId: string;
  recipientOrgId: string;
  /** Minor-units string. */
  totalAmountMinor: string;
  accrualRootIds: string[];
}

export interface CommissionAdjustedPayload {
  accrualRootId: string;
  direction: string;
  /** Minor-units string. */
  amountMinor: string;
}

/** Discriminated union — a switch over `eventType` narrows `payload` for free at every call site that builds one of these (apps/api's economics service). */
export type EconomicsTimelineEvent =
  | DomainEventEnvelope<"economics.schedule_created", EconomicsScheduleEventPayload>
  | DomainEventEnvelope<"economics.schedule_superseded", EconomicsScheduleEventPayload>
  | DomainEventEnvelope<"commission.accrued", CommissionAccruedPayload>
  | DomainEventEnvelope<"commission.paid", CommissionPaidPayload>
  | DomainEventEnvelope<"commission.adjusted", CommissionAdjustedPayload>;
