-- Day-7 fix: CommissionAccrual.entryType was missing its @map("entry_type")
-- directive when the day7_economics migration was first generated —
-- every other multi-word field in this schema is snake_case-mapped;
-- this one column was an oversight, caught by direct psql \d inspection
-- immediately after the original migration + seed ran. A rename, not a
-- drop/add, so the 3 rows already seeded (real data from a real
-- computeCommissionSplits() run) are preserved rather than lost.
ALTER TABLE "commission_accruals" RENAME COLUMN "entryType" TO "entry_type";
