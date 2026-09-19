import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  listAuditLogsQuerySchema,
  type AuditLogPageDto,
  type ListAuditLogsQuery,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('orgs/:orgId/audit-logs')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @RequirePermission('audit.read')
  @Get()
  @ApiOperation({ summary: 'The audit log, newest first (read-only: it is append-only)' })
  list(
    @Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery,
    @Req() request: AppRequest,
  ): Promise<AuditLogPageDto> {
    if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
    return this.audit.list(request.tenant, query);
  }
}
