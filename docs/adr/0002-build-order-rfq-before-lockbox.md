# ADR-0002: Build order is RFQ + Deal Room before Lockbox + Attribution

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** Product (business-plan roadmap takes precedence over the scope's day-plan sequencing)

## Context

The two source documents disagree on sequencing:

- **Business plan roadmap** (§21): "0–30 days: Concierge MVP" → "30–90 days: Private
  RFQ" → "90–180 days: Lockbox + reusable trust..." — **RFQ before Lockbox.**
- **The scope's own phased build plan** (an earlier phase = "Lockbox + receipts +
  claims", a later phase = "Private RFQ + quote + deal room") and its **gate numbering** (P9
  Lockbox precedes P13 RFQ) — **Lockbox before RFQ.**

Notably, this is also the order the halted prototype build happened to follow in
practice — Lockbox/Attribution got real (if fake-crypto) implementation in its Phase B
pass, while RFQ/Deal Room remained true stub screens. That is circumstantial, not a
reason on its own to pick either order.

## Decision

Follow the **business plan's roadmap**: build RFQ + Deal Room before Lockbox +
Attribution.

**Gate numbers are unchanged.** P9 is still named "Lockbox," P13 is still named "RFQ" —
the gate table does not renumber gates to match build order. Only the **build
sequence** deviates from the scope's day-plan: Foundation (P0–P4) → Marketplace/
Passport/Opportunity/Capacity (P5–P8) → **RFQ/Deal Room (P13–P14, pulled forward)** →
Lockbox (P9) → Attribution (P10) → Eligibility/Ranking (P11–P12, wherever their real
dependencies land) → Economics (P15) → hardening gates (P16–P20).

## Consequences

- Anyone reading the gate table's gate *numbers* should not infer build *order*
  from them for this project — check the build log's "what's next" section, which
  reflects actual sequencing, instead.
- `packages/domain`'s RFQ/Deal Room entities (RFQ, RFQRecipient, RFQQuestion, Quote,
  QuoteRate, ReserveTerm, SettlementTerm, CapacityOffer, Condition, QuoteDecision —
  the spec) get modeled before `packages/crypto`'s Lockbox envelope-encryption work
  begins.
- This does not change any gate's exit condition or acceptance criteria — D6 (velocity)
  still applies: gates close on evidence, not on calendar position.
