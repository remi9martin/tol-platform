-- CreateEnum
CREATE TYPE "PassportStatus" AS ENUM ('DRAFT', 'INCOMPLETE', 'READY', 'VERIFIED', 'STALE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PassportSectionType" AS ENUM ('IDENTITY', 'RELATIONSHIP_HISTORY', 'PROCESSING_METRICS', 'RISK', 'COMMERCIAL', 'TECHNICAL');

-- CreateEnum
CREATE TYPE "FactProvenance" AS ENUM ('SELF_REPORTED', 'DOCUMENT_EXTRACTED', 'API_VERIFIED', 'COUNTERPARTY_CONFIRMED', 'OPERATOR_VERIFIED', 'OUTCOME_LEARNED', 'INFERRED');

-- CreateEnum
CREATE TYPE "EvidenceSourceKind" AS ENUM ('FILE', 'API', 'ATTESTATION');

-- CreateTable
CREATE TABLE "passports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "PassportStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'MEMBER_MARKET',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "passports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facts" (
    "id" UUID NOT NULL,
    "passport_id" UUID NOT NULL,
    "section_type" "PassportSectionType" NOT NULL,
    "field_key" TEXT NOT NULL,
    "normalized_value" JSONB NOT NULL,
    "verification" "FactProvenance" NOT NULL DEFAULT 'SELF_REPORTED',
    "evidence_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'MEMBER_MARKET',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "passport_id" UUID NOT NULL,
    "type" "EvidenceSourceKind" NOT NULL,
    "object_ref" TEXT NOT NULL,
    "checksum" TEXT,
    "issuer" TEXT,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
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

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_results" (
    "id" UUID NOT NULL,
    "passport_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "rule_version" TEXT NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "input_versions" JSONB NOT NULL DEFAULT '[]',
    "computed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'MEMBER_MARKET',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "readiness_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volume_slices" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "jurisdiction" CHAR(2) NOT NULL,
    "mcc" TEXT NOT NULL,
    "card_origin" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "period" TEXT NOT NULL,
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

    CONSTRAINT "volume_slices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "passports_organization_id_key" ON "passports"("organization_id");

-- CreateIndex
CREATE INDEX "facts_passport_id_section_type_idx" ON "facts"("passport_id", "section_type");

-- CreateIndex
CREATE UNIQUE INDEX "facts_passport_id_field_key_key" ON "facts"("passport_id", "field_key");

-- CreateIndex
CREATE INDEX "evidence_passport_id_idx" ON "evidence"("passport_id");

-- CreateIndex
CREATE INDEX "readiness_results_passport_id_computed_at_idx" ON "readiness_results"("passport_id", "computed_at");

-- CreateIndex
CREATE INDEX "volume_slices_opportunity_id_idx" ON "volume_slices"("opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "volume_slices_opportunity_id_jurisdiction_mcc_card_origin_c_key" ON "volume_slices"("opportunity_id", "jurisdiction", "mcc", "card_origin", "channel", "period");

-- AddForeignKey
ALTER TABLE "passports" ADD CONSTRAINT "passports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "passports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "passports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_results" ADD CONSTRAINT "readiness_results_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "passports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volume_slices" ADD CONSTRAINT "volume_slices_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
