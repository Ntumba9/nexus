import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createOutboundWebhookSchema,
  createRuleSchema,
  listNotificationsQuerySchema,
  pageQuerySchema,
  setRuleEnabledSchema,
  updateRuleSchema,
  type AutomationRuleDto,
  type CreateOutboundWebhookInput,
  type CreateRuleInput,
  type CreatedOutboundWebhookDto,
  type ExecutionPageDto,
  type ListNotificationsQuery,
  type NotificationPageDto,
  type OutboundWebhookDto,
  type PageQuery,
  type SetRuleEnabledInput,
  type UpdateRuleInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { AutomationRulesService } from './automation-rules.service';
import { NotificationsService } from './notifications.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

const idPipe = new UuidParamPipe();

@ApiTags('automation')
@Controller('orgs/:orgId')
export class AutomationController {
  constructor(
    @Inject(AutomationRulesService) private readonly rules: AutomationRulesService,
    @Inject(OutboundWebhooksService) private readonly webhooks: OutboundWebhooksService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ---- Rules (administrators) ----------------------------------------------------------------

  @RequirePermission('automation.manage')
  @Get('automation/rules')
  @ApiOperation({ summary: 'Automation rules, with the outcome of each one’s latest run' })
  async listRules(@Req() request: AppRequest): Promise<{ data: AutomationRuleDto[] }> {
    return { data: await this.rules.list(tenantOf(request)) };
  }

  @RequirePermission('automation.manage')
  @Post('automation/rules')
  @ApiOperation({ summary: 'Create a rule: a trigger, conditions and typed actions' })
  createRule(
    @Body(new ZodValidationPipe(createRuleSchema)) body: CreateRuleInput,
    @Req() request: AppRequest,
  ): Promise<AutomationRuleDto> {
    return this.rules.create(tenantOf(request), request.id, body);
  }

  @RequirePermission('automation.manage')
  @Get('automation/rules/:ruleId')
  getRule(
    @Param('ruleId', idPipe) ruleId: string,
    @Req() request: AppRequest,
  ): Promise<AutomationRuleDto> {
    return this.rules.get(tenantOf(request), ruleId);
  }

  @RequirePermission('automation.manage')
  @Put('automation/rules/:ruleId')
  @ApiOperation({ summary: 'Replace a rule’s definition' })
  updateRule(
    @Param('ruleId', idPipe) ruleId: string,
    @Body(new ZodValidationPipe(updateRuleSchema)) body: UpdateRuleInput,
    @Req() request: AppRequest,
  ): Promise<AutomationRuleDto> {
    return this.rules.update(tenantOf(request), request.id, ruleId, body);
  }

  @RequirePermission('automation.manage')
  @Patch('automation/rules/:ruleId')
  @ApiOperation({ summary: 'Turn a rule on or off' })
  setEnabled(
    @Param('ruleId', idPipe) ruleId: string,
    @Body(new ZodValidationPipe(setRuleEnabledSchema)) body: SetRuleEnabledInput,
    @Req() request: AppRequest,
  ): Promise<AutomationRuleDto> {
    return this.rules.setEnabled(tenantOf(request), request.id, ruleId, body.enabled);
  }

  @RequirePermission('automation.manage')
  @Delete('automation/rules/:ruleId')
  @HttpCode(204)
  async deleteRule(
    @Param('ruleId', idPipe) ruleId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    await this.rules.remove(tenantOf(request), request.id, ruleId);
  }

  @RequirePermission('automation.manage')
  @Get('automation/rules/:ruleId/executions')
  @ApiOperation({ summary: 'What a rule did: one entry per event it matched, newest first' })
  executions(
    @Param('ruleId', idPipe) ruleId: string,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery,
    @Req() request: AppRequest,
  ): Promise<ExecutionPageDto> {
    return this.rules.executions(tenantOf(request), ruleId, query);
  }

  // ---- Outbound webhook destinations ---------------------------------------------------------

  @RequirePermission('automation.manage')
  @Get('outbound-webhooks')
  @ApiOperation({ summary: 'Webhook destinations (never their secrets)' })
  async listWebhooks(@Req() request: AppRequest): Promise<{ data: OutboundWebhookDto[] }> {
    return { data: await this.webhooks.list(tenantOf(request)) };
  }

  @RequirePermission('integrations.manage')
  @Post('outbound-webhooks')
  @ApiOperation({ summary: 'Add a destination. The signing secret is returned once.' })
  createWebhook(
    @Body(new ZodValidationPipe(createOutboundWebhookSchema)) body: CreateOutboundWebhookInput,
    @Req() request: AppRequest,
  ): Promise<CreatedOutboundWebhookDto> {
    return this.webhooks.create(tenantOf(request), request.id, body);
  }

  @RequirePermission('integrations.manage')
  @Delete('outbound-webhooks/:webhookId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disable a destination' })
  async disableWebhook(
    @Param('webhookId', idPipe) webhookId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    await this.webhooks.disable(tenantOf(request), request.id, webhookId);
  }

  // ---- The signed-in user's own notifications (every member) ---------------------------------

  @RequirePermission('organization.read')
  @Get('notifications')
  @ApiOperation({ summary: 'My in-app notifications, newest first' })
  listNotifications(
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
    @Req() request: AppRequest,
  ): Promise<NotificationPageDto> {
    return this.notifications.list(tenantOf(request), query);
  }

  @RequirePermission('organization.read')
  @Get('notifications/unread-count')
  async unreadCount(@Req() request: AppRequest): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(tenantOf(request)) };
  }

  @RequirePermission('organization.read')
  @Post('notifications/read-all')
  @HttpCode(200)
  readAll(@Req() request: AppRequest): Promise<{ updated: number }> {
    return this.notifications.markAllRead(tenantOf(request));
  }

  @RequirePermission('organization.read')
  @Post('notifications/:notificationId/read')
  @HttpCode(204)
  async markRead(
    @Param('notificationId', idPipe) notificationId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    await this.notifications.markRead(tenantOf(request), notificationId);
  }
}
