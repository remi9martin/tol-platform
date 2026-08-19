# ADR-0014: Worker — BullMQ async runtime, packages/queue as the shared contract, worker-level idempotency distinct from HTTP idempotency, and advisory locks propagated to close a real clobber bug real concurrent load surfaced

**Status:** Accepted
**Date:** 2026-08-18/19
**Decision owner:** the build, within the bounds of ADR-0008 part 5
(the two-sided resource pattern), D9 (real crypto, no illustrative shortcuts), and the
earlier build brief's explicit hard constraint: every P17 recovery scenario needs a REAL
test that actually induces the fault, never a happy-path test relabeled as a recovery
proof.

## Context

earlier builds P17 (Failure) — the spec's "Duplicate/timeout/outage/replay tests," the
last gate this build's own scope names directly that requires a real backend to fail
against. No prior day built one: `apps/worker` was an earlier placeholder only. Five
design questions surfaced during the build, none answered directly by the scope doc's
own text:

1. What async job runtime, and how does it get its own job-name/job-data contract
   without either duplicating string literals between `apps/api` and `apps/worker` or
   violating this codebase's own "apps never import another app's `src/`" rule (scope
   p.7).
2. `apps/api`'s own HTTP Idempotency-Key mechanism already exists (earlier). Does a
   background job reuse that exact mechanism, or does BullMQ's own retry semantics
   demand something structurally different.
3. How does an unreachable Redis at enqueue time get handled without ever turning an
   already-correct, already-committed HTTP mutation into a failed response.
4. A parallel concurrency audit (this build agent's review, not this agent's own
   work) flagged that `pg_advisory_xact_lock(hashtext(id))` existed in exactly one place
   in the whole codebase and had never been propagated — and that an earlier new
   worker jobs were about to add MORE concurrent writers into that same unlocked
   territory. Does propagating the lock to four new worker jobs alone close that gap, or
   does it need to reach further.
5. Every sweep-capable job needs a "scan everything, process what qualifies" fallback
   for a dropped or missed event-triggered enqueue. Does building that fallback branch
   inside each job handler satisfy the requirement, or does something also need to
   actually SCHEDULE it.

## Decision

### 1. BullMQ 6.1.2 + ioredis 5.11.1, one queue, a closed-vocabulary job-name contract in a new shared package

BullMQ is the de facto Redis-backed job queue for a Node/TypeScript stack that already
provisions Redis (the docker-compose) — it gives real delayed jobs, retries with
backoff, stalled-job detection, and dead-lettering without reimplementing any of them.
`ioredis@5.11.1` specifically, not the newer `6.0.0` — a stated peer-compatibility
safety choice.

The job-name/job-data contract lives in a NEW package, `packages/queue` — not
`apps/worker`'s own types re-exported, and not `apps/api` reaching into `apps/worker`'s
`src/` (forbidden by this codebase's own convention, the spec: cross-cutting concerns
live in `packages/*`). `WORKER_JOB_NAMES` is a closed, typed array (same discipline
`packages/events`' own `*_EVENT_TYPES` arrays already established) — a typo'd job name
enqueued by `apps/api` is a compile error, not a silent no-op or a real POISON MESSAGE
in production. `apps/worker` was refactored mid-build to consume these shared types
instead of its own local definitions, so there is exactly one source of truth for the
contract, not two that could drift.

### 2. `packages/queue` gives the producer (apps/api) a DELIBERATELY different Redis connection policy than the consumer (apps/worker)

`apps/worker/src/redis.ts` (the consumer) retries forever with backoff — correct for a
long-running process that should keep trying to reconnect indefinitely.
`packages/queue/src/connection.ts` (the producer) fails FAST instead
(`maxRetriesPerRequest:1, connectTimeout:2000`, a bounded 3-attempt `retryStrategy` then
`null`) — a short-lived HTTP request cannot hang waiting on Redis the way a background
process legitimately can. `safeEnqueue()` wraps every producer call and never throws;
every `apps/api` enqueue call happens strictly AFTER its own transaction commits, never
from inside it — an unreachable Redis can neither fail an already-committed mutation's
HTTP response nor extend how long that transaction holds its Postgres locks. Every
enqueued job is additive over an already-existing synchronous path (readiness recompute
on `upsertFact`, the ledger write on `recordRevenueEvent`, etc.), never a replacement —
P6/P8/P13/P15 all stay correct even if `apps/worker` were stopped entirely.

### 3. Worker-level idempotency (`withJobIdempotency`) reuses the `idempotency_keys` table but NOT the HTTP mechanism's reserve-then-run discipline

`apps/api`'s own HTTP Idempotency-Key mechanism (earlier, `shared/idempotency.ts`)
reserves the key BEFORE running the handler, so a concurrent retry sees the reservation
and waits or replays. A BullMQ retry of the SAME job must be able to get PAST a stale
reservation left by a prior attempt that crashed mid-flight — reserving first would
permanently wedge that job's own retries against its own earlier, incomplete
reservation. `withJobIdempotency` (`apps/worker/src/shared/job-idempotency.ts`) instead
checks for a COMPLETED record first (the fast-path replay for a genuinely duplicate or
replayed job), else runs the handler then upserts via reserve+complete with a `P2002`
catch — correct under BullMQ's own retry semantics in a way the HTTP-shaped version
is not.

### 4. Advisory locks propagated to where an earlier new traffic actually creates a race — found real, fixed twice, proven both directions

All four real jobs this stage built (`passport-readiness`, `capacity-freshness`,
`rfq-expiry`, `economics-accrual`) take `pg_advisory_xact_lock(hashtext(id))` before
their first read, per the concurrency audit's own instruction. That alone was not
sufficient: Postgres advisory locks only serialize against OTHER callers of the SAME
lock, never against ordinary unlocked writers — so the worker's own lock was one-sided
unless the `apps/api` code it can race against also took it. an earlier new
end-to-end test (`apps/api/tests/integration/worker-integration.test.ts`) spawns the
REAL, unmodified `apps/worker/src/server.ts` as a genuinely separate OS process and
drives it under real concurrent HTTP load from every other `apps/api` integration test
file running in parallel — not a unit test, not a mock. That real load surfaced a real
bug: a `passport-readiness` worker job racing a human reviewer's `verify()` call could
silently clobber a correct `VERIFIED` status back down to a stale computed value. Fixed
by propagating the identical lock to `apps/api/src/modules/passport/service.ts`'s
`upsertFact()` and `verify()` (NOT to `create()` — safe by construction, since nothing
can reference an uncommitted new passport's id before its own transaction commits — and
NOT to `addEvidence()`, which never writes `.status`).

A second, subtler half of the identical bug class was then caught in review
review: the GET-triggered staleness auto-transition
(`loadDetailWithStalenessCheck`) re-read the passport's STATUS fresh inside the lock,
but still judged staleness against a `ReadinessResult.computedAt` snapshot read BEFORE
the lock — so a concurrent recompute landing a fresh, non-stale `ReadinessResult` in
that exact window could still get judged stale against the superseded value and
clobbered. Fixed by re-reading the `ReadinessResult` fresh too, inside the same lock,
and — critically — proven in both directions rather than assumed correct: a dedicated,
deterministic concurrency test (a manually-held transaction committing a real,
`computeReadiness`-derived fresh result during a controlled delay, forcing the exact
race window) was confirmed to fail red against the pre-fix code (`git stash push` the
fix alone, re-run, `expected 'STALE' not to be 'STALE'`, 13/14 sibling tests still
green) before the fix was restored and confirmed to pass 14/14.

`economics/service.ts`'s `adjustLedger` has the identical missing-lock shape, confirmed
real by an automated review (the (removed) review script) against this day's own diff.
Deliberately NOT fixed in this build: it is pre-existing earlier code no earlier worker job
actually touches (the `economics-accrual` job only ever locks on `revenueEventId`,
never `accrualRootId`), and the same concurrency audit that started this whole thread
already named it as part of a separate clean-window pass across
Lockbox/economics-payments/deal/rfq — fixing it piecemeal here would have been scope
creep into someone else's already-planned pass, not a genuine gap left uncaught.

### 5. Scheduled sweeps — a job handler's own fallback branch is not the same thing as a schedule that actually invokes it, and the gap was closed the same day it was found

Every sweep-capable job (`passport-readiness`, `capacity-freshness`, `rfq-expiry`) has
had a working no-id "scan everything, process what qualifies" branch since this stage. The
SAME review that found the `adjustLedger` gap also found that nothing had ever
registered any of these three on an actual recurring schedule — a dropped enqueue
during a Redis blip had nothing to catch it later. Unlike `adjustLedger`, this was
judged genuinely quick to close at the source rather than deferred: `apps/worker/src/
sweeps.ts` registers all three as real BullMQ 6.1.2 Job Schedulers
(`queue.upsertJobScheduler` — this version's current, non-deprecated recurring-job API;
confirmed against the installed package's own type definitions AND a live registration
against real Redis, after the `.d.ts`'s documented `id` field turned out not to be what
gets populated at runtime — the real matching field is `.key`, found by directly
inspecting a live `getJobSchedulers()` response). `rfq-expiry` sweeps every 5 minutes (a
missed `dueAt` is more immediately user-visible); `passport-readiness`/
`capacity-freshness` every 15 minutes (their own on-read checks, P6/P8, already DONE
since earlier, remain the correctness source for any human-facing view regardless of this
schedule's cadence — the sweep only closes the gap for records nobody is actively
viewing). `economics-accrual` is deliberately excluded — the spec names its trigger as
always specific to one `revenueEventId`, never bulk-swept — proven by a dedicated
negative test rather than a silent omission. Registration itself is proven against the
real Job Scheduler query API (`queue.getJobSchedulers()`), not just each handler's
sweep-branch logic in isolation, and proven idempotent across repeated calls (exactly
what happens on every real worker restart).

### 6. Named, not built this pass

`evidence-expiry`, `match-recompute`, `notification-dispatch`, `outbox-publish`, a
dedicated `audit-seal` job (job-lifecycle auditing itself IS built, reusing
`AuditEvent` directly), `connector-poll` (blocked on `packages/connectors`, itself
still an unbuilt earlier placeholder), `analytics-rollup`. None of these were named as
required by this day's own build instructions; each is a real, scope-visible job the
four this day actually built do not cover.

## Consequences

- P17 is DONE with seven individually real, genuinely fault-injected tests — a live
  `SIGKILL` on a separate OS process reclaimed via BullMQ's real stalled-job detection,
  a real `ioredis` connection severed mid-flight and reconnected via the app's own
  `retryStrategy`, a real unreachable Postgres detected in ~2 seconds, a real BullMQ
  job-timeout race resolved by idempotent replay, a real corrupted Lockbox key share
  failing release cleanly with zero plaintext leak anywhere — plus an eighth,
  additional poison-message hardening case. Never a happy-path test relabeled as a
  recovery proof.
- The worker layer is additive by construction over every prior day's already-DONE
  synchronous path — P6/P8/P13/P15 all remain correct even if `apps/worker` were
  stopped entirely, proven by the fact none of their own existing test suites needed to
  change to accommodate the worker's existence (only the new event-triggered enqueue
  call sites were added).
- Two real concurrency bugs this day's own new traffic exposed are fixed and proven in
  both directions, not merely reasoned about — a discipline this ADR's own consequence
  is worth naming explicitly, since the FIRST fix (the worker-side lock alone) still
  left a real, exploitable gap that only real concurrent load, not code review alone,
  actually surfaced.
- A third instance of the identical bug class (`adjustLedger`) is named and correctly
  deferred to review's own already-planned clean-window pass, not silently
  carried or scope-crept into this build.
- The reconciliation-sweep gap the same review found is closed same-day, with
  its own dedicated proof against the real scheduling API — not left as a second open
  item alongside the deliberately-deferred `adjustLedger` gap.
- Gates affected: **P17 — Failure** (DONE this day). Also touches **P6 — Passport**,
  **P8 — Capacity**, **P13 — RFQ**, **P15 — Economics** (each already DONE; earlier adds
  real, additive worker automation on top, none re-opened or downgraded) and **P16 —
  Audit** (every real job now writes its own `AuditEvent` + `DomainEvent`, the first
  machine- rather than human-triggered evidence trail).
