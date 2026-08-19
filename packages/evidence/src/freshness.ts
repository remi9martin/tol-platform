// packages/evidence/src/freshness.ts
//
// the spec "Freshness classes" (verbatim) + p.14 (Evidence provenance/
// expiration: "Expiration is field-specific: corporate registration may
// refresh on one cadence; processing metrics may be monthly; capacity
// appetite may be much shorter"). Two related but distinct classifiers
// sharing the same FreshnessClass output vocabulary — see config.ts's
// own header comment for why Capacity is judged by AGE-SINCE-
// CONFIRMATION (`asOf`) while a Passport Fact is judged by EXPIRY
// (`expiresAt`), not one universal freshness clock.
//
// Both are pure, zero-DB, zero-clock-dependency — every function takes
// an explicit `now: Date` rather than reading the clock internally, so
// "same inputs + same reference time -> identical output" is provably
// true, not just asserted (this file's own test suite proves it with a
// repeated-call determinism check, the same discipline as
// @tol/attribution's scoreClaim 500-call proof).

import { EVIDENCE_CONFIG } from "./config.js";
import type { FreshnessClass } from "./types.js";

/**
 * the spec UNKNOWN: "discovery lead only; not counted as active
 * marketplace capacity." Read as a SOURCE-driven condition (was this
 * profile ever directly platform-confirmed, or is it an import/
 * connector-discovered lead never reconfirmed) rather than a fourth age
 * band — see config.ts's own header comment for the full reasoning.
 * `sourceType` mirrors `@prisma/client`'s `SourceType` values
 * (PLATFORM/IMPORT/CONNECTOR/MIGRATION/SYSTEM) as a plain string — this
 * package declares no dependency on `@prisma/client` (zero-runtime-
 * dependency discipline, same as every other package in this build).
 */
export interface CapacityFreshnessInput {
  asOf: Date;
  sourceType: string;
}

/**
 * the spec's FRESH/AGING/STALE ladder, computed from elapsed REAL TIME
 * since `asOf` in milliseconds — never calendar/wall-clock arithmetic
 * (review,
 * raised a DST/leap-year drift concern against this exact approach and
 * was verified false: DST/leap-years affect calendar-DATE computation,
 * not elapsed-DURATION computation; a "30-day window" measured this way
 * is exactly 30 x 86,400,000 ms regardless of any DST transition inside
 * that span). `UNKNOWN` overrides the age ladder entirely when
 * `sourceType` indicates this profile was never directly
 * platform-confirmed (p.16: "discovery lead only").
 */
export function classifyCapacityFreshness(
  input: CapacityFreshnessInput,
  now: Date,
  windows: { fresh: number; aging: number } = EVIDENCE_CONFIG.capacityFreshnessWindowDays,
): FreshnessClass {
  if (input.sourceType !== "PLATFORM") return "UNKNOWN";

  const ageMs = now.getTime() - input.asOf.getTime();
  if (ageMs < 0) {
    // asOf in the future relative to `now` — a malformed/clock-skewed
    // input, not a real freshness state. apps/api's capacity service
    // always stamps `asOf = new Date()` server-side at write time
    // (never client-supplied — see that service's own comment), so this
    // branch is defensive-only. Treated as FRESH (age effectively 0)
    // rather than thrown — this package's general "never throw on a
    // plausible edge, only on a structurally impossible one" stance,
    // deliberately looser than @tol/domain/money.ts (money invariants
    // are stricter than a freshness-clock read: a negative amount is
    // never legitimate, but a few seconds of clock skew across two
    // servers is an ordinary operational reality).
    return "FRESH";
  }

  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays <= windows.fresh) return "FRESH";
  if (ageDays <= windows.aging) return "AGING";
  return "STALE";
}

export interface FactFreshnessInput {
  /** The Fact's own effectiveTo, or its linked Evidence's expiresAt — whichever applies (see types.ts's FactSnapshot.expiresAt doc comment). Null when no expiry information exists at all. */
  expiresAt: Date | null;
}

/**
 * the spec: "Expiration is field-specific" — judged against a Fact's
 * OWN `expiresAt` rather than a universal age-since-write window (unlike
 * Capacity, above, which has exactly one clock — `asOf` — for every
 * profile). No expiry information at all -> UNKNOWN, generalizing p.16's
 * "discovery lead" meaning to "not enough information to classify."
 */
export function classifyFactFreshness(
  input: FactFreshnessInput,
  now: Date,
  warnWithinDays: number = EVIDENCE_CONFIG.factFreshnessWarnWithinDays,
): FreshnessClass {
  if (!input.expiresAt) return "UNKNOWN";

  const msUntilExpiry = input.expiresAt.getTime() - now.getTime();
  if (msUntilExpiry < 0) return "STALE";

  const daysUntilExpiry = msUntilExpiry / (24 * 60 * 60 * 1000);
  if (daysUntilExpiry <= warnWithinDays) return "AGING";
  return "FRESH";
}
