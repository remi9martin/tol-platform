-- CreateEnum
CREATE TYPE "LockboxStatus" AS ENUM ('DRAFT', 'SEALED', 'COMMITTED', 'FROZEN', 'OPENED', 'MATCH_ELIGIBLE', 'WITHDRAWN', 'DISPUTED');

-- CreateEnum
CREATE TYPE "LockboxRelationshipType" AS ENUM ('ACQUIRER_RELATIONSHIP', 'PROCESSOR_RELATIONSHIP', 'PSP_RELATIONSHIP', 'MERCHANT_RELATIONSHIP', 'BANKING_RELATIONSHIP', 'INFRASTRUCTURE_RELATIONSHIP', 'QUALIFIED_OPPORTUNITY');

-- CreateEnum
CREATE TYPE "LockboxRegion" AS ENUM ('EU', 'UK', 'US', 'LATAM', 'APAC', 'MENA', 'GLOBAL');

-- CreateEnum
CREATE TYPE "LockboxShareRole" AS ENUM ('SEALER', 'OPERATOR', 'ESCROW');

-- CreateTable
CREATE TABLE "lockboxes" (
    "id" UUID NOT NULL,
    "sealer_org_id" UUID NOT NULL,
    "relationship_type" "LockboxRelationshipType" NOT NULL,
    "region" "LockboxRegion" NOT NULL,
    "status" "LockboxStatus" NOT NULL DEFAULT 'SEALED',
    "metadata_summary" TEXT,
    "iv" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "aad" BYTEA,
    "ciphertext_hash" TEXT NOT NULL,
    "sealed_at" TIMESTAMP(3) NOT NULL,
    "withdrawn_at" TIMESTAMP(3),
    "withdrawn_by_user_id" UUID,
    "withdraw_reason" TEXT,
    "recipient_org_id" UUID,
    "released_at" TIMESTAMP(3),
    "condition_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_by_org_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "privacy_class" "DisclosureClass" NOT NULL DEFAULT 'SECRET',
    "source_type" "SourceType" NOT NULL DEFAULT 'PLATFORM',
    "source_reference" TEXT,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "lockboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lockbox_key_shares" (
    "id" UUID NOT NULL,
    "lockbox_id" UUID NOT NULL,
    "holder_role" "LockboxShareRole" NOT NULL,
    "share_index" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "total_shares" INTEGER NOT NULL,
    "wrapped_share" BYTEA,
    "share_iv" BYTEA,
    "share_auth_tag" BYTEA,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyed_at" TIMESTAMP(3),
    "destroyed_reason" TEXT,

    CONSTRAINT "lockbox_key_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lockbox_receipts" (
    "id" UUID NOT NULL,
    "lockbox_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "ciphertext_hash" TEXT NOT NULL,
    "sealer_org_id" UUID NOT NULL,
    "sealed_at" TIMESTAMP(3) NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'HMAC-SHA256',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lockbox_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lockbox_release_evidence" (
    "id" UUID NOT NULL,
    "lockbox_id" UUID NOT NULL,
    "recipient_org_id" UUID NOT NULL,
    "released_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorized_by_user_id" UUID NOT NULL,
    "authorized_roles" TEXT[],
    "condition_ref" TEXT NOT NULL,
    "ciphertext_hash" TEXT NOT NULL,
    "receipt_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lockbox_release_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lockboxes_sealer_org_id_idx" ON "lockboxes"("sealer_org_id");

-- CreateIndex
CREATE INDEX "lockboxes_status_idx" ON "lockboxes"("status");

-- CreateIndex
CREATE INDEX "lockbox_key_shares_lockbox_id_idx" ON "lockbox_key_shares"("lockbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "lockbox_key_shares_lockbox_id_holder_role_key" ON "lockbox_key_shares"("lockbox_id", "holder_role");

-- CreateIndex
CREATE INDEX "lockbox_receipts_lockbox_id_idx" ON "lockbox_receipts"("lockbox_id");

-- CreateIndex
CREATE INDEX "lockbox_release_evidence_lockbox_id_idx" ON "lockbox_release_evidence"("lockbox_id");

-- AddForeignKey
ALTER TABLE "lockboxes" ADD CONSTRAINT "lockboxes_sealer_org_id_fkey" FOREIGN KEY ("sealer_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lockboxes" ADD CONSTRAINT "lockboxes_recipient_org_id_fkey" FOREIGN KEY ("recipient_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lockbox_key_shares" ADD CONSTRAINT "lockbox_key_shares_lockbox_id_fkey" FOREIGN KEY ("lockbox_id") REFERENCES "lockboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lockbox_receipts" ADD CONSTRAINT "lockbox_receipts_lockbox_id_fkey" FOREIGN KEY ("lockbox_id") REFERENCES "lockboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lockbox_release_evidence" ADD CONSTRAINT "lockbox_release_evidence_lockbox_id_fkey" FOREIGN KEY ("lockbox_id") REFERENCES "lockboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lockbox_release_evidence" ADD CONSTRAINT "lockbox_release_evidence_recipient_org_id_fkey" FOREIGN KEY ("recipient_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
