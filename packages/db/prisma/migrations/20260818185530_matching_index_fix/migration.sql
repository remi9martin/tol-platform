-- DropIndex
DROP INDEX "match_results_opportunity_id_capacity_id_idx";

-- CreateIndex
CREATE INDEX "match_results_opportunity_id_capacity_id_evaluated_at_idx" ON "match_results"("opportunity_id", "capacity_id", "evaluated_at");
