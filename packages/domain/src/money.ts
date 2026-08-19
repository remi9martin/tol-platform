// packages/domain/src/money.ts
//
// the spec (Canonical Data Model, verbatim): "Money || integer minor
// units + ISO currency; never floating point" and "Basis points ||
// integer bps where applicable; decimal precision explicitly defined."
// This is a hard, repeatedly-cited invariant across the whole scope — RFQ
// quotes, capacity limits, reserve terms and volume figures all carry
// real commercial weight, so a stray float (e.g. a client sending
// `feeBps: 12.5` or `amountMinor: 4999.99`) must fail loudly here, in the
// domain layer, BEFORE it ever reaches a repository — not be silently
// coerced or rounded.
//
// This is defense in depth on top of @tol/contracts' zod `.int()` checks
// at the wire boundary (packages/contracts/src/*.ts) — belt and
// suspenders on purpose: contracts validates the REQUEST shape; these
// guards validate any money value a domain/service function constructs
// or re-derives internally (e.g. building a DealDecision.comparisonSnapshot
// from several stored Quotes), where no zod parse necessarily runs again.

export class MoneyInvariantError extends TypeError {
  constructor(message: string) {
    super(`money invariant violated: ${message}`);
    this.name = "MoneyInvariantError";
  }
}

/**
 * Asserts `value` is a safe, non-negative integer suitable for a "minor
 * units" money column (cents, pence, etc.). Does NOT bound-check against
 * Postgres INT4 vs INT8 range here — schema.prisma's own column type
 * (Int vs BigInt per field, see its money-fields comment block) is the
 * source of truth for range; this only rejects the float/negative/NaN
 * class of bug, which is wrong regardless of column width.
 */
export function assertIntegerMinorUnits(value: number, fieldName: string): void {
  if (!Number.isFinite(value)) {
    throw new MoneyInvariantError(`${fieldName} must be a finite number, got ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyInvariantError(
      `${fieldName} must be an integer in minor units (never floating point) — got ${value}`,
    );
  }
  if (value < 0) {
    throw new MoneyInvariantError(`${fieldName} must not be negative — got ${value}`);
  }
}

/** Same as assertIntegerMinorUnits but for a bigint-backed column (volume/GPV/capacity fields — see schema.prisma comment on why those use BigInt, not Int). */
export function assertBigIntMinorUnits(value: bigint, fieldName: string): void {
  if (value < 0n) {
    throw new MoneyInvariantError(`${fieldName} must not be negative — got ${value}`);
  }
}

/**
 * Parses a wire-format numeric string (opportunity.ts/capacity.ts's
 * MinorUnitsStringSchema already constrains it to `/^\d+$/` at the zod
 * layer, so a negative or non-numeric string never reaches this function
 * via the real HTTP path) into a validated bigint, in one step. Added
 * after review (review,
 * 2026-08-18) correctly noted that a bare `BigInt(str)` call with no
 * try/catch would throw an unguarded SyntaxError/RangeError on malformed
 * input instead of this package's own MoneyInvariantError — real defense-
 * in-depth for any FUTURE caller that reaches this code without having
 * gone through the zod-validated HTTP path first (a seed/import job,
 * for instance), matching this file's own "belt and suspenders" stance.
 */
export function parseBigIntMinorUnits(value: string | undefined, fieldName: string): bigint {
  if (value === undefined) return 0n;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new MoneyInvariantError(`${fieldName} must be a non-negative integer string — got "${value}"`);
  }
  assertBigIntMinorUnits(parsed, fieldName);
  return parsed;
}

/**
 * Basis points: integer, 0-10000 for a normal rate (0%-100%), but this
 * function only enforces "non-negative integer" — some fields (e.g. a
 * penalty/cap bps) may legitimately exceed 10000, so the caller passes an
 * explicit `max` when a hard ceiling applies rather than this function
 * assuming one universally.
 */
export function assertIntegerBps(value: number, fieldName: string, max = 1_000_000): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MoneyInvariantError(`${fieldName} must be an integer number of basis points — got ${value}`);
  }
  if (value < 0) {
    throw new MoneyInvariantError(`${fieldName} must not be negative — got ${value}`);
  }
  if (value > max) {
    throw new MoneyInvariantError(`${fieldName} exceeds the allowed maximum of ${max} bps — got ${value}`);
  }
}

/** ISO 4217 three-letter currency code shape check (not a full currency-registry validation — that would need an external list; this only rejects obviously-malformed input). */
export function assertCurrencyCode(value: string, fieldName: string): void {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new MoneyInvariantError(`${fieldName} must be a 3-letter uppercase ISO 4217 code — got "${value}"`);
  }
}
