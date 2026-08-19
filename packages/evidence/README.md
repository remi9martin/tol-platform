# packages/evidence — Provenance, Freshness, Readiness

Provenance, freshness classes (FRESH/AGING/STALE/UNKNOWN) and readiness rules (the spec, p.16) shared by Passport (P6) and Capacity (P8) — both need the same staleness/blocker/warning machinery.

Serves gate(s): P6 Passport, P8 Capacity.

**Status: earlier-stage work — shared vocabulary + config (`src/types.ts`, `src/config.ts`) real; the deterministic engines (`computeReadiness`, `classifyCapacityFreshness`, `classifyFactFreshness`) land in this stage.** See the build log and the gate table at repo root.

Zero runtime dependencies (same discipline as `@tol/domain`/`@tol/authz`/`@tol/crypto`/`@tol/attribution`) — every function this package ever exports is pure and takes an explicit reference time (`now: Date`) rather than reading the clock internally, so `computeReadiness`/`classifyCapacityFreshness` are provably deterministic: same inputs + same reference time → identical output, every time, in any environment.

`src/types.ts` declares its OWN copy of the `FreshnessClass`/`FactProvenance`/`PassportSectionType` vocabulary rather than importing `@tol/domain` at runtime — cross-checked against `@tol/domain/src/passport-states.ts`'s canonical copy by a literal-equality assertion in each package's own test suite (the established `LOCKBOX_SHARE_ROLES`/`DirectnessTier` precedent), not a cross-package import.

Import boundary: consumers import only from this package's public `src/index.ts` via the `@tol/evidence` workspace alias. Deep imports into `@tol/evidence/src/internal/...` are forbidden (the spec).
