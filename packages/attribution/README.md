# packages/attribution — Relationship Claim Scoring

Relationship claim scoring + dispute path (the spec). One of the four business-invariant packages named on the spec.

Serves gate(s): P10 Attribution.

## Status: real implementation (this stage)

A deterministic, explainable, zero-runtime-dependency scoring engine — no ML, no statistical model, no randomness (ADR-0004: deterministic-only). Every score is derived live from a claim's raw inputs; nothing is a lookup of a pre-baked/stored number.

**Four factors, the spec's weights verbatim:**

| Factor | Weight | Evidence examples (p.18) |
|---|---|---|
| HISTORY (`priorCommercialHistoryMonths`) | 40% | Completed deals, signed agreements, prior compensation, acknowledged activity |
| PROXIMITY (`directnessTier`, p.13's D0-D5) | 30% | Authorized commercial/risk/partner contact; directness tier |
| EVIDENCE (`evidenceItems`) | 20% | Email/thread, counterparty acknowledgment, contract, CRM provenance |
| TIME (`submissionLagDays`) | 10% | Timestamp of qualifying claim, not public-name entry |

**Anti-squatting mechanism:** a claim at directness tier `D0` ("public knowledge only") scores `total: 0`, hard-forced, regardless of its other three factors — the spec's "creates no attribution" and p.18's anti-gaming test ("Twenty public provider names submitted with no relationship evidence yield zero verified equity/attribution credit") are both enforced as an explicit rule (`ATTRIBUTION_CONFIG.zeroAttributionTiers`), not left as an emergent side effect of D0's own proximity weight.

**Explainability:** `scoreClaim()` returns a full per-factor breakdown (`history`/`proximity`/`evidence`/`time`/`weighted`/`total`), a per-evidence-item contribution list (`evidenceBreakdown`), and version stamps (`algorithmVersion`, `inputVersions`) — never just a bare total. `computedAt` is deliberately NOT part of this package's output (see `scoring.ts`'s header comment); the persistence layer stamps a real timestamp when it saves a Claim row, the same way `apps/api`'s lockbox service stamps `sealedAt` outside `@tol/crypto`'s pure `sealPayload()`.

**Determinism:** the engine never reads a clock or any other ambient state — `scoreClaim(input)` called any number of times with the same `input` returns a deep-equal result every time, proven directly in `scoring.test.ts` (hundreds of repeated calls, plus permutation-invariance proofs for `rankClaims`).

**Ranking, not deciding:** `rankClaims()` orders competing claims by score (tie-broken by earliest submission, the spec) for **operator review** — it never writes a decision. Per the spec: *"Scoring ranks competing claims for operator review; it does not automatically rewrite pre-existing legal rights."* The actual VERIFIED/PARTIAL/REJECTED outcome is always a human reviewer's `ClaimDecision` (`@tol/domain`'s `claim-states.ts`, this stage of this day's build; `apps/api`'s claims module, this stage).

**Reuse-reference note:** the prototype's `attribution.ts` was read for scoring *shape* guidance (four named factors, a live-computed breakdown, a ceiling mechanism) — never edited. Its weights (35/30/20/15) and its free-text `originType` ceiling do not match the build spec; this package uses the scope's own numbers (40/30/20/10) and re-anchors the ceiling mechanism to the scope's own D0-D5 directness vocabulary instead. See ADR-0010.

Import boundary: consumers import only from this package's public `src/index.ts` via the `@tol/attribution` workspace alias. Deep imports into `@tol/attribution/src/internal/...` are forbidden (the spec).

## Zero runtime dependencies

Same discipline as `@tol/domain`/`@tol/authz`/`@tol/crypto` — pure TypeScript over `unknown`/primitive inputs, no Prisma, no HTTP, no filesystem. `DirectnessTier`/`ClaimEvidenceType`/`EvidenceVerificationState` are declared as this package's own copy (not imported from `@tol/domain`) for exactly that reason — see `src/types.ts`'s header comment for the cross-check-test precedent this follows (`@tol/domain`'s `LockboxShareRole`/`@tol/crypto` pattern).
