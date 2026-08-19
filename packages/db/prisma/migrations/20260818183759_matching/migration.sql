-- CreateTable
CREATE TABLE "match_results" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "capacity_id" UUID NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "eligibility_results" JSONB NOT NULL,
    "rule_version" TEXT NOT NULL,
    "ranking_breakdown" JSONB,
    "rank" INTEGER,
    "total_score" DOUBLE PRECISION,
    "algorithm_version" TEXT,
    "input_versions" JSONB NOT NULL DEFAULT '[]',
    "evaluated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'RESTRICTED',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "match_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_results_opportunity_id_evaluated_at_idx" ON "match_results"("opportunity_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "match_results_opportunity_id_capacity_id_idx" ON "match_results"("opportunity_id", "capacity_id");

-- CreateIndex
CREATE INDEX "match_results_opportunity_id_eligible_rank_idx" ON "match_results"("opportunity_id", "eligible", "rank");

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_capacity_id_fkey" FOREIGN KEY ("capacity_id") REFERENCES "capacity_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
