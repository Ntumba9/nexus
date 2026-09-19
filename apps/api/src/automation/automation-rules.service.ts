import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@nexus/database';
import {
  AUTOMATION_LIMITS,
  actionResultListSchema,
  automationActionListSchema,
  conditionListSchema,
  type AutomationExecutionDto,
  type AutomationRuleDto,
  type AutomationTrigger,
  type CreateRuleInput,
  type ExecutionPageDto,
  type ExecutionStatus,
  type PageQuery,
  type SkipReason,
} from '@nexus/shared';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';

const ruleSelect = {
  id: true,
  name: true,
  trigger: true,
  conditions: true,
  actions: true,
  enabled: true,
  cooldownSeconds: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AutomationRuleSelect;

type RuleRow = Prisma.AutomationRuleGetPayload<{ select: typeof ruleSelect }>;

function toRuleDto(
  row: RuleRow,
  last: { status: string; createdAt: Date } | undefined,
): AutomationRuleDto {
  // Rules are validated on every write, so this only falls back for a row edited by hand.
  const conditions = conditionListSchema.safeParse(row.conditions);
  const actions = automationActionListSchema.safeParse(row.actions);
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger as AutomationTrigger,
    conditions: conditions.success ? conditions.data : [],
    actions: actions.success ? actions.data : [],
    enabled: row.enabled,
    cooldownSeconds: row.cooldownSeconds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastExecutionAt: last?.createdAt.toISOString() ?? null,
    lastExecutionStatus: (last?.status as ExecutionStatus | undefined) ?? null,
  };
}

/** What an audit entry says about a rule: its shape, never more than that. */
const summary = (rule: {
  name: string;
  trigger: string;
  enabled: boolean;
  actions: readonly { type: string }[];
}) => ({
  name: rule.name,
  trigger: rule.trigger,
  enabled: rule.enabled,
  actions: rule.actions.map((action) => action.type),
});

@Injectable()
export class AutomationRulesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext): Promise<AutomationRuleDto[]> {
    const rules = await this.prisma.automationRule.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      select: ruleSelect,
    });
    if (rules.length === 0) return [];
    // The newest execution of each rule, in one query.
    const latest = await this.prisma.automationExecution.findMany({
      where: { organizationId: tenant.organizationId, ruleId: { in: rules.map((r) => r.id) } },
      distinct: ['ruleId'],
      orderBy: [{ ruleId: 'asc' }, { createdAt: 'desc' }],
      select: { ruleId: true, status: true, createdAt: true },
    });
    const byRule = new Map(latest.map((e) => [e.ruleId, e]));
    return rules.map((rule) => toRuleDto(rule, byRule.get(rule.id)));
  }

  async get(tenant: TenantContext, id: string): Promise<AutomationRuleDto> {
    const row = await this.prisma.automationRule.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: ruleSelect,
    });
    if (!row) throw ApiError.notFound('Rule not found');
    const last = await this.prisma.automationExecution.findFirst({
      where: { organizationId: tenant.organizationId, ruleId: id },
      orderBy: { createdAt: 'desc' },
      select: { status: true, createdAt: true },
    });
    return toRuleDto(row, last ?? undefined);
  }

  async create(
    tenant: TenantContext,
    requestId: string | undefined,
    input: CreateRuleInput,
  ): Promise<AutomationRuleDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      // Serialise creation per organization so the limit cannot be beaten by two requests at once.
      await tx.$executeRaw`SELECT 1 FROM "Organization" WHERE "id" = ${tenant.organizationId}::uuid FOR UPDATE`;
      const count = await tx.automationRule.count({
        where: { organizationId: tenant.organizationId },
      });
      if (count >= AUTOMATION_LIMITS.maxRulesPerOrganization) {
        throw ApiError.conflict(
          'RULE_LIMIT',
          `An organization can have at most ${AUTOMATION_LIMITS.maxRulesPerOrganization} automation rules`,
        );
      }
      await this.checkReferences(tx, tenant.organizationId, input);
      const created = await tx.automationRule.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name,
          trigger: input.trigger,
          conditions: input.conditions as Prisma.InputJsonValue,
          actions: input.actions as Prisma.InputJsonValue,
          enabled: input.enabled,
          cooldownSeconds: input.cooldownSeconds,
          createdById: tenant.userId,
        },
        select: ruleSelect,
      });
      await this.audit.record(tx, tenant, requestId, {
        action: 'automation.rule.created',
        resourceType: 'automation_rule',
        resourceId: created.id,
        metadata: summary(input),
      });
      return created;
    });
    return toRuleDto(row, undefined);
  }

  /** Replaces the whole definition (a rule is small), validated exactly like a new one. */
  async update(
    tenant: TenantContext,
    requestId: string | undefined,
    id: string,
    input: CreateRuleInput,
  ): Promise<AutomationRuleDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.automationRule.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { id: true, enabled: true },
      });
      if (!existing) throw ApiError.notFound('Rule not found');
      await this.checkReferences(tx, tenant.organizationId, input);
      const updated = await tx.automationRule.update({
        where: { id },
        data: {
          name: input.name,
          trigger: input.trigger,
          conditions: input.conditions as Prisma.InputJsonValue,
          actions: input.actions as Prisma.InputJsonValue,
          enabled: input.enabled,
          cooldownSeconds: input.cooldownSeconds,
        },
        select: ruleSelect,
      });
      await this.audit.record(tx, tenant, requestId, {
        action: 'automation.rule.updated',
        resourceType: 'automation_rule',
        resourceId: id,
        metadata: { ...summary(input), wasEnabled: existing.enabled },
      });
      return updated;
    });
    return this.get(tenant, row.id);
  }

  async setEnabled(
    tenant: TenantContext,
    requestId: string | undefined,
    id: string,
    enabled: boolean,
  ): Promise<AutomationRuleDto> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.automationRule.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { name: true, trigger: true, enabled: true, actions: true },
      });
      if (!existing) throw ApiError.notFound('Rule not found');
      if (existing.enabled === enabled) return; // already so: nothing changes, nothing to audit
      await tx.automationRule.updateMany({
        where: { id, organizationId: tenant.organizationId },
        data: { enabled },
      });
      await this.audit.record(tx, tenant, requestId, {
        action: enabled ? 'automation.rule.enabled' : 'automation.rule.disabled',
        resourceType: 'automation_rule',
        resourceId: id,
        metadata: { name: existing.name, trigger: existing.trigger },
      });
    });
    return this.get(tenant, id);
  }

  async remove(tenant: TenantContext, requestId: string | undefined, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.automationRule.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { name: true, trigger: true },
      });
      if (!existing) throw ApiError.notFound('Rule not found');
      // Its execution history goes with it; the audit entry below is the permanent record.
      await tx.automationRule.deleteMany({ where: { id, organizationId: tenant.organizationId } });
      await this.audit.record(tx, tenant, requestId, {
        action: 'automation.rule.deleted',
        resourceType: 'automation_rule',
        resourceId: id,
        metadata: { name: existing.name, trigger: existing.trigger },
      });
    });
  }

  async executions(
    tenant: TenantContext,
    ruleId: string,
    query: PageQuery,
  ): Promise<ExecutionPageDto> {
    const rule = await this.prisma.automationRule.findFirst({
      where: { id: ruleId, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!rule) throw ApiError.notFound('Rule not found');
    const rows = await this.prisma.automationExecution.findMany({
      where: {
        organizationId: tenant.organizationId,
        ruleId,
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        ruleId: true,
        eventType: true,
        status: true,
        skipReason: true,
        results: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    });
    const data: AutomationExecutionDto[] = rows.slice(0, query.limit).map((row) => {
      const results = actionResultListSchema.safeParse(row.results);
      return {
        id: row.id,
        ruleId: row.ruleId,
        eventType: row.eventType as AutomationTrigger,
        status: row.status,
        skipReason: (row.skipReason as SkipReason | null) ?? null,
        results: results.success ? results.data : [],
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
    return {
      data,
      nextBefore: rows.length > query.limit ? (data.at(-1)?.createdAt ?? null) : null,
    };
  }

  /**
   * Things a rule points at must exist in THIS organization: webhook destinations (and be enabled)
   * and people to notify (and still be members). They are checked again when the rule runs, because
   * the world changes; this catches mistakes early and refuses another tenant's ids outright.
   */
  private async checkReferences(
    tx: Prisma.TransactionClient,
    organizationId: string,
    input: CreateRuleInput,
  ): Promise<void> {
    const issues: { path: string; message: string }[] = [];

    const destinations = input.actions.flatMap((action, index) =>
      action.type === 'webhook' ? [{ id: action.destinationId, index }] : [],
    );
    if (destinations.length > 0) {
      const found = await tx.outboundWebhook.findMany({
        where: { organizationId, enabled: true, id: { in: destinations.map((d) => d.id) } },
        select: { id: true },
      });
      const known = new Set(found.map((d) => d.id));
      for (const destination of destinations) {
        if (!known.has(destination.id)) {
          issues.push({
            path: `actions.${destination.index}.destinationId`,
            message: 'choose one of your organization’s enabled webhooks',
          });
        }
      }
    }

    const wanted = input.actions.flatMap((action, index) =>
      action.type === 'notify'
        ? action.recipients.userIds.map((userId) => ({ userId, index }))
        : [],
    );
    if (wanted.length > 0) {
      const members = await tx.organizationMember.findMany({
        where: { organizationId, userId: { in: wanted.map((w) => w.userId) } },
        select: { userId: true },
      });
      const isMember = new Set(members.map((m) => m.userId));
      for (const w of wanted) {
        if (!isMember.has(w.userId)) {
          issues.push({
            path: `actions.${w.index}.recipients.userIds`,
            message: 'every person must be a member of this organization',
          });
        }
      }
    }

    if (issues.length > 0) throw ApiError.validation(issues);
  }
}
