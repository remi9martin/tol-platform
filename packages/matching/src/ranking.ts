// packages/matching/src/ranking.ts
//
// the spec's own INVARIANT: "An ineligible provider cannot receive a
// higher final recommendation rank than an eligible provider. Eligibility
// runs first." Enforced structurally here, not just by convention:
// rankMatches() takes the CALLER's already-eligible capacity set as its
// only candidate pool — it never re-derives eligibility, never accepts
// an `eligible` flag to filter by, and has no code path that could rank
// an ineligible capacity above (or alongside) an eligible one, because
// an ineligible one is never IN the array to begin with. apps/api's
// matching module (this stage) is responsible for calling
// evaluateEligibility() first, keeping only `eligible: true` results,
// and passing THOSE capacities' inputs to rankMatches — the same
// two-step "filter, then rank" shape the spec/p.20 itself describes.

import { scoreMatch } from "./scoring.js";
import type { MatchCapacityInput, MatchContext, MatchOpportunityInput, RankedMatch } from "./types.js";

/**
 * Ranks a set of ALREADY-ELIGIBLE capacities against one Opportunity,
 * highest total-score first. Ties on `total` are broken by ascending
 * `capacityId` — the scope names no explicit ranking tie-breaker (unlike
 * @tol/attribution's claims, where p.18 names "submission timing"
 * explicitly), so this is a documented determinism guarantee (a real
 * different-capacityIds tie surviving `total` is exactly what
 * `tiedWith` surfaces to the caller/UI, same "do not force a false
 * single winner" reasoning as @tol/attribution's rankClaims), not a
 * claim that capacityId order carries business meaning.
 *
 * Deterministic: the same set of capacities produces the same output
 * regardless of the ORDER they're passed in — ranking.test.ts proves
 * this by feeding identical capacities in several different starting
 * permutations and asserting identical results every time, same
 * discipline as @tol/attribution's rankClaims proof.
 *
 * `context` is a required third parameter (the earlier build brief's own
 * sketch, `rankMatches(opportunity, eligibleCapacities)`, omits it —
 * this package follows the SCOPE's own determinism/versioning
 * requirements over that paraphrase, see ADR-0012): `context.now`
 * must be injected rather than read from the system clock for the same
 * provable-purity reason as evaluateEligibility, and `context.
 * merchantRiskProfile`/`inputVersions` feed scoring.ts's factor math.
 */
export function rankMatches(opportunity: MatchOpportunityInput, eligibleCapacities: readonly MatchCapacityInput[], context: MatchContext): RankedMatch[] {
  const scored = eligibleCapacities.map((capacity) => ({
    capacityId: capacity.id,
    breakdown: scoreMatch(opportunity, capacity, context),
  }));

  const sorted = [...scored].sort((a, b) => {
    if (b.breakdown.total !== a.breakdown.total) return b.breakdown.total - a.breakdown.total;
    return a.capacityId < b.capacityId ? -1 : a.capacityId > b.capacityId ? 1 : 0;
  });

  return sorted.map((entry, i) => {
    const tiedWith = sorted.filter((other) => other.capacityId !== entry.capacityId && other.breakdown.total === entry.breakdown.total).map((other) => other.capacityId);
    return { capacityId: entry.capacityId, rank: i + 1, breakdown: entry.breakdown, tiedWith };
  });
}
