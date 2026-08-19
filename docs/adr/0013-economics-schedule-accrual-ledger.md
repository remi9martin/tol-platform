# ADR-0013: Economics — BigInt money as D8's own extension, CommissionAccrual as the single traceable ledger, largest-remainder apportionment, and a structurally ownerless authz resource

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** the build, within the bounds of ADR-0008 part 3
(integer minor units for money), D8 part 5 (the two-sided resource / `ownerOrgId`
pattern), D11 part 2 (append-only derived-output persistence, no invented state
machine), D12 part 2 (the same precedent, extended to `MatchResult`), and the earlier
build brief's explicit hard constraint: money is INTEGER MINOR UNITS, never floats,
this pass's single most important correctness property.

## Context

earlier builds P15 (Economics) — the spec's traceable schedule/accrual ledger, and the
last NOT-STARTED gate this build's own scope names directly. Six design questions
surfaced during the build, none answered directly by the scope doc's own text:

1. Every prior day's money fields (`RevenueEvent.grossAmountMinor`, `DealCondition`
   amounts, etc.) were stored and passed through, never actually COMPUTED. earlier is the
   first vertical where money must be SPLIT — a schedule's components divide a revenue
   event's net amount by basis points. Division on integers loses remainder; how does
   this build guarantee the split sums back to exactly the original amount, every time,
   for every possible bps distribution.
2. the spec/p.23 names both a schedule/accrual "ledger" and a separate
   `AttributionLink` concept. Does this require two new tables (a ledger table plus a
   link table) or does an existing mechanism already cover one of them.
3. the spec's six-state-machine table does not include CommissionSchedule or
   CommissionAccrual by name, but a schedule clearly has lifecycle states (draft,
   active, superseded) and an accrual clearly has a mutable derived balance (accrued,
   partially paid, paid). What persistence shape captures both without inventing
   structure the scope never asked for.
4. P15's own privacy requirement — "party sees only its own accruals; finance/operator
   see full ledger" — describes a THREE-way access pattern (the merchant whose deal it
   is, the recipient it pays, Finance/Platform oversight) over ONE resource type, unlike
   every prior resource's two-sided (owner + participant) shape. Does the existing
   `ownerOrgId`-plus-`participantActions` mechanism (D8 part 5) extend cleanly, or does
   it need a structural change.
5. At what point in a DealRoom's own lifecycle should recording real revenue/accruals
   against it become possible.
6. Given the task brief's own 5-block numbering (db+domain entities as this stage,
   the pure engine as this stage, authz as this stage, api as this stage, web as this stage), and
   that the entities and the engine that operates on them are tightly coupled (the
   engine's own input/output types are shaped by the entities' own fields), should they
   be built and reviewed as two genuinely separate passes or one.

## Decision

### 1. Money stays BigInt end to end — D8 part 3's rule restated with teeth, because this is the first day it actually gets tested under computation

D8 already mandated integer minor units for every money field. earlier is where that rule
either holds under real arithmetic or quietly breaks: `computeCommissionSplits()`
performs every intermediate calculation in BigInt (`remainingAfterFixed * BigInt(bps)`,
never a float division), floors via BigInt division, and tracks the leftover
remainder explicitly rather than ever rounding a float. Every DTO on the wire
(`packages/contracts/src/economics.ts`) represents money as a minor-units STRING
(`MinorUnitsStringSchema`, `/^\d+$/`), never a bare JSON `number` — closing the one
channel (JSON has no BigInt type) where a float could silently re-enter the system at
the API boundary even if the server-side arithmetic were perfect.

### 2. `CommissionAccrual` IS the ledger AND the accrual record — one physical table, not two, and `AttributionLink` is satisfied by an existing FK, not a new join table

`CommissionAccrual` carries both the original accrual (`entryType: "ACCRUAL"`) and
every later `ADJUSTMENT`/`PAYMENT`/`REVERSAL` entry against it, grouped by a
self-referential `accrualRootId`. This is the same "single physical table, no
denormalized current-state pointer" precedent `MatchResult` (D12 part 2) and
`ReadinessResult` (D11 part 2) already established, applied here to the first resource
in this codebase whose BALANCE genuinely changes over time while its HISTORY stays
immutable. `computeAccrualBalance()` derives the current balance by folding the whole
entry chain on every read — never a cached total column that could drift from its own
source of truth.

Scope's `AttributionLink` is satisfied by `CommissionComponent.claimId`, a direct FK to
the real `Claim` — not a separate link table. A `CommissionComponent` is already
scoped to exactly one schedule and one recipient; a dedicated `AttributionLink` row
would only ever carry the same `(scheduleId, claimId)` pair this column already
expresses, so adding one would be structure without new information.

### 3. Splitting uses largest-remainder (Hamilton) apportionment, chosen specifically because it is the simplest method that provably reaches zero leakage and stays deterministic under a tie

Naive proportional rounding (`floor(net * bps / 10000)` per component, independently)
systematically loses minor units — the sum of the floored shares is always
less-than-or-equal-to the net amount, never guaranteed equal. `computeCommissionSplits`
instead: (a) deducts `FIXED` components first, validated to not exceed the net amount;
(b) requires all `PERCENTAGE_BPS` components to sum to exactly 10000 bps (a module-load
-adjacent input validation, not an assumption); (c) computes each bps component's exact
integer share via BigInt multiply-then-floor-divide; (d) distributes the leftover pool
— which is always strictly smaller than the component count — one minor unit at a time
to the components with the largest fractional remainder, breaking ties by `componentId`
ascending. This is the same class of solution election seat-apportionment methods use,
chosen here because it is provably exact (an internal sum-check assertion guards the
engine's own output) and deterministic (the tie-break rule is total, not partial) —
proven by a dedicated sweep across uneven bps distributions (6 cases, including a 9-way
split of 999 minor units) rather than assumed correct from the algorithm's reputation
alone.

### 4. `commission_accrual` has no ordinary same-org owner — a structural authz decision, not a policy note

Every prior two-sided resource (`RFQ`, `DealRoom`, `Claim`, `MatchResult`) has some real
org that owns it by default (D8 part 5), with participant access layered on top. A
`CommissionAccrual` has three genuinely different parties with real, different rights
to the SAME row — the merchant whose deal generated it, the recipient it pays, and
Finance/Platform oversight — and none of them is "the" owner in the way a DealRoom's
merchant is. Modeling this as a same-org grant plus exceptions would leave a live
footgun: a future caller passing a real `ownerOrgId` (say, the merchant's) would
silently grant that merchant same-org access to a resource it should never see in full.
Instead: `apps/api`'s economics service is REQUIRED to always construct this resource
with `ownerOrgId: null`, and — the actual enforcement mechanism —
`packages/authz/src/can.ts` adds a dedicated branch, evaluated BEFORE the ordinary
same-org fallback, that denies any `commission_accrual` action outright unless the
caller has cross-org authority or verified participant (recipient) standing. This makes
"no ordinary owner" true structurally even against a future caller's mistake, proven by
a hardening regression test that constructs the resource with a REAL, matching
`ownerOrgId` and confirms the same-org actor is still denied. This is P15's own privacy
requirement — "party sees only its own accruals; finance/operator see full ledger" —
implemented as an invariant the type system and the authz layer both enforce, not a
convention documented in a comment.

### 5. Economics engages at DealRoom `ACTIVATION` or later, not at `SELECTED`

`ECONOMICS_ELIGIBLE_DEAL_STATUSES = {ACTIVATION, LIVE, ARCHIVED}` gates
`recordRevenueEvent`/`recordPayment`/`adjustLedger` (schedule AUTHORING is allowed
earlier — a rate card is harmless before the deal is live). A deal that has been
selected but hasn't yet cleared its own conditions/decisions gate has no real revenue
to record yet; letting economics record against it would let this vertical get ahead of
the DealRoom's own state machine (D8), the same "don't let a dependent system announce
a fact its own source-of-truth hasn't reached yet" discipline this codebase applies
everywhere else (e.g., D12 part 2's eligibility-runs-first enforcement).

### 6. Two named scope cuts, and a block-numbering adaptation, stated rather than silently absorbed

**REVERSAL has no HTTP endpoint this pass.** The domain vocabulary includes it, and
`computeAccrualBalance()` correctly zeroes `outstandingAmountMinor` when one is present
(a real bug this build found and fixed — the original implementation only set the
derived `status` flag, never the numeric balance), but issuing one requires a direct,
audited data intervention today, not a self-service `ledger.adjust`-style call — a real
reversal is rare and high-stakes enough that this pass deliberately did not build a
self-service path for it. **A full economics Dispute workflow** (mirroring
Attribution's `ClaimDispute`, D10) was named during the scope read-through but not
built — disputing a specific accrual's amount is a real future need this pass didn't
have room for.

**Blocks 1 and 2 of the task's own 5-block numbering shipped as one commit** (db
migration + domain entities, and the pure engine that operates on them) — the two are
tightly coupled by construction (the engine's types are shaped directly by the
entities' own fields) and were designed and reviewed together; splitting them into
two passes would have reviewed the same lines twice rather than adding a genuinely
independent check. The commit is self-labeled "this stage," not relabeled to hide the
merge. Blocks 3 (authz), 4 (api), and 5 (web) then proceeded exactly as the task's own
numbering specified, each its own commit and its own review.

## Consequences

- Money is exact by construction, not by convention: BigInt through every
  intermediate calculation, minor-units strings on the wire, a zero-leakage proof
  covering a spread of distributions rather than one happy-path example.
- The ledger is traceable by construction: one append-only table, self-referential
  grouping via `accrualRootId`, a direct FK into Attribution's own `Claim` rather than a
  redundant link table.
- The P15 privacy requirement is a structural invariant (a dedicated `can.ts` branch
  that ignores `ownerOrgId` for this one resource type entirely) rather than a policy
  documented only in a comment — proven by a test that deliberately tries to defeat it
  with a real, matching `ownerOrgId` and still gets denied.
- Two omissions (REVERSAL over HTTP, an economics Dispute workflow) are named as
  deliberate cuts with reasoning, not silently absent; a reader of review or
  this ADR does not have to infer whether they were forgotten or chosen.
- The this stage+2 merge is documented as a reasoned adaptation of the task's own
  numbering, not a silent deviation — the commit history itself is honest about what
  happened (`57e79d2` says "this stage" covering both, not "this stage" pretending nothing
  moved).
- Gates affected: **P15 — Economics** (DONE this day). Also touches **P3 — Data** (5 new
  tables — `CommissionSchedule`/`CommissionComponent`/`RevenueEvent`/
  `CommissionAccrual`/`CommissionPayment` — 38 total) and **P16 — Audit**
  (`economics.schedule_created`/`economics.schedule_superseded`/`commission.accrued`/
  `commission.paid`/`commission.adjusted` each write an `AuditEvent` + `DomainEvent`;
  `commission.accrued`/`commission.paid` are the spec's own verbatim event names; a
  typed closed-vocabulary catalog, `packages/events/src/economics-events.ts`, was added
  at close-out to match the earlier phases precedent this vertical had initially
  missed).
