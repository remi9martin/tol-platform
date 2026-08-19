# packages/events — Domain Events + Outbox

Domain event definitions + outbox helpers (the spec names ~24 events, e.g. opportunity.match_ready, lockbox.sealed, commission.accrued). Distinct from AuditEvent — domain events are append-only facts; audit events capture who viewed/changed restricted values.

Serves gate(s): P16 Audit (event trail), P17 Failure (outbox retry/replay).

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/events` workspace alias. Deep imports into `@tol/events/src/internal/...` are forbidden (the spec).
