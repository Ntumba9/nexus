-- CreateEnum
CREATE TYPE "MonitoringCheckType" AS ENUM ('HTTP');

-- CreateEnum
CREATE TYPE "CheckResultStatus" AS ENUM ('UP', 'DOWN');

-- AlterEnum
ALTER TYPE "IncidentEventType" ADD VALUE 'MONITORING_SIGNAL';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "healthChangedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "MonitoringCheck" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "MonitoringCheckType" NOT NULL DEFAULT 'HTTP',
    "url" TEXT NOT NULL,
    "expectedStatus" INTEGER NOT NULL DEFAULT 200,
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "recoveryThreshold" INTEGER NOT NULL DEFAULT 2,
    "incidentSeverity" "IncidentSeverity" NOT NULL DEFAULT 'SEV2',
    "createIncidents" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "healthStatus" "ServiceHealth" NOT NULL DEFAULT 'UNKNOWN',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMPTZ(6),
    "nextRunAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MonitoringCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringResult" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "status" "CheckResultStatus" NOT NULL,
    "statusCode" INTEGER,
    "responseTimeMs" INTEGER,
    "failureReason" TEXT,
    "scheduledFor" TIMESTAMPTZ(6) NOT NULL,
    "checkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitoringCheck_enabled_nextRunAt_idx" ON "MonitoringCheck"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "MonitoringCheck_organizationId_serviceId_idx" ON "MonitoringCheck"("organizationId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringCheck_organizationId_id_key" ON "MonitoringCheck"("organizationId", "id");

-- CreateIndex
CREATE INDEX "MonitoringResult_checkId_checkedAt_idx" ON "MonitoringResult"("checkId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "MonitoringResult_checkedAt_idx" ON "MonitoringResult"("checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringResult_checkId_scheduledFor_key" ON "MonitoringResult"("checkId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "MonitoringCheck" ADD CONSTRAINT "MonitoringCheck_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringCheck" ADD CONSTRAINT "MonitoringCheck_organizationId_serviceId_fkey" FOREIGN KEY ("organizationId", "serviceId") REFERENCES "Service"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MonitoringResult" ADD CONSTRAINT "MonitoringResult_organizationId_checkId_fkey" FOREIGN KEY ("organizationId", "checkId") REFERENCES "MonitoringCheck"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------
-- Data-integrity rules Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "MonitoringCheck"
  ADD CONSTRAINT "MonitoringCheck_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 60),
  ADD CONSTRAINT "MonitoringCheck_url_length_check" CHECK (char_length("url") BETWEEN 1 AND 2048),
  ADD CONSTRAINT "MonitoringCheck_url_scheme_check" CHECK ("url" ~* '^https?://'),
  ADD CONSTRAINT "MonitoringCheck_expectedStatus_check" CHECK ("expectedStatus" BETWEEN 100 AND 599),
  ADD CONSTRAINT "MonitoringCheck_timeoutMs_check" CHECK ("timeoutMs" BETWEEN 100 AND 30000),
  ADD CONSTRAINT "MonitoringCheck_intervalSeconds_check" CHECK ("intervalSeconds" BETWEEN 15 AND 86400),
  ADD CONSTRAINT "MonitoringCheck_failureThreshold_check" CHECK ("failureThreshold" BETWEEN 1 AND 20),
  ADD CONSTRAINT "MonitoringCheck_recoveryThreshold_check" CHECK ("recoveryThreshold" BETWEEN 1 AND 20),
  ADD CONSTRAINT "MonitoringCheck_counters_check" CHECK ("consecutiveFailures" >= 0 AND "consecutiveSuccesses" >= 0),
  -- A check may have a verdict of UNKNOWN, HEALTHY or DOWN (DEGRADED is reserved for later).
  ADD CONSTRAINT "MonitoringCheck_healthStatus_check" CHECK ("healthStatus" IN ('UNKNOWN', 'HEALTHY', 'DOWN'));

ALTER TABLE "MonitoringResult"
  ADD CONSTRAINT "MonitoringResult_statusCode_check" CHECK ("statusCode" IS NULL OR "statusCode" BETWEEN 100 AND 599),
  ADD CONSTRAINT "MonitoringResult_responseTime_check" CHECK ("responseTimeMs" IS NULL OR "responseTimeMs" >= 0),
  -- A passing result carries no failure reason; a failing one must explain itself.
  ADD CONSTRAINT "MonitoringResult_reason_consistency_check"
    CHECK (("status" = 'DOWN') = ("failureReason" IS NOT NULL));

-- An incident created by monitoring must name the service it is about, and a service can have at
-- most ONE active monitoring incident at a time. Two workers (or a retried job) racing to open an
-- incident for the same outage therefore cannot both succeed.
ALTER TABLE "Incident"
  ADD CONSTRAINT "Incident_monitoring_has_service_check"
    CHECK ("source" <> 'MONITORING' OR "serviceId" IS NOT NULL);

CREATE UNIQUE INDEX "Incident_one_active_monitoring_per_service"
  ON "Incident" ("serviceId")
  WHERE "source" = 'MONITORING' AND "status" NOT IN ('RESOLVED', 'CANCELLED');
