# docs/security — Security Posture

Gate: **P18 Security** (the gate table's exit condition: "Authz/redaction/secret scans + threat review"). This page is the one-page index; the real analysis lives in [`threat-model.md`](./threat-model.md).

Previously this file was an earlier stub ("empty — populated starting when packages/authz and packages/crypto land"). Both packages have since landed with real implementations and real tests — this is that population pass.

## What exists today

| Piece | File | Status |
|---|---|---|
| Threat model (STRIDE, real code citations) | [`threat-model.md`](./threat-model.md) | New this pass |
| CI: typecheck/build/test on every push+PR | [`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | New this pass — **authored, not yet exercised** (see below) |
| Security scans: secrets, dependency audit | [`../../.github/workflows/security.yml`](../../.github/workflows/security.yml) | New this pass — **authored, not yet exercised** |
| Migration drift check | [`../../.github/workflows/migration-check.yml`](../../.github/workflows/migration-check.yml) | New this pass — **authored, not yet exercised** |
| Secret-scan config | [`../../.gitleaks.toml`](../../.gitleaks.toml) | New this pass |
| Authz/redaction test coverage (predates this pass) | `packages/authz/src/*.test.ts` (`can.test.ts`, `matrix.test.ts`, `field-policy.test.ts`, `roles.consistency.test.ts`) | Already existed; runs under `ci.yml`'s `pnpm -w run test` |

## CI is authored, not yet exercised

**There is no GitHub remote configured for this repo as of this pass.** All three workflows above were written against this repo's *real* root scripts (`package.json`), *real* env-var contract (`.env.example`, `packages/config/src/env.ts`), and *real* file layout — not templated from a generic example — but none of them have ever run on an actual GitHub-hosted runner. Concretely:

- Action versions (`actions/checkout@v5`, `actions/setup-node@v6`, `pnpm/action-setup@v4`, `gitleaks/gitleaks-action@v3`) were verified via live search at authoring time (2026-08-18), not from training-data memory — this repo was authored during GitHub's Node 20→Node 24 runner migration, a period of unusually fast version churn on the Actions marketplace. **Re-check for a newer major the first time any of these workflows actually runs**, rather than trusting the pin indefinitely.
- `security.yml`'s `gitleaks` job needs a `GITLEAKS_LICENSE` repo secret **only if** this repo is ever moved under a GitHub Organization account — a personal-account repo doesn't need one.
- The four `LOCKBOX_KEK_*`/`SESSION_SECRET`-shaped values hardcoded in `ci.yml` are deliberate CI-only dummy values (see that file's own header comment), allowlisted by exact value in `.gitleaks.toml` so the secret scanner doesn't flag its own CI config.

None of this is a defect — it's the honest state of "written correctly against the real repo, never fired." Whoever wires up the first remote push should watch the first run of each workflow closely rather than assume green-on-paper means green-in-practice.

## How the pieces fit together

```
push / PR
  ├─ ci.yml              → typecheck, build, test (real Postgres service container)
  ├─ security.yml
  │    ├─ gitleaks job          → secret scan, BLOCKS merge on a finding
  │    └─ dependency-audit job  → `pnpm audit --audit-level=high`, blocks on high/critical
  └─ migration-check.yml  → prisma migrate diff, fails on schema/migration drift

weekly (Monday 06:00 UTC)
  └─ security.yml re-runs on schedule → catches newly-disclosed CVEs in unchanged deps
```

`ci.yml`'s own test run already covers the "authz/redaction" half of P18's exit condition — `packages/authz`'s test suite (deny-by-default `can()`, the field-policy/`DisclosureClass` ladder, role-matrix exhaustiveness) runs there, not in a separate security-specific job. `security.yml` covers "secret scans." `threat-model.md` is the "threat review." Together these three satisfy P18's stated exit condition; the gate table's own P18 row should move from NOT STARTED once this lands and (per that row's owning-paths list) the referenced `.github/workflows` stop being "(deferred)."

## Residual risk list (see `threat-model.md` §5 for full detail)

Ordered by how prominently `threat-model.md` treats them, not by a formal severity score:

1. Lockbox `OPERATOR`+`ESCROW` KEKs co-located in one process — the platform's flagship confidentiality mechanism's cryptography is real; its operational key-custody separation isn't, yet (ADR-0009's own flagged gap).
2. No view-time audit trail — only mutations are audited today.
3. `lockbox.release` has no stricter rate-limit tier despite scope naming it alongside auth.
4. Lockbox release's `conditionRef` isn't yet cross-checked against a live `DealCondition` row.
5. No MFA enrollment/challenge flow despite a ready schema field (`User.mfaEnabled`).
6. KMS is an explicit, documented stand-in (raw hex in process env) — not a production key-custody solution.
7. TLS-termination and reverse-proxy trust boundary is assumed, not implemented or reviewed in this codebase.

This pass does not fix any of the above — it documents them, and stands up the CI/scan scaffolding so future fixes have somewhere to land and get checked automatically. Fixing application code is out of scope for a docs-and-CI-only pass; see whoever owns `apps/api`/`packages/*` next.
