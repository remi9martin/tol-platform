# ADR-0010: Attribution scoring weights, anti-squatting mechanism, and the Claim data-model thin-slice

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** the build, within the bounds of ADR-0004
(deterministic-only ranking/scoring — the product decision, not reopened here) and
the earlier build brief's explicit instruction to port `../the prototype repo/lib/
attribution.ts`'s scoring *approach and shape*, not its literal numbers.

## Context

Unlike Lockbox (earlier), where the reuse-reference prototype's crypto was entirely fake
(`mockSealHash()`) and the only job was to replace it with something real, Attribution's
prototype (`lib/attribution.ts`) is a genuine, live-computed scoring engine that matches
the scope's spirit closely. The discrepancy report's own assessment (cited in the earlier
brief) called it "real, live-computed... matches scope's spirit closely" — but two things
still had to be resolved before porting it: whether its concrete numbers matched the
*primary source* (the build spec), and how far its data model could be reused given
the scope's own canonical schema is richer than what one day can build. A third,
unplanned problem surfaced during this stage: the scope states RelationshipClaim's own
state machine two different, conflicting ways.

## Decision

### 1. Scope's own weight table is authoritative, not the prototype's numbers

the spec p.18 states, verbatim:

| Factor | Weight |
|---|---|
| Commercial history | 40% |
| Decision-maker proximity | 30% |
| Evidence quality | 20% |
| Submission timing | 10% |

The reuse-reference prototype uses **35/30/20/15** instead — close, but not the same,
and with no citation tying those specific numbers to the scope. Cross-checked directly
against the primary source during this stage (not copied blind from the prototype or from
any intermediate summary, same discipline as every other primary-source citation in this
repo's decision history): the scope's table is unambiguous. `packages/attribution`
implements 40/30/20/10, enforced both by a test (`scoring.test.ts`: "matches the spec's
table verbatim") and by a module-load-time assertion (`assertWeightsSumToOne()`, added
during an earlier review — see review) so a
future edit that drifts the weights fails immediately, in every environment, not just
under `pnpm test`.

**Consequence:** anyone diffing this build against the prototype will see different
total scores for identical inputs — expected and correct, not a bug. The prototype's
`ATTRIBUTION_CONFIG.weights` comment block itself has no scope citation for its numbers;
this build's does.

### 2. Anti-squatting: a scope-grounded hard rule, not the prototype's free-text ceiling

The prototype caps a claim's total score by a free-text `originType` field
(`"public_knowledge" | "market_discovery" | "relationship" | "direct_introduction"`)
with invented ceiling values (18/55/95/100) that have no anchor anywhere in the
scope. This build re-derives the same *mechanism* — a hard ceiling that makes "public
knowledge creates no ownership" a computed fact, not an asserted one — from vocabulary
the scope actually names: p.13's D0–D5 directness tiers, specifically **D0 — "public
knowledge only; creates no attribution."**

`ATTRIBUTION_CONFIG.zeroAttributionTiers` forces `total: 0` for any D0 claim,
unconditionally, regardless of the other three factors. This is a *harder* rule than the
prototype's soft ceiling (which still let a D0 claim through the door at a reduced score)
— required because the spec's own anti-gaming test is unambiguous: "Twenty public
provider names submitted with no relationship evidence yield **zero** verified
equity/attribution credit," not "a reduced amount." Proven directly:
`scoreClaim()` called 20 times with D0 + maxed-out history/evidence/time still returns
`total: 0` every time (`scoring.test.ts`).

**Why this needs to be an explicit rule, not left as an emergent property of D0's own
proximity weight:** D0's proximity score is already 0 in `proximityScoreByTier`, but
proximity is only 30% of the total — HISTORY (40%) + EVIDENCE (20%) + TIME (10%) could
otherwise still sum to up to 70 points, nowhere near "zero." The rule and the weight are
deliberately two separate, independently-verified mechanisms (belt and suspenders,
matching this codebase's own recurring discipline — e.g. `packages/crypto`'s Shamir
split PLUS `packages/authz`'s release gate, ADR-0009).

### 3. Claim data model: Relationship + RelationshipClaim collapsed into one `Claim` table

the spec's canonical schema names a **separate** `Relationship` entity (`fromOrgId`,
`toOrgId`, `relationshipType`, `firstSeenAt`, `lastConfirmedAt`) that a
`RelationshipClaim` then references via `relationshipId`. This build's `Claim` model
(`packages/db/prisma/schema.prisma`) collapses the two into one table —
`subjectOrgId`/`relationshipType` on `Claim` embed what a separate `Relationship` row's
own fields would have held. Competing claims "about the same relationship" are grouped
by `(subjectOrgId, opportunityId)` instead of a shared `relationshipId` foreign key
(`claimRepository.listBySubject`).

Similarly, `ClaimEvidence.evidenceId` (p.13: a pointer to a separate `Evidence` entity,
p.14's Passport/Evidence schema) is not built — Passport has no table yet (this repo's
own the build log "what's NOT done" list, unchanged since earlier). `ClaimEvidence`
embeds its content directly (`assertedFact`, `evidenceRef` as a free-text pointer)
instead of joining to a not-yet-built `Evidence` row.

**Reasoning:** this is the same "thin but honest" discipline ADR-0008 part 2
established for `Opportunity`/`CapacityProfile` (build exactly enough for THIS gate's
exit condition without prematurely building a sibling gate's full richness) and D9
established for `Lockbox.conditionRef` (structurally valid, not deeply cross-checked). A
full `Relationship`/`Evidence` subsystem is genuinely a different day's scope (arguably
its own gate, given the scope's ~60-entity canonical model still has real gaps well
beyond the slice — see the gate table P3's own running tally). Building it
prematurely, to satisfy a gate whose actual exit condition ("Claim scoring + dispute
path") doesn't require it, would have meant less time for the parts that DO matter to
P10 — the scoring engine's rigor and the dispute workflow the discrepancy report
specifically flagged as the prototype's real gap ("dispute *status* exists but no
dispute *workflow* — no reviewer, no `ClaimDecision`/`ClaimDispute` records").

**Consequence:** a later day promoting `Relationship` to its own table is additive —
`Claim` keeps its own `subjectOrgId`/`relationshipType` columns either way, and the
promotion would add a `relationshipId` foreign key alongside them, not replace anything.
Flagged in the build log's "what's NOT done" so the next day doesn't rediscover this
gap by surprise.

### 4. Resolving the scope's own two conflicting RelationshipClaim state machines

**The problem, found during this stage, after Blocks 1–2's own design work was already
underway:** the spec p.5 states RelationshipClaim's canonical state machine in a
compact table:

> `RelationshipClaim || PROVISIONAL → VERIFIED → AOR_ACTIVE/ATTRIBUTABLE → EXPIRED;
> DISPUTED/REASSIGNED side states`

This directly conflicts with the SAME page's own Journey A prose, a few paragraphs
above it:

> "...claim remains SEALED or SUBMITTED → operator verifies relationship... → claim
> becomes VERIFIED, PARTIAL, DISPUTED or REJECTED."

Neither source names all of the other's states: the table has no `PARTIAL`/`REJECTED`;
the prose has no `PROVISIONAL`/`AOR_ACTIVE`/`ATTRIBUTABLE`/`REASSIGNED`. This is the
same class of problem the ADR-0005 already solved once for `DisclosureClass`
("the scope states its own enum three different ways across three pages") — the same
resolution discipline applies: pick the more operationally-grounded, gate-exit-condition-
serving reading, document the deviation and the reasoning clearly, move forward.

**Decision:** Journey A's prose is canonical for `Claim.status`
(`@tol/domain/src/claim-states.ts`: `FILED → SCORED → {VERIFIED, PARTIAL, DISPUTED,
REJECTED, EXPIRED, WITHDRAWN}`), for three concrete reasons:

1. **P10's own exit condition** ("Claim scoring + **dispute path**") needs a decision
   outcome set the DISPUTE WORKFLOW can resolve into. `PARTIAL` is the literal mechanism
   the spec's own Rules section requires ("Shared attribution is allowed when evidence
   shows a real introduction chain; do not force a false single winner") — the table's
   `AOR_ACTIVE`/`ATTRIBUTABLE`/`EXPIRED` set has no obvious equivalent for a *shared*
   outcome.
2. **`AOR_ACTIVE`/`ATTRIBUTABLE` read as a downstream ECONOMICS-eligibility concept, not
   an Attribution-scoring concept.** "AOR" is the standard cross-industry abbreviation
   for "Agent/Attribution of Record" — a claim that has become the *active*, *currently
   economically attributable* credit-holder. the spec's own `AttributionLink` object
   ("`relationshipClaimId, opportunityId, dealId, scheduleId`") is exactly the join that
   would need a claim to be in an "attributable" state before `EconomicSchedule`/
   `CommissionAccrual` can reference it — that's **P15 Economics**, not P10 Attribution,
   and P15 isn't built this day (nor was it asked to be).
3. **Journey A is the more heavily-detailed source for this specific workflow** — a full
   step-by-step narrative naming the actor (Contributor), the reviewer action ("operator
   verifies... without exposing unnecessary content"), and all four decision outcomes in
   one place, versus a compact table whose primary job (given its own header, "Object ||
   States") is a terse cross-entity summary shared with five OTHER entities' state
   machines on the same page.

**What was NOT silently dropped:**

- `PROVISIONAL` (the table's name for the pre-decision state) is captured functionally,
  not as a distinct status value — `Claim.provisionalExpiresAt` /
  `isClaimProvisionalExpired()` implement exactly what the scope's Rules section
  describes for it ("Provisional claims expire if the contributor cannot validate the
  relationship within a configurable window") against the `SCORED` status, which is
  functionally "provisional" in every sense that rule cares about.
- `REASSIGNED` (the table's own dispute-adjacent side state) has no dedicated status
  value in this build, but the same functional OUTCOME is reachable through the existing
  mechanism: when a dispute resolves `REJECTED_ORIGINAL`, the original claim moves to
  `REJECTED` and — in the scope's own anti-gaming scenario — a SEPARATE, already-filed
  competing `Claim` (the challenger's own) independently holds/reaches `VERIFIED`. The
  net effect (attribution moves from one claimant to another) is the same; this build
  represents it as two claim rows changing state rather than one claim being
  "reassigned" in place, consistent with `Claim` never being edited to point at a
  different `claimantOrgId` after filing (immutability of who-filed-what, matching this
  codebase's "editing creates a new version/row" precedent used elsewhere — RFQVersion,
  Quote).
- `AOR_ACTIVE`/`ATTRIBUTABLE` are flagged here, explicitly, as **not built** — an open
  item for whichever day builds P15 Economics, which will need SOME gate to determine
  "is this claim currently eligible to back an `AttributionLink`." The natural,
  additive extension point is a new `Claim` status value (or a computed predicate over
  the existing `VERIFIED`/`PARTIAL` + a not-yet-expired/superseded check) — not a
  rewrite of what earlier built.
- `WITHDRAWN` (this build's own addition, not named in either scope source for
  `RelationshipClaim`) is inferred, matching this codebase's own precedent for adding a
  reasonable, unnamed-but-necessary escape hatch (the `Quote`/`RFQ` gained a
  `WITHDRAWN` status the prototype/scope didn't spell out either, for the same
  "claimant needs to be able to retract before a decision exists" reason).

### 5. `claim.submitted` (event) vs `FILED` (status): a deliberate naming divergence

the spec names three Attribution domain events verbatim: `claim.submitted;
claim.verified; claim.disputed`. This build's own `ClaimStatus` enum uses `FILED`, not
`SUBMITTED`, for the same pre-scoring status (chosen during this stage, before p.26's event
list had been read closely — Journey A's own prose says "SEALED or SUBMITTED," and
`SEALED` was rejected as a status-value candidate because it would collide in meaning
with the UNRELATED `Lockbox.status` value of the same name).

Rather than retroactively rename `FILED` (a real, already-migrated, already-tested,
already-seeded status value by the time p.26 was read closely in this stage) to match
`claim.submitted`, this build accepts the small, acknowledged inconsistency: every OTHER
event in this codebase names itself as the exact lowercase of its triggering status
(`SENT → rfq.sent`, `LIVE → deal.live`, `SEALED → lockbox.sealed`) — `claim-events.ts`
breaks that pattern for exactly this one event, using the scope's own literal p.26 word
(`claim.submitted`) for the FILED-triggering event rather than inventing `claim.filed`.
The header comment on `packages/events/src/claim-events.ts` documents this divergence
explicitly, and a dedicated test (`claim-events.test.ts`: "`claim.filed` is NOT a valid
event type") asserts the non-obvious name is intentional, not a typo a future editor
should "fix."

**Consequence:** `Claim.status` and `ClaimEventType` are NOT a 1:1 lowercase mapping for
this one value, unlike every sibling vertical. Flagged here rather than left as a silent
inconsistency someone has to rediscover.

## Consequences

- `packages/attribution` ships with 68 tests, zero runtime dependencies, zero clock
  dependency — a genuinely pure function of its inputs, matching
  `packages/domain`/`packages/authz`/`packages/crypto`'s existing "zero deps" discipline
  in this monorepo.
- The Claim/ClaimEvidence/ClaimDecision/ClaimDispute schema is real but deliberately
  thinner than the scope's own canonical ~60-entity model in the ways enumerated above —
  every cut is documented in the build log's "what's NOT done," not silently absent.
- `Claim.status`'s divergence from the scope's own p.5 table (favoring Journey A's prose
  instead) is a considered, documented decision, not an oversight — reversible without a
  rewrite if a later day's P15 Economics work needs the table's `AOR_ACTIVE`/
  `ATTRIBUTABLE` states after all (additive, per point 4 above).
- Gate affected: **P10 — Attribution** (`Claim scoring + dispute path`) — this ADR
  documents the mechanism P10's DONE status depends on; see
  the test-evidence record for p10-attribution` for the actual evidence. Also touches **P3 — Data**
  (Claim/ClaimEvidence/ClaimDecision/ClaimDispute are the scope's next slice of the
  ~60-entity model, 27 tables total) and **P16 — Audit** (every claim action writes both
  an `AuditEvent` and a `DomainEvent`).
