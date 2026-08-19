# packages/observability — Logging, Tracing, Metrics

Structured JSON logging, tracing, metrics (the spec). Feeds health/readiness endpoints and alerting. Redaction is mandatory — no sensitive payloads in logs or error tracking (unit-tested, per the spec).

Serves gate(s): P16 Audit, P17 Failure, P18 Security.

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/observability` workspace alias. Deep imports into `@tol/observability/src/internal/...` are forbidden (the spec).
