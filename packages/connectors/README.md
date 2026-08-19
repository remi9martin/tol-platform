# packages/connectors — Provider Adapter SDK

ProviderConnector interface SDK + implementations (the spec). MVP scope is deliberately narrow: one fake + one representative real/sandbox adapter (the spec, 'deliberately deferred'). No dedicated P-gate; supports Opportunity intake (P7) and Capacity (P8) evidence feeds, and the Pilot (P19) end-to-end loop.

Serves: cross-cutting infrastructure, no single dedicated gate.

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/connectors` workspace alias. Deep imports into `@tol/connectors/src/internal/...` are forbidden (the spec).
