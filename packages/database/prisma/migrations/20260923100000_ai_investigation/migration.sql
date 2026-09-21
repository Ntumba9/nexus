-- AlterEnum
ALTER TYPE "IncidentEventType" ADD VALUE IF NOT EXISTS 'AI_INVESTIGATED';

-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "AiInvestigation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "requestedById" UUID,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'QUEUED',
    "question" TEXT,
    "providerId" TEXT NOT NULL,
    "providerLabel" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '[]',
    "output" JSONB,
    "droppedCitations" INTEGER NOT NULL DEFAULT 0,
    "droppedClaims" INTEGER NOT NULL DEFAULT 0,
    "downgradedCauses" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AiInvestigation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiInvestigation_organizationId_id_key" ON "AiInvestigation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AiInvestigation_organizationId_incidentId_createdAt_idx" ON "AiInvestigation"("organizationId", "incidentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: an investigation can only belong to an incident of its OWN organization.
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_organizationId_incidentId_fkey" FOREIGN KEY ("organizationId", "incidentId") REFERENCES "Incident"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most ONE investigation per incident can be queued or running. This is what stops two clicks
-- (or two API instances) from starting two model calls for the same incident. Partial, so Prisma
-- ignores it and `migrate dev` never tries to drop it.
CREATE UNIQUE INDEX "AiInvestigation_one_active_per_incident_idx"
  ON "AiInvestigation" ("incidentId") WHERE "status" IN ('QUEUED', 'RUNNING');

-- Constraints Prisma cannot express.
-- A successful investigation always has an answer; a failed or unfinished one never does.
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_output_check"
  CHECK (("status" = 'SUCCEEDED') = ("output" IS NOT NULL));
-- finishedAt is set exactly when the investigation is over.
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_finished_check"
  CHECK (("status" IN ('SUCCEEDED', 'FAILED')) = ("finishedAt" IS NOT NULL));
-- A reason exists only for a failure, and it is short.
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_error_check"
  CHECK ("error" IS NULL OR ("status" = 'FAILED' AND char_length("error") <= 300));
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_question_check"
  CHECK ("question" IS NULL OR char_length("question") <= 500);
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_counts_check"
  CHECK ("droppedCitations" >= 0 AND "droppedClaims" >= 0 AND "downgradedCauses" >= 0 AND "attempts" >= 0);
