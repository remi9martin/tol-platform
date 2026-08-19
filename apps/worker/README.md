# apps/worker — Async Jobs

BullMQ/Redis job runner. Keeps expensive, retryable and time-based work out of request handlers (the spec).

Status: the runtime skeleton is real — a BullMQ `Worker` connected to a real Redis (via `@tol/config`'s typed env, fails loud at boot if `REDIS_URL` is missing), job dispatch by name through a small registry (`src/jobs/registry.ts`), a per-attempt timeout wrapper distinct from BullMQ's own stalled-job detection (`src/worker-runtime.ts`), a startup/readiness consistency gate that checks both DB and Redis before job processing begins (`src/startup-check.ts`, the spec's recovery scenario #5), a small Fastify health/ready/status HTTP surface (`src/health.ts`, port `WORKER_PORT`/`workerHealthPort`, default 18500), graceful SIGTERM/SIGINT shutdown, and job-lifecycle audit writes reusing `@tol/db`'s existing `AuditEvent` table (P16). One smoke-test job (`worker.ping`) proves the whole pipeline end to end against real Redis. See the test-evidence record for p17-failure and ADR-0014 for the design record.

Real jobs (`passport-readiness`, `capacity-freshness`, `rfq-expiry`, `economics-accrual`) and the P17 failure-recovery test suite land alongside the runtime skeleton — see the build log's current-status entry, not this file (this file describes structure, not progress history).

Named-but-unbuilt jobs from the scope's own job table/file tree — a real, acknowledged gap, not silently dropped: `evidence-expiry`, `match-recompute`, `notification-dispatch`, `outbox-publish`, `audit-seal` (as a dedicated job — job-lifecycle auditing itself IS built, reusing `AuditEvent` directly), `connector-poll` (blocked on `packages/connectors`, itself still an unbuilt placeholder), `analytics-rollup`.

Serves gate(s): P6 Passport (readiness job), P8 Capacity (freshness job), P13 RFQ (expiry), P15 Economics (accrual), P16 Audit (worker/job actions audited), P17 Failure (this app's entire reason to exist).
