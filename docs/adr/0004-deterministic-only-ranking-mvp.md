# ADR-0004: Ranking (P12) is deterministic-only for MVP

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** Product

## Context

The scope includes an "outcome-calibrated likelihood" ranking factor at a small
initial weight (~3%), but hedges in the same breath: "Do not immediately allow a black-box
model to control invitations." The spec's header adds: "AI may explain or prioritize; it
must not override prohibited route logic." This is genuinely
ambiguous whether any learned/ML component belongs inside the P0–P20 MVP at all, or
whether P12 should ship 100% deterministic — which is what the prototype's
`lib/matching.ts` already does, incidentally, though built without this scope in hand.

## Decision

P12 Ranking ships **deterministic-only** for MVP. The outcome-learning weight is a
**fixed placeholder** — either literally `0` or held constant — until real outcome data
exists (30/90/180/365-day survival tracking, per the spec). No black-box model
controls invitations at any point in the MVP.

## Consequences

- `packages/matching`'s ranking engine computes every factor from explicit, versioned
  rules — no trained model in the invitation/ranking path.
- Every `MatchResult` still stores factor contributions, inputs, weight set and
  `algorithmVersion` (the spec's explainability requirement) — the placeholder weight
  is one more named, versioned factor, not a special case that breaks explainability.
- The 9-factor ranking table from the spec (MCC/product fit, geography/licensing fit,
  economics, reserve, approval probability, capacity, settlement timing, technical/
  launch fit, provider reliability, outcome-calibrated likelihood) ships with the
  outcome-calibrated slot present but inert, not omitted — so turning it on later is a
  weight change, not a schema change.
- Revisit this ADR once enough real outcome data exists to calibrate a model accurately,
  and only with an explicit new decision — this is not a "quietly turn it on later"
  default.
- Gate affected: **P12 — Ranking** (`Explainable factors + versions`).
