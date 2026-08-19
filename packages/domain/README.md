# packages/domain — Entities, States, Invariants

Entities, states, invariants, domain services. One of the four packages the spec names as the home of business invariants (with matching/attribution/authz) — apps/web renders, apps/api coordinates, this package decides.

Serves gate(s): P3 Data, P6 Passport, P7 Opportunity, P8 Capacity, P13 RFQ, P15 Economics.

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/domain` workspace alias. Deep imports into `@tol/domain/src/internal/...` are forbidden (the spec).
