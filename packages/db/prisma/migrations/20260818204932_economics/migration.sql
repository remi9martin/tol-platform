-- CreateEnum
CREATE TYPE "CommissionBasis" AS ENUM ('GROSS_PROCESSING_VOLUME', 'NET_PLATFORM_REVENUE', 'RECEIVED_COMMISSION', 'FIXED_FEE', 'SETUP_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "CommissionScheduleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "CommissionRecipientType" AS ENUM ('CONTRIBUTOR', 'PLATFORM', 'OTHER');

-- CreateEnum
CREATE TYPE "CommissionComponentType" AS ENUM ('PERCENTAGE_BPS', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ACCRUAL', 'ADJUSTMENT', 'PAYMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "commission_schedules" (
    "id" UUID NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "schedule_family_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "previous_version_id" UUID,
    "basis" "CommissionBasis" NOT NULL,
    "status" "CommissionScheduleStatus" NOT NULL DEFAULT 'DRAFT',
    "cap_minor" BIGINT,
    "floor_minor" BIGINT,
    "survival_months" INTEGER,
    "description" TEXT,
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

    CONSTRAINT "commission_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_components" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "recipient_type" "CommissionRecipientType" NOT NULL,
    "recipient_org_id" UUID NOT NULL,
    "component_type" "CommissionComponentType" NOT NULL,
    "bps" INTEGER,
    "fixed_amount_minor" BIGINT,
    "calculation_basis" "CommissionBasis",
    "priority" INTEGER NOT NULL,
    "claim_id" UUID,
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

    CONSTRAINT "commission_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_events" (
    "id" UUID NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "basis" "CommissionBasis" NOT NULL,
    "period" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "deductions_minor" BIGINT NOT NULL DEFAULT 0,
    "net_distributable_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "recognized_at" TIMESTAMP(3) NOT NULL,
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

    CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_accruals" (
    "id" UUID NOT NULL,
    "accrual_root_id" UUID NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "revenue_event_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "schedule_version" INTEGER NOT NULL,
    "component_id" UUID NOT NULL,
    "recipient_org_id" UUID NOT NULL,
    "claim_id" UUID,
    "payment_id" UUID,
    "reason" TEXT,
    "approver_user_id" UUID,
    "approver_org_id" UUID,
    "calculation_version" TEXT NOT NULL,
    "input_versions" JSONB NOT NULL DEFAULT '[]',
    "computed_at" TIMESTAMP(3) NOT NULL,
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

    CONSTRAINT "commission_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_payments" (
    "id" UUID NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "recipient_org_id" UUID NOT NULL,
    "total_amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
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

    CONSTRAINT "commission_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commission_schedules_deal_room_id_idx" ON "commission_schedules"("deal_room_id");

-- CreateIndex
CREATE INDEX "commission_schedules_schedule_family_id_idx" ON "commission_schedules"("schedule_family_id");

-- CreateIndex
CREATE INDEX "commission_schedules_deal_room_id_status_idx" ON "commission_schedules"("deal_room_id", "status");

-- CreateIndex
CREATE INDEX "commission_components_schedule_id_idx" ON "commission_components"("schedule_id");

-- CreateIndex
CREATE INDEX "commission_components_recipient_org_id_idx" ON "commission_components"("recipient_org_id");

-- CreateIndex
CREATE INDEX "commission_components_claim_id_idx" ON "commission_components"("claim_id");

-- CreateIndex
CREATE INDEX "revenue_events_deal_room_id_idx" ON "revenue_events"("deal_room_id");

-- CreateIndex
CREATE INDEX "revenue_events_schedule_id_idx" ON "revenue_events"("schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_events_deal_room_id_period_source_key" ON "revenue_events"("deal_room_id", "period", "source");

-- CreateIndex
CREATE INDEX "commission_accruals_accrual_root_id_idx" ON "commission_accruals"("accrual_root_id");

-- CreateIndex
CREATE INDEX "commission_accruals_deal_room_id_idx" ON "commission_accruals"("deal_room_id");

-- CreateIndex
CREATE INDEX "commission_accruals_revenue_event_id_idx" ON "commission_accruals"("revenue_event_id");

-- CreateIndex
CREATE INDEX "commission_accruals_recipient_org_id_idx" ON "commission_accruals"("recipient_org_id");

-- CreateIndex
CREATE INDEX "commission_accruals_schedule_id_idx" ON "commission_accruals"("schedule_id");

-- CreateIndex
CREATE INDEX "commission_accruals_payment_id_idx" ON "commission_accruals"("payment_id");

-- CreateIndex
CREATE INDEX "commission_payments_deal_room_id_idx" ON "commission_payments"("deal_room_id");

-- CreateIndex
CREATE INDEX "commission_payments_recipient_org_id_idx" ON "commission_payments"("recipient_org_id");

-- AddForeignKey
ALTER TABLE "commission_schedules" ADD CONSTRAINT "commission_schedules_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_schedules" ADD CONSTRAINT "commission_schedules_previous_version_id_fkey" FOREIGN KEY ("previous_version_id") REFERENCES "commission_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_components" ADD CONSTRAINT "commission_components_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "commission_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_components" ADD CONSTRAINT "commission_components_recipient_org_id_fkey" FOREIGN KEY ("recipient_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_components" ADD CONSTRAINT "commission_components_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "commission_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_revenue_event_id_fkey" FOREIGN KEY ("revenue_event_id") REFERENCES "revenue_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "commission_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "commission_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_recipient_org_id_fkey" FOREIGN KEY ("recipient_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "commission_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_payments" ADD CONSTRAINT "commission_payments_recipient_org_id_fkey" FOREIGN KEY ("recipient_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
