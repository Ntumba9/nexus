-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "IncidentEventType" ADD VALUE IF NOT EXISTS 'AUTOMATION_EXECUTED';

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subjectId" UUID,
    "facts" JSONB NOT NULL,
    "causedByExecutionId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 300,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationExecution" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "subjectId" UUID,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "results" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "readAt" TIMESTAMPTZ(6),
    "executionId" UUID,
    "actionIndex" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundWebhook" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OutboundWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DomainEvent_occurredAt_idx" ON "DomainEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEvent_organizationId_id_key" ON "DomainEvent"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AutomationRule_organizationId_trigger_enabled_idx" ON "AutomationRule"("organizationId", "trigger", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_organizationId_id_key" ON "AutomationRule"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AutomationExecution_organizationId_ruleId_createdAt_idx" ON "AutomationExecution"("organizationId", "ruleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationExecution_status_createdAt_idx" ON "AutomationExecution"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationExecution_ruleId_eventId_key" ON "AutomationExecution"("ruleId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationExecution_organizationId_id_key" ON "AutomationExecution"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Notification_organizationId_userId_readAt_createdAt_idx" ON "Notification"("organizationId", "userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_executionId_actionIndex_userId_key" ON "Notification"("executionId", "actionIndex", "userId");

-- CreateIndex
CREATE INDEX "OutboundWebhook_organizationId_enabled_idx" ON "OutboundWebhook"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundWebhook_organizationId_id_key" ON "OutboundWebhook"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_action_idx" ON "AuditLog"("organizationId", "action");

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_organizationId_ruleId_fkey" FOREIGN KEY ("organizationId", "ruleId") REFERENCES "AutomationRule"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "DomainEvent"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "OrganizationMember"("organizationId", "userId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------------------------
-- Data-integrity rules Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

-- Trigger names are text, shared with the application (see @nexus/shared AUTOMATION_TRIGGERS);
-- these constraints keep every column that holds one to the same closed set.
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_type_check" CHECK ("type" IN (
  'incident.created', 'incident.status_changed', 'incident.severity_changed', 'incident.assigned',
  'service.health_changed', 'deployment.succeeded', 'deployment.failed'));
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_trigger_check" CHECK ("trigger" IN (
  'incident.created', 'incident.status_changed', 'incident.severity_changed', 'incident.assigned',
  'service.health_changed', 'deployment.succeeded', 'deployment.failed'));
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_event_type_check" CHECK ("eventType" IN (
  'incident.created', 'incident.status_changed', 'incident.severity_changed', 'incident.assigned',
  'service.health_changed', 'deployment.succeeded', 'deployment.failed'));
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_type_check" CHECK ("type" IN (
  'incident.created', 'incident.status_changed', 'incident.severity_changed', 'incident.assigned',
  'service.health_changed', 'deployment.succeeded', 'deployment.failed'));

-- The dispatcher only ever looks at events that are still to do; keep that scan tiny.
CREATE INDEX "DomainEvent_undispatched_idx" ON "DomainEvent" ("occurredAt") WHERE "dispatchedAt" IS NULL;
CREATE INDEX "DomainEvent_dispatchedAt_idx" ON "DomainEvent" ("dispatchedAt") WHERE "dispatchedAt" IS NOT NULL;

ALTER TABLE "DomainEvent"
  ADD CONSTRAINT "DomainEvent_facts_object_check" CHECK (jsonb_typeof("facts") = 'object');

ALTER TABLE "AutomationRule"
  ADD CONSTRAINT "AutomationRule_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "AutomationRule_cooldown_check" CHECK ("cooldownSeconds" BETWEEN 0 AND 86400),
  ADD CONSTRAINT "AutomationRule_conditions_check" CHECK (
    jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 10
  ),
  ADD CONSTRAINT "AutomationRule_actions_check" CHECK (
    jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5
  );

ALTER TABLE "AutomationExecution"
  ADD CONSTRAINT "AutomationExecution_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "AutomationExecution_results_check" CHECK (jsonb_typeof("results") = 'array'),
  -- A skip reason only makes sense for a skipped execution.
  ADD CONSTRAINT "AutomationExecution_skip_reason_check" CHECK ("skipReason" IS NULL OR "status" = 'SKIPPED');

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_title_length_check" CHECK (char_length("title") BETWEEN 1 AND 160),
  ADD CONSTRAINT "Notification_body_length_check" CHECK (char_length("body") <= 1000),
  -- Links are in-app paths built from ids by the server, never arbitrary URLs.
  ADD CONSTRAINT "Notification_link_check" CHECK ("link" IS NULL OR "link" ~ '^/orgs/[0-9a-f-]{36}(/[A-Za-z0-9/_-]*)?$');

ALTER TABLE "OutboundWebhook"
  ADD CONSTRAINT "OutboundWebhook_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 60),
  ADD CONSTRAINT "OutboundWebhook_url_check" CHECK (char_length("url") <= 2048 AND "url" ~* '^https?://'),
  ADD CONSTRAINT "OutboundWebhook_secret_present_check" CHECK (char_length("secretEncrypted") > 0);

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_action_length_check" CHECK (char_length("action") BETWEEN 1 AND 100),
  ADD CONSTRAINT "AuditLog_resource_type_length_check" CHECK (char_length("resourceType") BETWEEN 1 AND 60),
  ADD CONSTRAINT "AuditLog_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object');

-- The audit log is append-only. Enforced in the database (using the same function as the incident
-- timeline) so that no application bug, script or console session can rewrite history.
CREATE TRIGGER "AuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();

CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
