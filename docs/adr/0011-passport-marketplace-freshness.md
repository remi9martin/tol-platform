# ADR-0011: Marketplace redaction mechanism, Passport data model, on-read freshness (no worker), and Opportunity volume reconciliation

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** the build, within the bounds of ADR-0005
(canonical `DisclosureClass` ladder), D8 part 2 ("thin but honest" entity-building
discipline), and the earlier build brief's explicit instruction that field permissions
"MUST be enforced SERVER-SIDE... a market-level browser must be physically unable to
retrieve deal-private fields via the API — redaction happens on the server before the
response is serialized, NOT by the client hiding them," verified by the gate
"inspecting the raw API response — a UI-only anonymization fails."

## Context

earlier builds Passport (P6) and Marketplace visible inventory (P5) — "the visible
marketplace + portable trust discovery layer" — plus completing Opportunity (P7) and
Capacity (P8). Unlike every prior day's security-critical property (the Lockbox:
prove ciphertext is real; the Attribution: prove a claim's score is correct), the
core property is a NEGATIVE proof: prove something is ABSENT from a response, which is a
qualitatively easier property to get quietly wrong (a field silently reappearing is a
much easier mistake to ship than a signature silently failing to verify). Two smaller,
genuinely open design questions surfaced during the build, both shared between P6 and
P8: whether "freshness works" requires the background worker (`apps/worker`) neither
gate's owning-package list has ever had built, and how to fit Passport's markedly more
polymorphic data (`Fact.normalizedValue` — a string, a number, a boolean, or a small
object depending on which of 8 named fields it is) into this codebase's existing
Json-column discipline (`packages/db/src/json-guards.ts`, D2-era), which until now has
only ever seen two shapes: a plain object or a flat string array.

## Decision

### 1. Marketplace redaction: a fixed return-field list is the real boundary, `ownerOrgId: null` for every caller

`@tol/authz`'s `fieldPolicy()`/`redactFields()` (built earlier) computes visibility from a
resource's `privacyClass` tags AND the actor's relationship to the resource (ownership,
same-org, cross-org grant). A marketplace catalog, by definition, has no "relationship
to the resource" that should ever matter — every browsing org sees the same anonymized
card regardless of whether they happen to also be the actual owner. `apps/api/src/
modules/marketplace/mapper.ts` therefore calls `redactFields()` with the `Resource`
object's `ownerOrgId` forced to `null` for EVERY caller, uniformly — never the resource's
real owning org id, regardless of who is actually asking.

This has one consequence worth naming precisely: for a role with `fieldPolicy()`'s
broadest SECRET-tier visibility (PLATFORM_OWNER — the only role granted unconditional
access to the SECRET disclosure tier regardless of resource ownership, per D5's ladder),
`redactFields()`'s own intermediate `visible` object legitimately DOES contain
`commercialTerms`, exact `monthlyCapacityMinor`, and `providerOrgId` — `fieldPolicy()` is
behaving exactly as designed; the marketplace mapper's `ownerOrgId: null` trick doesn't
change what a superuser role is entitled to see in principle, only what this specific
FUNCTION exposes.

**The actual safety mechanism is one layer further down, and it is the one that
matters:** `toMarketplaceCapacityCard`/`toMarketplaceOpportunityCard`'s `return`
statement is a fixed, hand-picked list of exactly 8 named properties
(`cardId, freshnessClass, acceptingNewVolume, jurisdictions, mccsAccepted, currency,
monthlyCapacityBand, riskTier` for capacity; `cardId, opportunityType, status, currency,
jurisdictions, mccs, offeredVolumeBand` for opportunities). This object literal never
reads `commercialTerms`/`providerOrgId`/exact minor-unit fields back out of the
intermediate `visible` object FOR ANY ROLE — the redaction that matters is structural
(the field is never named in the object that gets serialized), not permission-based (the
field is present but blanked). A `.strict()` zod schema on the wire contract
(`packages/contracts/src/marketplace.ts`) adds a second, independent enforcement layer:
even if a future edit accidentally widened the mapper's return object, `.strict()` would
reject any extra key at serialization/parse time rather than silently passing it through.

**This was not merely reasoned about — it was empirically verified**, because this
day's own review raised exactly the theoretical concern above as 5 separate
BLOCKER findings against this stage (each independently claiming that PLATFORM_OWNER's
broader `fieldPolicy()` visibility would leak into the marketplace response). Rather
than dismiss on code-reading alone, a real HTTP probe was written and run: logged in as
an actual PLATFORM_OWNER, hit `GET /market/capacity` against a `CapacityProfile` seeded
with sentinel `commercialTerms` values, and inspected the raw response body. Result: the
card contained exactly the 8 safe keys, no sentinel value anywhere in the serialized
JSON. This probe was then promoted into a PERMANENT regression test
(`apps/api/tests/integration/marketplace.test.ts`) rather than discarded once the
immediate question was answered, specifically because "the one role with the most
theoretical exposure never actually gets it" is exactly the kind of property that should
never be allowed to regress silently.

**Consequence:** the marketplace's redaction boundary lives in exactly one place per
card type (a `return` statement's fixed field list), backed by a `.strict()` wire schema
as a second independent layer, proven against the raw response body for every one of
the 10 personas including the one with maximum theoretical visibility. A future
developer adding a field to `CapacityProfile`/`Opportunity` cannot accidentally leak it
into the marketplace without also editing this specific function — the omission is the
safe default, not something that has to be remembered.

### 2. Passport data model: polymorphic Fact values, append-only Evidence/ReadinessResult, a stricter-than-domain `verify()`

the spec's Passport/Fact/Evidence schema is more polymorphic than anything this
codebase has modeled so far. Every prior Json column (`CapacityProfile.commercialTerms`,
`RFQVersion.disclosureSnapshot`, `Opportunity.jurisdictions`, `ClaimDispute.evidence`)
has one FIXED shape per column, validated by one of two existing guards
(`assertJsonSafePlainObject` for an object, `assertStringArray` for a flat string list).
`Fact.normalizedValue` is different by design: depending on which of the 8 named
`requiredFacts` a given row represents (`legalEntityConfirmed` is a boolean;
`processingHistorySummary` is a small object; a future numeric fact could be a plain
number), the SAME column holds a different JSON type per row.

**Decision:** a new guard, `assertJsonSerializableValue` (`packages/db/src/
json-guards.ts`), accepting any JSON-serializable scalar or object, rejecting only what
would corrupt or crash (bigint, function, symbol, non-finite number, circular
reference — the same class of defect every other guard in this file rejects) plus,
specifically, `null`/`undefined`. The null/undefined rejection is a deliberate modeling
choice, not an arbitrary strictness increase: this codebase represents an absent Fact by
the ROW ITSELF being absent (no `Fact` row for that `fieldKey` on that `Passport`),
never by a present row holding a null value — which keeps `packages/evidence`'s
readiness engine's "does this required fact have a value" check a simple row-existence
query, with no separate null-check needed on top of it.

After this day's own this stage review (raised against `PassportActions.tsx`'s
client-side `JSON.parse()` on a Fact's free-form input, a theoretical prototype-pollution
concern), `assertJsonSerializableValue` was extended to also reject `__proto__`/
`constructor`/`prototype` as an object key at any depth — reusing the exact
`DANGEROUS_KEYS` concept `@tol/authz`'s `redactFields()` already established on earlier.
Investigated before fixing: prototype pollution requires the parsed object to later be
`Object.assign`/spread into a shared live object, which nothing in this codebase's
Fact-write path does (`normalizedValue` is stored as an opaque JSONB value, read back via
plain property access, never merged) — not reachable via any real call path today. Fixed
anyway, as a second, independent, cheap choke point, consistent with this codebase's
recurring "belt and suspenders" pattern (`packages/crypto`'s Shamir split PLUS
`packages/authz`'s release gate, D9; the anti-squatting hard rule PLUS D0's zero
proximity score, D10).

`Evidence` and `ReadinessResult` are both append-only by construction — no
update/delete function exists in either repository — the same discipline
`packages/db/src/repositories/audit.repository.ts` established for `AuditEvent` on
earlier and `ClaimDecision` reused on earlier (D10). A Passport's readiness HISTORY is
therefore reconstructable: every recompute writes a new `ReadinessResult` row rather
than overwriting the last one.

**A deliberate service-layer restriction on top of the domain layer:**
`passportService.verify()` only accepts a transition from `READY`, never from `STALE`,
even though `@tol/domain`'s own `passport-states.ts` transition table permits a
`STALE → VERIFIED` edge structurally (a Passport recovering from staleness by being
re-verified is a legitimate domain-level path). This is the same split this codebase
uses elsewhere: the domain layer defines what state changes are STRUCTURALLY possible;
the service layer decides which of those the actual business process ALLOWS right now.
Reasoning: verifying a Passport whose readiness computation is already known to be stale
would certify a snapshot the system itself doesn't currently trust — the service forces
a fresh, non-stale readiness computation to exist before verification can proceed,
rather than let an operator verify against a number that might already be wrong.

### 3. P6 and P8: DONE via on-read computation — a stated engineering call, not an oversight

Both P6 (Passport: "Readiness/provenance/freshness works") and P8 (Capacity: "Private
provider profile + freshness") name freshness as part of their own exit condition, and
this repo's own pre-existing the gate table tracking (set up before earlier, by
whoever first read the scope doc) lists `apps/worker` — specifically a
"passport-readiness job" and a "capacity-freshness job" — among each gate's own owning
packages. `apps/worker` does not exist in this repository. It was flagged here at the
time as "earlier scope, per this build's own explicit instructions" — not something earlier
was asked to build. the actual assignment became P15 Economics instead;
`apps/worker` remains unbuilt and unscheduled as of an earlier close-out (see
ADR-0013).

**The question this build had to resolve, explicitly, per its own brief:** does
"freshness works" require that background job to exist, or does correct SYNCHRONOUS
computation — performed every time the relevant record is actually read — satisfy the
exit condition as literally written.

**Decision: on-read computation satisfies the exit condition, and both gates are marked
DONE.** Three reasons:

1. **The exit-condition TEXT says "works," not "is proactively recomputed on a
   schedule."** A reasonable, literal reading of "works" is behavioral: when an actual
   viewer looks at a Passport or a CapacityProfile, is the freshness/staleness value
   shown to them CORRECT. This build answers yes, provably: `classifyCapacityFreshness`/
   `classifyFactFreshness`/`isPassportReadinessStale` are real, pure, deterministic,
   unit-tested functions (`packages/evidence`, `packages/domain`), called live at read
   time (`apps/api/src/modules/capacity/service.ts`'s `liveFreshness()`;
   `apps/api/src/modules/passport/service.ts`'s `loadDetailWithStalenessCheck()`) — not
   a value set once at creation and left to rot, which was the actual gap for P8
   (`freshnessClass` was client-suppliable and write-time-only; this build makes it
   server-computed and read-time-live, closing that specific, previously-identified
   gap rather than redundantly re-building something that already existed).
2. **The Passport case goes further than a transient computed value: an observed
   `STALE` transition is durably PERSISTED.** `loadDetailWithStalenessCheck` re-reads
   the Passport fresh INSIDE a transaction, re-validates that it is still eligible to
   be marked stale (status still `READY`/`VERIFIED`, guarding against a genuinely
   concurrent mutation that changed things between the outer check and the write — a
   real race this day's own this stage review surfaced, fixed with the same
   re-read-inside-transaction pattern earlier established), and writes the `STALE` status
   back to the row. The NEXT reader — even one who never triggers a fresh
   computation themselves — sees the correct, already-persisted status.
3. **Precedent: D9 already established that a deliberate, reasoned engineering
   deviation from an originally-imagined mechanism can still satisfy a gate's real
   functional requirement.** Lockbox's exit condition didn't literally require
   "browser-side `crypto.subtle`," it required "ciphertext/receipt/withdraw/release
   evidence" — server-side Node `crypto` satisfied the actual security property just as
   well, arguably better (D9). The same reasoning applies here: the gate's real
   requirement is that freshness classification be genuinely correct, not that it be
   computed by any particular kind of process.

**What a future `apps/worker` would add, named explicitly so it is not mistaken for a
correctness gap:** PROACTIVE reclassification of a record nobody has read recently — a
CapacityProfile that ages from FRESH into STALE while sitting unviewed would keep
showing its last-computed value until someone next requests it. This matters for a
notification feature ("your listing just went stale, please refresh it") or for
marketplace-wide filtering at scale (excluding STALE capacity from a browse query without
paying a live-computation cost per row per request) — real, legitimate future work, but
an operational/scale concern, not a defect in what any actual viewer is shown today. Both
gates' the test evidence entries name this distinction in exactly these terms rather
than asserting an unqualified DONE that glosses over it.

### 4. Opportunity volume reconciliation: one grand-total check, currency-aware, wholesale-replace

the spec names three separate reconciliation checks: `SUM(volume_by_jurisdiction) =
offered_card_gpv`, and the same for MCC and for the jurisdiction×MCC cross product. All
three collapse into a SINGLE check over the finest-grain `VolumeSlice` rows — grouping
by jurisdiction, by MCC, or by both never changes the value of the grand total sum across
every row, so proving `SUM(all slices) = offeredCardGpvMinor` once is mathematically
equivalent to proving all three of the scope's named formulas independently. This
simplified the reconciliation engine considerably without weakening what it actually
proves.

`VolumeSlice`'s own uniqueness key is `(opportunityId, jurisdiction, mcc, cardOrigin,
channel, period)` — the finest grain the scope names. A slice submitted in a currency
other than the Opportunity's own declared currency is EXCLUDED from the sum
(`currency_mismatch`) rather than naively coerced or summed as if equal-valued — a real
design fix from this day's own this stage review, which correctly flagged that
silently summing mixed-currency minor-unit integers together produces a meaningless
number, not merely an imprecise one.

`PUT /opportunities/:id/volume-slices` is a wholesale-replace endpoint, not an
incremental patch — a full resubmission replaces the ENTIRE prior slice set for that
Opportunity, matching this codebase's existing "editing creates a new complete version"
precedent (RFQVersion, Quote) rather than a partial-update semantic that would need its
own separate diffing logic. **A real bug, caught by this day's own integration test, not
by review:** the original implementation reconciled AFTER a naive
delete-existing-then-insert-each-slice loop, so a duplicate cell within one submission
hit the database's own `@@unique` constraint on the second identical insert and threw an
unhandled `DuplicateVolumeSliceCellError` — a 500 — before the domain layer's intended
SOFT `duplicate_cell` reconciliation report ever had a chance to run. Fixed by computing
`reconcileOpportunityVolume()` against the RAW submitted input BEFORE any database write,
then persisting only the first occurrence of each cell — the duplicate is still fully
and correctly reported in the reconciliation response, at a clean `200`, never a 500 and
never silently dropped without being reported.

## Consequences

- The marketplace's core security property — visible at the market level, private at
  the deal level — is enforced at exactly one place per card type (a fixed
  `return`-statement field list), backed by a `.strict()` wire-contract schema as a
  second independent layer, and proven against the raw HTTP response body for all 10
  personas including the one role with maximum theoretical field visibility. See
  the test-evidence record for p5-marketplace`.
- Passport's data model accepts genuinely polymorphic Fact values without weakening this
  codebase's existing "fail loud on a JSON-unsafe value" discipline, and gains a second,
  independent defense-in-depth layer against a class of attack (prototype pollution) not
  currently reachable via any real code path but cheap to close anyway.
- P6 and P8 are DONE via a stated, reasoned engineering call (on-read computation, no
  worker) rather than an unqualified claim that glosses over `apps/worker`'s absence — a
  later day building that worker is additive (proactive reclassification on top of
  already-correct on-read values), not a rewrite, matching D8/D9/D10's own "thin but
  honest, promote later" precedent.
- Opportunity volume reconciliation is provably equivalent to all three of the spec's
  named formulas via one simpler check, is currency-aware rather than silently
  corrupting mixed-currency sums, and its wholesale-replace endpoint correctly reports
  (rather than 500s on) a duplicate submitted cell.
- Gates affected: **P5 — Marketplace**, **P6 — Passport**, **P7 — Opportunity**, **P8 —
  Capacity** (all four move to DONE this day). Also touches **P3 — Data** (Passport,
  Fact, Evidence, ReadinessResult, VolumeSlice — 5 more tables, 32 total) and **P16 —
  Audit** (passport fact/evidence/verify actions now also write both an `AuditEvent` and
  a `DomainEvent`, matching every prior vertical's pattern).
