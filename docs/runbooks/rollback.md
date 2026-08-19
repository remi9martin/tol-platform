# Rollback Runbook

**Status: SKELETON — completed at pilot/release.** No deploy has ever happened (see `deploy.md`), so no rollback has ever been performed or rehearsed. The structure below names the real considerations this repo's own migration/versioning discipline already creates; the exact commands are not yet written because there is no orchestration layer to write them against.

## Scope

Undoing a bad deploy of `apps/web`/`apps/api`/`apps/worker` application code, and the harder, related question of what a forward-only database migration means for rolling the database back too. Does not cover the six scope-named incident runbooks (`RUN-001` through `RUN-006` — see `docs/runbooks/README.md`); this file is about undoing *our own* bad release, not responding to an external failure.

## Trigger conditions (when this runbook applies)

- A newly-deployed version fails its post-deploy health gate (`/healthz`/`/readyz` — see `deploy.md`).
- A newly-deployed version passes health checks but a real regression surfaces shortly after (the pattern this repo's own live-browser testing has repeatedly caught things automated tests missed — see the build log's earlier through earlier sections for real examples of exactly this class of bug).
- A gate previously marked DONE in the gate table is found to be silently broken in the deployed environment.

## The core complication: forward-only migrations

the spec requires migrations to be "forward-only, reviewed and backed by restore/rollback procedure." Forward-only means **you cannot simply run a migration backward** the way you can revert an application binary to a prior image. This repo's own migration history (`packages/db/prisma/migrations/`) is six sequential, additive migrations (earlier through earlier) — none of them have ever been designed with a corresponding "down" migration. That has two real consequences a rollback procedure must actually resolve, not gloss over:

1. **Application rollback alone is safe only if the prior application version is still compatible with the current (newer) database schema.** Additive migrations (a new table, a new nullable column) are usually safe to roll the app back under. A migration that renames or drops a column the prior app version still reads or writes is **not** safe to roll back under without a compensating fix.
2. **A genuinely bad migration** (data corruption, a constraint that blocks legitimate writes) needs either a new **forward** migration that repairs the damage, or a full database restore from backup (see the future `RUN-003-db-restore.md`) — not a "rollback" in the application-deploy sense.

Whoever completes this runbook must classify, per migration going forward, whether it is rollback-safe (additive) or rollback-risky (destructive/renaming) — a classification this repo does not currently track anywhere. That tracking should probably live next to the migration itself or in this file's real version, not be reconstructed from memory during an actual incident.

## Planned rollback sequence (structure only)

1. **Decide the target.** Roll back to the immediately-prior known-good version, not an arbitrary older one — compounding version gaps compounds the schema-compatibility question in the section above.
2. **Application rollback.** the spec's target: "rollback to prior image is one command/workflow." Depends on the same container/orchestration layer `deploy.md` notes doesn't exist yet.
3. **Database decision.** Using the classification above: if every migration since the target version is additive, no database action is needed. If any is not, a compensating forward migration must be written and applied — never a manual, undocumented hand-edit of production data.
4. **Re-verify.** Re-run `/healthz`/`/readyz` and the relevant the test evidence walkthroughs against the rolled-back environment before declaring the incident closed.
5. **Postmortem.** Every rollback gets a postmortem — what triggered it, what the migration-compatibility classification turned out to be, and whether this file's own procedure needs correcting based on what actually happened (matching this repo's own "correct forward, don't silently edit past entries" convention already used in `DECISIONS.md`).

## Owner / sign-off (to be assigned)

No rollback has ever been performed, so no rollback owner has been named. Assign this before the first real deploy — not after the first incident.
