# packages/testkit — Fixtures, Factories, Fake Connectors

Fixtures, factories, fake connectors for unit/contract/integration/E2E tests (the spec names 16 fixtures). Reference seed: the prototype's lib/seed.ts *shapes* (not values) — restructure to the new decomposed entities, don't import wholesale.

Serves gate(s): P19 Pilot (cross-cutting: every gate's automated tests draw fixtures from here).

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/testkit` workspace alias. Deep imports into `@tol/testkit/src/internal/...` are forbidden (the spec).
