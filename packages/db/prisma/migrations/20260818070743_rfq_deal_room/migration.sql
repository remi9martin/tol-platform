-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('ACQUIRING', 'PSP_ROUTING', 'BACKUP_PROCESSING');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('DRAFT', 'READINESS_BLOCKED', 'MATCH_READY', 'INVITED', 'QUOTED', 'SELECTED', 'ACTIVATING', 'LIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "FreshnessClass" AS ENUM ('FRESH', 'AGING', 'STALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'SENT', 'ACKNOWLEDGED', 'QUESTIONS', 'QUOTED', 'EXPIRED', 'DECLINED', 'SELECTED');

-- CreateEnum
CREATE TYPE "RfqRecipientState" AS ENUM ('INVITED', 'ACKNOWLEDGED', 'DECLINED', 'QUOTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('SUBMITTED', 'SELECTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DisclosurePacketType" AS ENUM ('MATCH_SUMMARY', 'QUALIFIED_RFQ', 'DUE_DILIGENCE', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "DealRoomStatus" AS ENUM ('OPEN', 'CONDITIONS', 'APPROVED', 'DECLINED', 'ACTIVATION', 'LIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DealParticipantRole" AS ENUM ('MERCHANT', 'PROVIDER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "DealConditionState" AS ENUM ('PENDING', 'SATISFIED', 'WAIVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DealDecisionType" AS ENUM ('QUOTE_SELECTED', 'APPROVAL', 'DECLINE', 'EXCEPTION');

-- CreateTable
CREATE TABLE "opportunities" (
    "id" UUID NOT NULL,
    "owner_org_id" UUID NOT NULL,
    "opportunity_type" "OpportunityType" NOT NULL,
    "requested_service" TEXT NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "total_payment_volume_minor" BIGINT NOT NULL DEFAULT 0,
    "total_card_gpv_minor" BIGINT NOT NULL DEFAULT 0,
    "eligible_card_gpv_minor" BIGINT NOT NULL DEFAULT 0,
    "offered_card_gpv_minor" BIGINT NOT NULL DEFAULT 0,
    "movable_now_minor" BIGINT NOT NULL DEFAULT 0,
    "movable_30d_minor" BIGINT NOT NULL DEFAULT 0,
    "movable_90d_minor" BIGINT NOT NULL DEFAULT 0,
    "jurisdictions" JSONB NOT NULL DEFAULT '[]',
    "mccs" JSONB NOT NULL DEFAULT '[]',
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

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_profiles" (
    "id" UUID NOT NULL,
    "provider_org_id" UUID NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "freshness_class" "FreshnessClass" NOT NULL DEFAULT 'UNKNOWN',
    "accepting_new_volume" BOOLEAN NOT NULL DEFAULT true,
    "jurisdictions" JSONB NOT NULL DEFAULT '[]',
    "mccs_accepted" JSONB NOT NULL DEFAULT '[]',
    "mccs_excluded" JSONB NOT NULL DEFAULT '[]',
    "currency" CHAR(3) NOT NULL,
    "monthly_capacity_minor" BIGINT NOT NULL DEFAULT 0,
    "min_ticket_minor" INTEGER NOT NULL DEFAULT 0,
    "max_ticket_minor" INTEGER NOT NULL DEFAULT 0,
    "max_chargeback_bps" INTEGER NOT NULL DEFAULT 0,
    "max_fraud_bps" INTEGER NOT NULL DEFAULT 0,
    "max_refund_bps" INTEGER NOT NULL DEFAULT 0,
    "settlement_rail" TEXT NOT NULL,
    "settlement_cadence_days" INTEGER NOT NULL DEFAULT 1,
    "commercial_terms" JSONB,
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

    CONSTRAINT "capacity_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "due_at" TIMESTAMP(3) NOT NULL,
    "current_version_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_versions" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "packet_type" "DisclosurePacketType" NOT NULL DEFAULT 'QUALIFIED_RFQ',
    "disclosure_snapshot" JSONB NOT NULL,
    "change_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "rfq_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_recipients" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "provider_org_id" UUID NOT NULL,
    "state" "RfqRecipientState" NOT NULL DEFAULT 'INVITED',
    "acknowledged_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "rfq_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "rfq_recipient_id" UUID NOT NULL,
    "provider_org_id" UUID NOT NULL,
    "quote_version" INTEGER NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'SUBMITTED',
    "valid_until" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terms" JSONB NOT NULL,
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

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_rooms" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "selected_quote_id" UUID NOT NULL,
    "merchant_org_id" UUID NOT NULL,
    "provider_org_id" UUID NOT NULL,
    "status" "DealRoomStatus" NOT NULL DEFAULT 'OPEN',
    "next_action" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "deal_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_room_participants" (
    "id" UUID NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "participant_role" "DealParticipantRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "deal_room_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_conditions" (
    "id" UUID NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "owner_org_id" UUID NOT NULL,
    "evidence_ref" TEXT,
    "due_at" TIMESTAMP(3),
    "state" "DealConditionState" NOT NULL DEFAULT 'PENDING',
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "deal_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_decisions" (
    "id" UUID NOT NULL,
    "deal_room_id" UUID NOT NULL,
    "decision_type" "DealDecisionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "related_quote_id" UUID,
    "comparison_snapshot" JSONB,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_org_id" UUID,
    "actor_role" "PersonaRole",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'DEAL_ROOM',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "deal_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_org_id" UUID,
    "actor_role" "PersonaRole",
    "request_id" TEXT,
    "correlation_id" TEXT,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunities_owner_org_id_idx" ON "opportunities"("owner_org_id");

-- CreateIndex
CREATE INDEX "opportunities_status_idx" ON "opportunities"("status");

-- CreateIndex
CREATE INDEX "capacity_profiles_provider_org_id_idx" ON "capacity_profiles"("provider_org_id");

-- CreateIndex
CREATE INDEX "capacity_profiles_freshness_class_idx" ON "capacity_profiles"("freshness_class");

-- CreateIndex
CREATE INDEX "rfqs_opportunity_id_idx" ON "rfqs"("opportunity_id");

-- CreateIndex
CREATE INDEX "rfqs_status_idx" ON "rfqs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_versions_rfq_id_version_number_key" ON "rfq_versions"("rfq_id", "version_number");

-- CreateIndex
CREATE INDEX "rfq_recipients_provider_org_id_idx" ON "rfq_recipients"("provider_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_recipients_rfq_id_provider_org_id_key" ON "rfq_recipients"("rfq_id", "provider_org_id");

-- CreateIndex
CREATE INDEX "quotes_rfq_id_idx" ON "quotes"("rfq_id");

-- CreateIndex
CREATE INDEX "quotes_provider_org_id_idx" ON "quotes"("provider_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_rfq_recipient_id_quote_version_key" ON "quotes"("rfq_recipient_id", "quote_version");

-- CreateIndex
CREATE UNIQUE INDEX "deal_rooms_rfq_id_key" ON "deal_rooms"("rfq_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_rooms_selected_quote_id_key" ON "deal_rooms"("selected_quote_id");

-- CreateIndex
CREATE INDEX "deal_rooms_merchant_org_id_idx" ON "deal_rooms"("merchant_org_id");

-- CreateIndex
CREATE INDEX "deal_rooms_provider_org_id_idx" ON "deal_rooms"("provider_org_id");

-- CreateIndex
CREATE INDEX "deal_rooms_status_idx" ON "deal_rooms"("status");

-- CreateIndex
CREATE UNIQUE INDEX "deal_room_participants_deal_room_id_organization_id_key" ON "deal_room_participants"("deal_room_id", "organization_id");

-- CreateIndex
CREATE INDEX "deal_conditions_deal_room_id_idx" ON "deal_conditions"("deal_room_id");

-- CreateIndex
CREATE INDEX "deal_decisions_deal_room_id_idx" ON "deal_decisions"("deal_room_id");

-- CreateIndex
CREATE INDEX "domain_events_aggregate_type_aggregate_id_occurred_at_idx" ON "domain_events"("aggregate_type", "aggregate_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_org_id_fkey" FOREIGN KEY ("owner_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_profiles" ADD CONSTRAINT "capacity_profiles_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_versions" ADD CONSTRAINT "rfq_versions_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_recipients" ADD CONSTRAINT "rfq_recipients_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_recipients" ADD CONSTRAINT "rfq_recipients_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rfq_recipient_id_fkey" FOREIGN KEY ("rfq_recipient_id") REFERENCES "rfq_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_rooms" ADD CONSTRAINT "deal_rooms_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_rooms" ADD CONSTRAINT "deal_rooms_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_rooms" ADD CONSTRAINT "deal_rooms_selected_quote_id_fkey" FOREIGN KEY ("selected_quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_rooms" ADD CONSTRAINT "deal_rooms_merchant_org_id_fkey" FOREIGN KEY ("merchant_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_rooms" ADD CONSTRAINT "deal_rooms_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_room_participants" ADD CONSTRAINT "deal_room_participants_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_room_participants" ADD CONSTRAINT "deal_room_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_conditions" ADD CONSTRAINT "deal_conditions_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_conditions" ADD CONSTRAINT "deal_conditions_owner_org_id_fkey" FOREIGN KEY ("owner_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_decisions" ADD CONSTRAINT "deal_decisions_deal_room_id_fkey" FOREIGN KEY ("deal_room_id") REFERENCES "deal_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_decisions" ADD CONSTRAINT "deal_decisions_related_quote_id_fkey" FOREIGN KEY ("related_quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
