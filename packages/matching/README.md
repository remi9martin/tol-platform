# packages/matching — Eligibility + Ranking Engine

Eligibility (hard-rule determinism, the spec) then ranking (explainable, versioned factors, the spec). One of the four business-invariant packages named on the spec. Deterministic-only for MVP (see ADR-0004).

Serves gate(s): P11 Eligibility, P12 Ranking.

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/matching` workspace alias. Deep imports into `@tol/matching/src/internal/...` are forbidden (the spec).
