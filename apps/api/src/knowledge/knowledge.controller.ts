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
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createKnowledgeDocumentSchema,
  listKnowledgeQuerySchema,
  searchKnowledgeQuerySchema,
  updateKnowledgeDocumentSchema,
  type CreateKnowledgeDocumentInput,
  type KnowledgeDocumentDto,
  type KnowledgeDocumentSummaryDto,
  type KnowledgeSearchResultDto,
  type ListKnowledgeQuery,
  type SearchKnowledgeQuery,
  type UpdateKnowledgeDocumentInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { KnowledgeService } from './knowledge.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

const idPipe = new UuidParamPipe();

@ApiTags('knowledge')
@Controller('orgs/:orgId/knowledge')
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @RequirePermission('knowledge.read')
  @Get()
  @ApiOperation({ summary: 'List knowledge documents' })
  async list(
    @Query(new ZodValidationPipe(listKnowledgeQuerySchema)) query: ListKnowledgeQuery,
    @Req() request: AppRequest,
  ): Promise<{ data: KnowledgeDocumentSummaryDto[] }> {
    return { data: await this.knowledge.list(tenantOf(request), query) };
  }

  // Static routes come before `:documentId` so "search" is never read as an id.
  @RequirePermission('knowledge.read')
  @Get('search')
  @ApiOperation({ summary: 'Search the knowledge base (keyword and meaning-based)' })
  search(
    @Query(new ZodValidationPipe(searchKnowledgeQuerySchema)) query: SearchKnowledgeQuery,
    @Req() request: AppRequest,
  ): Promise<KnowledgeSearchResultDto> {
    return this.knowledge.search(tenantOf(request), query.q, query.limit);
  }

  @RequirePermission('knowledge.read')
  @Get('for-incident/:incidentId')
  @ApiOperation({ summary: 'Runbooks that look relevant to an incident' })
  forIncident(
    @Param('incidentId', idPipe) incidentId: string,
    @Req() request: AppRequest,
  ): Promise<KnowledgeSearchResultDto> {
    return this.knowledge.forIncident(tenantOf(request), incidentId, 5);
  }

  @RequirePermission('knowledge.manage')
  @Post()
  @ApiOperation({ summary: 'Create a document' })
  create(
    @Body(new ZodValidationPipe(createKnowledgeDocumentSchema)) body: CreateKnowledgeDocumentInput,
    @Req() request: AppRequest,
  ): Promise<KnowledgeDocumentDto> {
    return this.knowledge.create(tenantOf(request), request.id, body);
  }

  @RequirePermission('knowledge.read')
  @Get(':documentId')
  @ApiOperation({ summary: 'Get a document' })
  get(
    @Param('documentId', idPipe) documentId: string,
    @Req() request: AppRequest,
  ): Promise<KnowledgeDocumentDto> {
    return this.knowledge.get(tenantOf(request), documentId);
  }

  @RequirePermission('knowledge.manage')
  @Patch(':documentId')
  @ApiOperation({ summary: 'Update a document' })
  update(
    @Param('documentId', idPipe) documentId: string,
    @Body(new ZodValidationPipe(updateKnowledgeDocumentSchema)) body: UpdateKnowledgeDocumentInput,
    @Req() request: AppRequest,
  ): Promise<KnowledgeDocumentDto> {
    return this.knowledge.update(tenantOf(request), request.id, documentId, body);
  }

  @RequirePermission('knowledge.manage')
  @Delete(':documentId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a document' })
  async remove(
    @Param('documentId', idPipe) documentId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    await this.knowledge.remove(tenantOf(request), request.id, documentId);
  }
}
