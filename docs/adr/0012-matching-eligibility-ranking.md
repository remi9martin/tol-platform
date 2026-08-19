# ADR-0012: Matching eligibility/ranking contract shape, no Match state machine, fail-open/fail-closed policy split, and live-computed inputs

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** the build, within the bounds of ADR-0004
(deterministic-only ranking, no ML), D8 part 2 ("thin but honest" entity-building
discipline), D11 part 3 (live-computed-never-stored-stale precedent), and the earlier
build brief's explicit instructions to reuse `..\the prototype repo\lib\matching.ts` for
its eligibility SHAPE while following the SCOPE's own 9-factor ranking model, not the
prototype's narrower 5-factor one.

## Context

earlier builds P11 (Eligibility) and P12 (Ranking) — the spec/p.20's deterministic
matching engine, the mechanism that turns a visible marketplace listing (earlier) into a
real, explainable recommendation. Five design questions surfaced during the build, none
answered directly by the scope doc's own text:

1. The reuse-reference prototype (`lib/matching.ts`) and the earlier task brief's own
   paraphrased sketch both describe a `failedRules`-shaped eligibility result; the scope
   doc itself (p.19) specifies a different, more detailed contract. Which wins when a
   secondary source disagrees with the primary one.
2. the spec's canonical Object×States table lists exactly six state machines and does
   NOT include Match/MatchResult, while the spec and p.20 both say match results are
   STORED and versioned ("all derived outputs record inputVersion(s)... mandatory for
   match scores"). Does MatchResult get a dedicated state machine, no persistence at
   all, or something in between.
3. Several eligibility rules (ROLE, TECHNICAL, ticket-size fit within VOLUME_TICKET)
   have no backing field anywhere in `CapacityProfile`/`Opportunity`'s actual Prisma
   schema — the data literally doesn't exist yet. Separately, EVIDENCE_LICENSE depends
   on Passport status, which DOES exist as a real system, just not always resolvable for
   a given candidate at evaluation time (no Passport row, a status lookup failure).
   Should both classes of "we don't actually know" produce the same rule outcome.
4. Which of the ten eligibility rule families' individual failure codes should be
   overridable by an operator, given the scope names "overridable" as a property without
   enumerating which specific findings qualify.
5. What "every active candidate capacity" means operationally for a synchronous HTTP
   endpoint, given a real dev database can and does accumulate far more `CapacityProfile`
   rows over time (fixture data from other days' own integration test suites) than any
   single opportunity will ever realistically match against.

## Decision

### 1. Contract shape: the SCOPE's verbatim eligibility/ranking shape wins over the task brief's paraphrase, and every derived output carries three separate version fields

`packages/matching`'s `EligibilityResult` (`eligible`, `blockers: RuleResult[]`,
`warnings: RuleResult[]`, `ruleVersion`, `evaluatedAt`) and `MatchRankingBreakdown`
(`factors: RankingFactorContribution[]`, `total`, `algorithmVersion`, `inputVersions`)
follow the spec/p.20's own field names and structure directly, not the earlier task
brief's own shorthand (`failedRules`) or the reuse-reference prototype's shape. Per this
codebase's established precedent (D10's attribution-weight correction: the scope's
40/30/20/10 table won over the prototype's uncited 35/30/20/15), the scope document is
the primary source; a secondary description that merely SUMMARIZES the scope loses when
the two disagree on exact shape.

Three separate version identifiers are stamped on every persisted `MatchResult`, never
collapsed into one: `ruleVersion` (`"matching-eligibility-v1"`, the eligibility engine's
own version), `algorithmVersion` (`"matching-ranking-v1"`, the ranking engine's,
`null` when ineligible — there is no ranking to version), and `inputVersions` (an array
of `"opportunity:<id>:v<n>"` / `"capacity:<id>:v<n>"` strings, the actual data snapshot
that produced this result). Keeping these three independent, rather than one combined
"matching-v1" string, means the eligibility RULES can change version independently of
the ranking WEIGHTS, and either can change independently of which data snapshot fed a
specific historical result — the same reasoning `@tol/evidence`'s `ReadinessResult`
already established for `ruleVersion`+`algorithmVersion` (D11 part 3), now extended to
a two-stage (not one-stage) pipeline.

### 2. No Match state machine — append-only persistence, the SAME resolution mechanism D8/D11 already established for a similar ambiguity

the spec's six-state-machine table (Opportunity, RFQ, Quote, DealRoom, Claim, Lockbox)
does not include Match. the spec/p.20's own language ("MatchResult stores...",
"mandatory for match scores") is unambiguous that a match result IS a persisted,
first-class record, not a stateless computed-and-discarded response. Resolution:
**`MatchResult` is a real Prisma table, with full base-audit columns, but has NO
transition table in `packages/domain` and no `status` field with meaningful states
beyond the record simply existing** — the same append-only derived-output pattern
`ReadinessResult` established on earlier (D11 part 2: "every recompute writes a new row
rather than overwriting the last one"). A fresh `POST .../matches/evaluate` call does
not update a prior `MatchResult` row for the same opportunity/capacity pair; it inserts
a new one, timestamped, versioned, keeping the full evaluation history queryable
(`matchResultRepository.listLatestByOpportunity` reads only the latest row per
capacity, via a DB-aggregated `groupBy`/`_max(evaluatedAt)`, not a client-side
in-memory reduction — a real scaling fix from this day's own this stage review, see
point 5 below and review). This is a direct application of D8 part 2's
"thin but honest" entity-building discipline and D11's own resolution of an identically
-shaped ambiguity (does P6/P8 need `apps/worker` or does on-read computation satisfy the
gate) — when the scope's OWN text answers the substantive question (yes, persist; yes,
version) without answering the MECHANISM question (state machine vs. append-only log),
this codebase's established precedent is to pick the simpler mechanism that satisfies
the substantive requirement, not to invent structure the scope never asked for.

**Eligibility-runs-first is enforced at three independent layers, not one:** (a) the
pure engine's own call architecture — `rankMatches()` takes an already-filtered eligible
list as its input type, it cannot be called with an ineligible candidate by construction;
(b) `matchResultRepository.create()`'s bidirectional guard — `eligible: true` requires
ALL of `rankingBreakdown`/`rank`/`totalScore`/`algorithmVersion` to be present, and
`eligible: false` requires ALL FOUR to be absent, checked both directions (a real
review fix, point 5 below); (c) `matchingService.evaluate()`'s own call sequencing —
eligibility is computed for every candidate first (`Promise.all`), ranking runs exactly
once over the resulting eligible subset second. the spec's own invariant ("an
ineligible provider cannot receive a higher final recommendation rank than an eligible
provider") holds structurally, not just by convention, and is additionally proven
empirically by a dedicated integration test in `packages/matching`.

### 3. Ranking model: a real 9-factor expansion of the prototype's 5-factor model, not a renamed copy

The reuse-reference prototype's `MATCH_CONFIG.weights` scores exactly 5 factors
(economics, reserve, approvalProbability, capacity, settlementTiming). the spec names
9: `mccProductFit` (0.22), `geographyLicensingFit` (0.17), `volumeTicketFit` (0.13),
`riskHistoryFit` (0.13), `settlementCurrencyFit` (0.10), `commercialUtility` (0.10),
`technicalLaunchFit` (0.07), `providerReliabilityFreshness` (0.05),
`outcomeCalibratedLikelihood` (0.03) — summing to 1.0, asserted at module load
(`assertRankingWeightsSumToOne()`), not merely assumed. Per the earlier brief's own
explicit instruction, this build follows the scope's 9-factor model, not the
prototype's 5-factor one; the prototype is reused for its ELIGIBILITY shape only
(`checkEligibility`'s general structure — a list of named checks, each pass/fail with a
reason), never copied for ranking weights or factor count.

`outcomeCalibratedLikelihood` is implemented as a fixed neutral placeholder (50, every
call, no learning) per D4's already-decided "DETERMINISTIC ONLY, NO ML/statistical
ranking" — the factor exists structurally (named, weighted at its scope-specified 3%,
contributing to the total) so that a future day can wire real outcome data into it
without changing the shape of `MatchRankingBreakdown`, but it carries zero information
today. This is the same "structurally present, honestly inert" pattern D4 already
established for this exact factor family; earlier did not have to invent this stance, only
implement it.

### 4. Fail-closed vs. fail-open/neutral is a deliberate two-way policy split, not an inconsistency

Two classes of "the engine cannot fully evaluate this rule" exist, and this build
resolves them oppositely, on purpose:

- **Structurally-absent-from-schema** (ROLE always passes trivially; TECHNICAL always
  returns `UNKNOWN`/non-blocking; the ticket-size-fit sub-check inside VOLUME_TICKET is
  skipped when no `averageTicketMinor` was supplied): these rules have no backing FIELD
  anywhere in `CapacityProfile`/`Opportunity`'s real schema yet. There is no
  "TechnicalCapability" data model in this repository at all — not missing due to a bug,
  genuinely not built. Blocking a real candidate on a rule this codebase cannot actually
  evaluate would be a false negative with no way for an operator to ever clear it (there
  is nothing to submit that would satisfy the rule). **Policy: non-blocking, surfaced as
  a `warning`, never a `blocker`.**
- **Operationally-missing-but-the-real-system-exists** (EVIDENCE_LICENSE, keyed to
  `context.providerPassportStatus`): Passport is a real, built system (earlier). When a
  specific evaluation call cannot resolve a candidate's Passport status — no Passport
  row exists yet for that provider org, or the lookup itself fails — that is missing
  DATA about a real, governed process (compliance/licensing verification), not an
  absent feature. **Policy: fail CLOSED, a `blocker`.** An operator has a real, existing
  path to clear this (create/advance the provider's Passport) — the rule blocking is
  actionable, not a permanent ceiling.

This mirrors D11 part 2's own domain-vs-service split reasoning (what's structurally
possible vs. what's actually allowed) applied to a new axis: what's structurally
UNMODELED (fail open) vs. what's a real, unmet precondition of an existing governed
process (fail closed). Every rule's stance is a one-line comment in `eligibility.ts`
citing this ADR, not left to be inferred from behavior.

**Overridability is tracked per specific failure CODE, not per rule family** —
`MATCHING_CONFIG.overridableFor(code)` looks up an explicit `overridableByCode` map,
defaulting to `false` for any code not listed. `JURISDICTION_NO_OVERLAP` and
`MCC_NOT_ACCEPTED` are never overridable (a hard product/licensing boundary);
`SETTLEMENT_CURRENCY_UNSUPPORTED` and `FRESHNESS_STALE` ARE (an operator can
consciously accept a currency mismatch or a stale-but-still-real profile as a judgment
call). Per-code, not per-family, because a single rule family (SETTLEMENT, VOLUME_TICKET)
can produce both a hard blocker and a soft one depending on which specific sub-check
fired — family-level granularity would have forced every finding from that family to
share one overridability stance, which the real rule set does not support.

### 5. Live-computed inputs, extended into the matching context; a documented, not silently-accepted, MVP-scale boundary

`matchingService.evaluate()` computes each candidate's `freshnessClass` via
`@tol/evidence`'s real `classifyCapacityFreshness` and the providing org's Passport
status via a new `liveProviderPassportStatus` helper — both computed FRESH for every
evaluation call, never read from a possibly-stale stored column. This directly extends
D11 part 3's precedent (`capacityService.liveFreshness`) into a second module.
`liveProviderPassportStatus` deliberately MIRRORS, rather than imports or calls,
`passport/service.ts`'s own `loadDetailWithStalenessCheck` — it reads and classifies but
never persists an opportunistic `READY → STALE` transition as a side effect of an
unrelated "evaluate matching" call, unlike Passport's own read path, which does persist
that transition when its own detail route is hit. Reasoning: a caller evaluating
matches for an opportunity should not silently mutate an unrelated provider org's
Passport row as a side effect — that would be a surprising, undocumented write path
into a resource the caller isn't otherwise touching.

**`MAX_CANDIDATE_CAPACITIES = 500`** caps how many active `CapacityProfile` rows one
synchronous `evaluate` call will consider. This is a real, acknowledged MVP-scale
boundary, not silently accepted: this day's own live browser verification pass
exercised it directly, evaluating a real opportunity against the dev database's full 98
accumulated `CapacityProfile` rows (well under the cap, but real production/demo data
volume will exceed 500 eventually) in a single synchronous request. The scope's own
`match-recompute.job.ts` (`apps/worker` — flagged here at the time as "earlier scope";
the actual assignment became P15 Economics instead, so `apps/worker` remains
unbuilt and unscheduled as of an earlier close-out — see ADR-0013) is the
real fix — an asynchronous, batchable recompute path — named directly in code comments
and review rather than worked around with an ad hoc pagination scheme this
pass.

**One real, pre-existing gap this day's own live verification collided with, not a new
defect:** both of this repository's seeded `Opportunity` rows had already progressed
past `MATCH_READY`/`INVITED` (to `SELECTED`) by the time earlier built against them —
`matchingService.evaluate()` correctly rejects evaluation against a non-`MATCH_READY`/
`INVITED` opportunity with a clean 400. the build log's own earlier close-out already
named this exact class of gap ("there is no API path to advance a fresh DRAFT
Opportunity to MATCH_READY/INVITED... noted here so the next day doesn't rediscover this
gap by surprise") — earlier did rediscover it operationally, worked around it for
verification purposes only (a direct, reverted `prisma.opportunity.update()` status
nudge via the real `@tol/db` client, not a code change), and confirms rather than
contradicts the existing note. See the test-evidence record for p11-eligibility` for the full
live-verification trace, including the successful post-nudge `201 Created` run.

## Consequences

- Eligibility and ranking results are versioned three ways independently (rules,
  algorithm, input snapshot), matching D11/D4's own precedent extended to a two-stage
  pipeline; a future rule or weight change is traceable to exactly which historical
  results it does or doesn't apply to.
- `MatchResult` persists as an honest, append-only historical log with no invented state
  machine — consistent with this codebase's recurring resolution pattern (D8 part 2,
  D11 part 3) for "the scope requires the substance but is silent on the mechanism."
  Eligibility-gates-ranking is structural at three independent layers, not merely
  conventional, and is proven empirically as well as by construction.
- The ranking model is scope-faithful (9 factors, weights summing to 1, asserted at
  module load) rather than a narrower inherited shape from the reuse reference —
  `outcomeCalibratedLikelihood` is present and honest about being inert, not omitted or
  faked.
- Fail-open-neutral vs. fail-closed-blocking is a named, cited, two-way policy — every
  rule's stance is discoverable from its own code comment, not inferable only from
  behavior; overridability is tracked at the precision the real rule set actually needs
  (per code, not per family).
- The 500-candidate synchronous evaluation boundary and the pre-existing
  MATCH_READY/INVITED precondition gap are both documented, both verified live (not
  merely reasoned about), and both point to their real, already-named fixes
  (`apps/worker`'s `match-recompute.job.ts`; an Opportunity-progression API/UI, neither
  earlier scope) rather than being worked around with scope creep.
- Gates affected: **P11 — Eligibility**, **P12 — Ranking** (both move to DONE this day).
  Also touches **P3 — Data** (`MatchResult`, 33 tables total) and **P16 — Audit**
  (`matching.evaluate` writes both an `AuditEvent` and one `DomainEvent`,
  `match.computed`, the spec's own verbatim event name).
