# .github/workflows — CI Pipelines

Six named workflows per the spec: `ci.yml`, `integration.yml`, `e2e.yml`,
`security.yml`, `migration-check.yml`, `release.yml`.

Serves gate: P18 Security (scans), and indirectly every gate once tests exist for it to
run in CI.

**Status: three of the six now exist as real, authored workflow files:**

| Workflow | Status |
|---|---|
| `ci.yml` | **Live** — typecheck/build/test against a real Postgres service container |
| `security.yml` | **Live** — gitleaks secret scan (blocking), `pnpm audit` (blocking) |
| `migration-check.yml` | **Live** — `prisma migrate diff` drift check |
| `integration.yml` | Still deferred — no separate integration-test script exists yet distinct from `ci.yml`'s `pnpm -w run test` |
| `e2e.yml` | Still deferred — no e2e test suite/tooling exists yet |
| `release.yml` | Still deferred — no release/publish process defined yet |

**Authored, not yet exercised:** there is no GitHub remote configured for this repo
yet. All three live workflows were written against this repo's real root
scripts, real env-var contract, and real file layout — not templated — but none has
ever run on an actual GitHub-hosted runner. See
[`../../docs/security/README.md`](../../docs/security/README.md) for the full
"CI is authored, not yet exercised" writeup, including which action-version pins to
re-verify before the first real run.

The original reasoning for the previously-empty three still applies to them:
wiring real CI before there is any code/test/build script for it to run is dead
scaffolding. `ci.yml`/`security.yml`/`migration-check.yml` graduated out of that state
because `apps/*`/`packages/*` now have real lint/build/test surfaces for them
to run against; the remaining three stay deferred until their own prerequisites
(a distinct integration-test script, an e2e suite, a release process) exist.
