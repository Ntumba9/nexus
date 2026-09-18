-- CreateEnum
CREATE TYPE "ServiceEnvironment" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT');

-- CreateEnum
CREATE TYPE "ServiceHealth" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'MITIGATED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncidentSource" AS ENUM ('MANUAL', 'MONITORING', 'AUTOMATION', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "IncidentEventType" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'COMMENT_ADDED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AUTOMATION', 'AI');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "incidentCounter" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "environment" "ServiceEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "healthStatus" "ServiceHealth" NOT NULL DEFAULT 'UNKNOWN',
    "description" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "serviceId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "source" "IncidentSource" NOT NULL DEFAULT 'MANUAL',
    "createdById" UUID,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "mitigatedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "type" "IncidentEventType" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentComment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assignedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMPTZ(6),

    CONSTRAINT "IncidentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentTag" (
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "IncidentTag_pkey" PRIMARY KEY ("incidentId","tag")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_slug_key" ON "Project"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_id_key" ON "Project"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Service_organizationId_projectId_idx" ON "Service"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_organizationId_id_key" ON "Service"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Service_organizationId_projectId_name_environment_key" ON "Service"("organizationId", "projectId", "name", "environment");

-- CreateIndex
CREATE INDEX "Incident_organizationId_status_severity_idx" ON "Incident"("organizationId", "status", "severity");

-- CreateIndex
CREATE INDEX "Incident_organizationId_createdAt_idx" ON "Incident"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Incident_organizationId_serviceId_idx" ON "Incident"("organizationId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_organizationId_number_key" ON "Incident"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_organizationId_id_key" ON "Incident"("organizationId", "id");

-- CreateIndex
CREATE INDEX "IncidentEvent_incidentId_createdAt_idx" ON "IncidentEvent"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentEvent_organizationId_createdAt_idx" ON "IncidentEvent"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "IncidentComment_incidentId_createdAt_idx" ON "IncidentComment"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentAssignment_incidentId_idx" ON "IncidentAssignment"("incidentId");

-- CreateIndex
CREATE INDEX "IncidentAssignment_userId_idx" ON "IncidentAssignment"("userId");

-- CreateIndex
CREATE INDEX "IncidentTag_organizationId_tag_idx" ON "IncidentTag"("organizationId", "tag");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_organizationId_incidentId_fkey" FOREIGN KEY ("organizationId", "incidentId") REFERENCES "Incident"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentComment" ADD CONSTRAINT "IncidentComment_organizationId_incidentId_fkey" FOREIGN KEY ("organizationId", "incidentId") REFERENCES "Incident"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentComment" ADD CONSTRAINT "IncidentComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAssignment" ADD CONSTRAINT "IncidentAssignment_organizationId_incidentId_fkey" FOREIGN KEY ("organizationId", "incidentId") REFERENCES "Incident"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentAssignment" ADD CONSTRAINT "IncidentAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAssignment" ADD CONSTRAINT "IncidentAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentTag" ADD CONSTRAINT "IncidentTag_organizationId_incidentId_fkey" FOREIGN KEY ("organizationId", "incidentId") REFERENCES "Incident"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------
-- Data-integrity rules Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 100),
  ADD CONSTRAINT "Project_slug_format_check"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 63),
  ADD CONSTRAINT "Project_description_length_check" CHECK (char_length("description") <= 1000);

ALTER TABLE "Service"
  ADD CONSTRAINT "Service_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 100),
  ADD CONSTRAINT "Service_description_length_check" CHECK (char_length("description") <= 1000);

ALTER TABLE "Incident"
  ADD CONSTRAINT "Incident_number_positive_check" CHECK ("number" > 0),
  ADD CONSTRAINT "Incident_title_length_check" CHECK (char_length("title") BETWEEN 1 AND 200),
  ADD CONSTRAINT "Incident_description_length_check" CHECK (char_length("description") <= 10000),
  -- Lifecycle timestamps must agree with the status: an incident is RESOLVED exactly when it has a
  -- resolvedAt, and CANCELLED exactly when it has a cancelledAt.
  ADD CONSTRAINT "Incident_resolved_consistency_check"
    CHECK (("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)),
  ADD CONSTRAINT "Incident_cancelled_consistency_check"
    CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

ALTER TABLE "IncidentComment"
  ADD CONSTRAINT "IncidentComment_body_length_check" CHECK (char_length("body") BETWEEN 1 AND 5000);

ALTER TABLE "IncidentTag"
  ADD CONSTRAINT "IncidentTag_format_check" CHECK ("tag" ~ '^[a-z0-9][a-z0-9-]{0,29}$');

-- A user can hold at most one ACTIVE assignment per incident (history rows keep unassignedAt set).
CREATE UNIQUE INDEX "IncidentAssignment_active_unique"
  ON "IncidentAssignment" ("incidentId", "userId")
  WHERE "unassignedAt" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- The incident timeline is append-only. Enforced in the database so that no application bug,
-- script or console session can rewrite history.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION nexus_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IncidentEvent_no_update_delete"
  BEFORE UPDATE OR DELETE ON "IncidentEvent"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();

CREATE TRIGGER "IncidentEvent_no_truncate"
  BEFORE TRUNCATE ON "IncidentEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
