-- CreateEnum
CREATE TYPE "DirectnessTier" AS ENUM ('D5', 'D4', 'D3', 'D2', 'D1', 'D0');

-- CreateEnum
CREATE TYPE "ClaimEvidenceType" AS ENUM ('CONTRACT', 'COUNTERPARTY_ACKNOWLEDGMENT', 'EMAIL_THREAD', 'CRM_RECORD', 'OTHER');

-- CreateEnum
CREATE TYPE "EvidenceVerificationState" AS ENUM ('SELF_REPORTED', 'DOCUMENT_EXTRACTED', 'API_VERIFIED', 'COUNTERPARTY_CONFIRMED', 'OPERATOR_VERIFIED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('FILED', 'SCORED', 'VERIFIED', 'PARTIAL', 'DISPUTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ClaimDisputeStatus" AS ENUM ('OPEN', 'DECIDED');

-- CreateEnum
CREATE TYPE "ClaimDisputeResolution" AS ENUM ('UPHELD_ORIGINAL', 'PARTIAL_ATTRIBUTION', 'REJECTED_ORIGINAL');

-- CreateEnum
CREATE TYPE "ClaimDecisionOutcome" AS ENUM ('VERIFIED', 'PARTIAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "ClaimAppealStatus" AS ENUM ('NONE', 'PENDING', 'GRANTED', 'DENIED');

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "claimant_org_id" UUID NOT NULL,
    "claimant_user_id" UUID NOT NULL,
    "subject_org_id" UUID NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "directness_tier" "DirectnessTier" NOT NULL,
    "opportunity_id" UUID,
    "claim_scope" JSONB NOT NULL DEFAULT '{}',
    "status" "ClaimStatus" NOT NULL DEFAULT 'FILED',
    "prior_commercial_history_months" INTEGER NOT NULL DEFAULT 0,
    "submission_lag_days" INTEGER NOT NULL DEFAULT 0,
    "score_breakdown" JSONB,
    "score_total" DOUBLE PRECISION,
    "algorithm_version" TEXT,
    "input_versions" JSONB NOT NULL DEFAULT '[]',
    "scored_at" TIMESTAMP(3),
    "provisional_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'RESTRICTED',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_evidence" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "evidence_type" "ClaimEvidenceType" NOT NULL,
    "asserted_fact" TEXT NOT NULL,
    "verification_state" "EvidenceVerificationState" NOT NULL DEFAULT 'SELF_REPORTED',
    "evidence_ref" TEXT,
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

    CONSTRAINT "claim_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_decisions" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "dispute_id" UUID,
    "decision" "ClaimDecisionOutcome" NOT NULL,
    "score_breakdown" JSONB NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "rule_version" TEXT NOT NULL DEFAULT 'attribution-rules-v1',
    "reviewer_user_id" UUID NOT NULL,
    "reviewer_org_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "appeal_status" "ClaimAppealStatus" NOT NULL DEFAULT 'NONE',
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
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "claim_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_disputes" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "challenger_org_id" UUID NOT NULL,
    "challenger_user_id" UUID NOT NULL,
    "basis" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" "ClaimDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "ClaimDisputeResolution",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'RESTRICTED',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "claim_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claims_claimant_org_id_idx" ON "claims"("claimant_org_id");

-- CreateIndex
CREATE INDEX "claims_subject_org_id_idx" ON "claims"("subject_org_id");

-- CreateIndex
CREATE INDEX "claims_opportunity_id_idx" ON "claims"("opportunity_id");

-- CreateIndex
CREATE INDEX "claims_status_idx" ON "claims"("status");

-- CreateIndex
CREATE INDEX "claim_evidence_claim_id_idx" ON "claim_evidence"("claim_id");

-- CreateIndex
CREATE INDEX "claim_decisions_claim_id_idx" ON "claim_decisions"("claim_id");

-- CreateIndex
CREATE INDEX "claim_decisions_dispute_id_idx" ON "claim_decisions"("dispute_id");

-- CreateIndex
CREATE INDEX "claim_disputes_claim_id_idx" ON "claim_disputes"("claim_id");

-- CreateIndex
CREATE INDEX "claim_disputes_challenger_org_id_idx" ON "claim_disputes"("challenger_org_id");

-- CreateIndex
CREATE INDEX "claim_disputes_status_idx" ON "claim_disputes"("status");

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_claimant_org_id_fkey" FOREIGN KEY ("claimant_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_subject_org_id_fkey" FOREIGN KEY ("subject_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_decisions" ADD CONSTRAINT "claim_decisions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_decisions" ADD CONSTRAINT "claim_decisions_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "claim_disputes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_disputes" ADD CONSTRAINT "claim_disputes_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_disputes" ADD CONSTRAINT "claim_disputes_challenger_org_id_fkey" FOREIGN KEY ("challenger_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
