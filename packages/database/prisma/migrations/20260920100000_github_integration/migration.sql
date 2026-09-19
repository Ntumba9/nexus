-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DeploymentRelation" AS ENUM ('SUSPECTED', 'CONFIRMED');

-- AlterEnum
ALTER TYPE "IncidentEventType" ADD VALUE 'DEPLOYMENT_LINKED';

-- CreateTable
CREATE TABLE "GitHubIntegration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "serviceId" UUID,
    "repoFullName" TEXT NOT NULL,
    "webhookSecretEncrypted" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastEventAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GitHubIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "serviceId" UUID,
    "integrationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL,
    "author" TEXT,
    "description" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "deployedAt" TIMESTAMPTZ(6),
    "statusUpdatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentDeployment" (
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "relation" "DeploymentRelation" NOT NULL,
    "linkedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentDeployment_pkey" PRIMARY KEY ("incidentId","deploymentId")
);

-- CreateIndex
CREATE INDEX "GitHubIntegration_organizationId_projectId_idx" ON "GitHubIntegration"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubIntegration_organizationId_id_key" ON "GitHubIntegration"("organizationId", "id");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_integrationId_deliveryId_key" ON "WebhookEvent"("integrationId", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_organizationId_id_key" ON "WebhookEvent"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Deployment_organizationId_startedAt_idx" ON "Deployment"("organizationId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Deployment_organizationId_serviceId_deployedAt_idx" ON "Deployment"("organizationId", "serviceId", "deployedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_integrationId_externalId_key" ON "Deployment"("integrationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_organizationId_id_key" ON "Deployment"("organizationId", "id");

-- CreateIndex
CREATE INDEX "IncidentDeployment_deploymentId_idx" ON "IncidentDeployment"("deploymentId");

-- AddForeignKey
ALTER TABLE "GitHubIntegration" ADD CONSTRAINT "GitHubIntegration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubIntegration" ADD CONSTRAINT "GitHubIntegration_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GitHubIntegration" ADD CONSTRAINT "GitHubIntegration_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "GitHubIntegration"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "GitHubIntegration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentDeployment" ADD CONSTRAINT "IncidentDeployment_organizationId_incidentId_fkey" FOREIGN KEY ("organizationId", "incidentId") REFERENCES "Incident"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentDeployment" ADD CONSTRAINT "IncidentDeployment_organizationId_deploymentId_fkey" FOREIGN KEY ("organizationId", "deploymentId") REFERENCES "Deployment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentDeployment" ADD CONSTRAINT "IncidentDeployment_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Data-integrity rules Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

-- One ACTIVE integration per repository per organisation. A disabled integration frees the name.
CREATE UNIQUE INDEX "GitHubIntegration_active_repo_key"
  ON "GitHubIntegration" ("organizationId", lower("repoFullName"))
  WHERE "status" = 'ACTIVE';

ALTER TABLE "GitHubIntegration"
  ADD CONSTRAINT "GitHubIntegration_repo_format_check"
    CHECK ("repoFullName" ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  ADD CONSTRAINT "GitHubIntegration_secret_present_check"
    CHECK (char_length("webhookSecretEncrypted") > 0);

ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_delivery_id_check" CHECK (char_length("deliveryId") BETWEEN 1 AND 100),
  ADD CONSTRAINT "WebhookEvent_event_type_check" CHECK (char_length("eventType") BETWEEN 1 AND 100);

ALTER TABLE "Deployment"
  ADD CONSTRAINT "Deployment_commit_sha_check" CHECK ("commitSha" ~ '^[0-9a-f]{7,64}$'),
  ADD CONSTRAINT "Deployment_text_length_check" CHECK (
    char_length("externalId") BETWEEN 1 AND 100
    AND char_length("environment") BETWEEN 1 AND 100
    AND char_length("ref") BETWEEN 1 AND 250
  );
