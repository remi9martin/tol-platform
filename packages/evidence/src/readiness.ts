// packages/evidence/src/readiness.ts
//
// the spec ReadinessResult ("Rules-based completeness || score,
// blockers, warnings, ruleVersion") + p.29 acceptance example
// (verbatim): "Passport: user can see exactly what blocks readiness and
// which evidence will cure it." Pure, zero-DB, zero-clock — takes an
// already-loaded array of FactSnapshots (this package never queries a
// database) and an explicit `now: Date` (used only to classify each
// fact's freshness via classifyFactFreshness, never read internally as
// a hidden side effect) — same "compute against passed-in values"
// discipline as @tol/domain's volume-reconciliation.ts and
// @tol/attribution's scoreClaim.

import { EVIDENCE_CONFIG } from "./config.js";
import { classifyFactFreshness } from "./freshness.js";
import type { FactSnapshot, ReadinessBlocker, ReadinessResultShape, ReadinessWarning, RequiredFact } from "./types.js";

/**
 * the spec/p.29 — the full readiness engine. `score` is the percentage
 * of ALL configured required facts (blocking + non-blocking) that are
 * present, deliberately a SEPARATE axis from `blockers` (p.29 wants "what
 * blocks readiness" named explicitly, not inferred from a bare
 * percentage — a Passport could score 75% and still be fully unblocked
 * if the missing 25% is entirely non-blocking facts).
 *
 * `blockers` lists every MISSING blocking required fact, plus every
 * PRESENT blocking fact whose freshness has gone STALE (an expired
 * blocking fact no longer satisfies its requirement — same "a Passport
 * cannot be READY on evidence that has expired" reasoning
 * @tol/domain/src/passport-states.ts's header comment already gives for
 * why READY/VERIFIED can regress). `warnings` covers missing
 * NON-blocking facts, AGING facts (both blocking and non-blocking —
 * visible signal ahead of expiry), and any present fact whose
 * `verification` is still SELF_REPORTED only (never independently
 * upgraded) — all visible, none of them gate READY.
 *
 * `inputVersions` is accepted as a plain pass-through, echoed onto the
 * returned shape verbatim (this package has no opinion on what a
 * version string means — the caller's concern, same precedent as
 * @tol/attribution's `ClaimScoringInput.inputVersions`).
 */
export function computeReadiness(
  facts: readonly FactSnapshot[],
  now: Date,
  inputVersions: readonly string[] = [],
  requiredFacts: readonly RequiredFact[] = EVIDENCE_CONFIG.requiredFacts,
): ReadinessResultShape {
  // Real fix (review): building the Map directly from `facts` would let a
  // duplicate fieldKey silently overwrite an earlier entry (JS Map
  // semantics — last write wins), corrupting the readiness computation
  // without any signal. Structurally unreachable via the real call path
  // (schema.prisma's `Fact` has `@@unique([passportId, fieldKey])` — one
  // passport can never have two Fact rows with the same fieldKey at the
  // DB layer), but this is a pure function with no awareness of where
  // its input came from; failing loudly here is cheap and matches this
  // package's "fail loud on a genuinely impossible state" stance.
  const seenFieldKeys = new Set<string>();
  for (const f of facts) {
    if (seenFieldKeys.has(f.fieldKey)) {
      throw new TypeError(`computeReadiness: duplicate fieldKey "${f.fieldKey}" in facts — each fieldKey must appear at most once`);
    }
    seenFieldKeys.add(f.fieldKey);
  }

  const factByKey = new Map(facts.map((f) => [f.fieldKey, f]));
  const blockers: ReadinessBlocker[] = [];
  const warnings: ReadinessWarning[] = [];
  let presentCount = 0;

  for (const req of requiredFacts) {
    const fact = factByKey.get(req.fieldKey);
    const hasValue = fact !== undefined && fact.hasValue;

    if (!hasValue) {
      const target = req.blocking ? blockers : warnings;
      target.push({ fieldKey: req.fieldKey, sectionType: req.sectionType, message: `Missing ${req.blocking ? "required" : "recommended"} fact: ${req.label}` });
      continue;
    }

    presentCount += 1;

    const freshness = classifyFactFreshness({ expiresAt: fact.expiresAt }, now);
    if (freshness === "STALE") {
      const message = `${req.label} evidence has expired`;
      (req.blocking ? blockers : warnings).push({ fieldKey: req.fieldKey, sectionType: req.sectionType, message });
    } else if (freshness === "AGING") {
      warnings.push({ fieldKey: req.fieldKey, sectionType: req.sectionType, message: `${req.label} evidence is approaching expiry` });
    }

    if (fact.verification === "SELF_REPORTED") {
      warnings.push({ fieldKey: req.fieldKey, sectionType: req.sectionType, message: `${req.label} is self-reported only, never independently verified` });
    }
  }

  const score = requiredFacts.length === 0 ? 100 : (presentCount / requiredFacts.length) * 100;

  return {
    score,
    blockers,
    warnings,
    ruleVersion: EVIDENCE_CONFIG.ruleVersion,
    algorithmVersion: EVIDENCE_CONFIG.algorithmVersion,
    inputVersions,
  };
}

/**
 * The readiness engine's own answer to "is this Passport allowed to be
 * READY" — used by apps/api's passport service BEFORE calling
 * @tol/domain's assertValidPassportTransition(..., "READY"), same
 * "compute the fact here, let the caller decide what to do about it"
 * division of labor as @tol/domain's reconcileOpportunityVolume.
 */
export function isReadinessBlocked(result: Pick<ReadinessResultShape, "blockers">): boolean {
  return result.blockers.length > 0;
}
