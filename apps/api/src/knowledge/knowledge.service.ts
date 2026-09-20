import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  indexStatus,
  replaceDocumentChunks,
  retrieveKnowledge,
  type EmbeddingProvider,
  type Prisma,
  type PrismaClient,
} from '@nexus/database';
import {
  KNOWLEDGE_JOBS,
  KNOWLEDGE_LIMITS,
  chunkMarkdown,
  makeSnippet,
  type CreateKnowledgeDocumentInput,
  type EmbedDocumentPayload,
  type KnowledgeDocumentDto,
  type KnowledgeDocumentSummaryDto,
  type KnowledgeSearchResultDto,
  type ListKnowledgeQuery,
  type UpdateKnowledgeDocumentInput,
} from '@nexus/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { currentRequestId } from '../common/request-store';
import { slugify } from '../common/slug';
import { KNOWLEDGE_QUEUE, PRISMA } from '../infrastructure/tokens';
import type { RateLimiter } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';
import { EMBEDDINGS } from './tokens';

/** Searching embeds the query, which may cost something with a hosted provider, so it is limited. */
const SEARCHES_PER_MINUTE = 60;

const documentSelect = {
  id: true,
  title: true,
  slug: true,
  contentMd: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { name: true } },
  updatedBy: { select: { name: true } },
} satisfies Prisma.KnowledgeDocumentSelect;

type DocumentRow = Prisma.KnowledgeDocumentGetPayload<{ select: typeof documentSelect }>;

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(KNOWLEDGE_QUEUE) private readonly queue: Queue,
    @Inject(EMBEDDINGS) private readonly embeddings: EmbeddingProvider,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private summary(
    row: DocumentRow,
    index: { chunks: number; embedded: number } | undefined,
  ): KnowledgeDocumentSummaryDto {
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      tags: row.tags,
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: row.updatedBy?.name ?? null,
      index: index ?? { chunks: 0, embedded: 0 },
    };
  }

  private detail(
    row: DocumentRow,
    index: { chunks: number; embedded: number } | undefined,
  ): KnowledgeDocumentDto {
    return {
      ...this.summary(row, index),
      contentMd: row.contentMd,
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdBy?.name ?? null,
    };
  }

  async list(
    tenant: TenantContext,
    query: ListKnowledgeQuery,
  ): Promise<KnowledgeDocumentSummaryDto[]> {
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
        ...(query.tag ? { tags: { has: query.tag } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: KNOWLEDGE_LIMITS.maxDocumentsPerOrganization,
      select: documentSelect,
    });
    const status = await indexStatus(
      this.prisma,
      tenant.organizationId,
      rows.map((row) => row.id),
      this.embeddings.id,
    );
    return rows.map((row) => this.summary(row, status.get(row.id)));
  }

  async get(tenant: TenantContext, id: string): Promise<KnowledgeDocumentDto> {
    const row = await this.prisma.knowledgeDocument.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: documentSelect,
    });
    if (!row) throw ApiError.notFound('Document not found');
    const status = await indexStatus(this.prisma, tenant.organizationId, [id], this.embeddings.id);
    return this.detail(row, status.get(id));
  }

  async create(
    tenant: TenantContext,
    requestId: string | undefined,
    input: CreateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocumentDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      // Serialise creation per organization so the limit cannot be beaten by two requests at once.
      await tx.$executeRaw`SELECT 1 FROM "Organization" WHERE "id" = ${tenant.organizationId}::uuid FOR UPDATE`;
      const count = await tx.knowledgeDocument.count({
        where: { organizationId: tenant.organizationId },
      });
      if (count >= KNOWLEDGE_LIMITS.maxDocumentsPerOrganization) {
        throw ApiError.conflict(
          'DOCUMENT_LIMIT',
          `An organization can have at most ${KNOWLEDGE_LIMITS.maxDocumentsPerOrganization} documents`,
        );
      }
      const created = await tx.knowledgeDocument.create({
        data: {
          organizationId: tenant.organizationId,
          title: input.title,
          slug: slugify(input.title, 'document'),
          contentMd: input.contentMd,
          tags: input.tags,
          createdById: tenant.userId,
          updatedById: tenant.userId,
        },
        select: { id: true },
      });
      await replaceDocumentChunks(
        tx,
        tenant.organizationId,
        created.id,
        chunkMarkdown(input.title, input.contentMd),
      );
      await this.audit.record(tx, tenant, requestId, {
        action: 'knowledge.document.created',
        resourceType: 'knowledge_document',
        resourceId: created.id,
        metadata: { title: input.title, tags: input.tags, characters: input.contentMd.length },
      });
      return created.id;
    });
    await this.requestEmbedding(tenant.organizationId, id);
    return this.get(tenant, id);
  }

  async update(
    tenant: TenantContext,
    requestId: string | undefined,
    id: string,
    input: UpdateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocumentDto> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.knowledgeDocument.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { title: true, contentMd: true },
      });
      if (!existing) throw ApiError.notFound('Document not found');

      const title = input.title ?? existing.title;
      const contentMd = input.contentMd ?? existing.contentMd;
      await tx.knowledgeDocument.updateMany({
        where: { id, organizationId: tenant.organizationId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.contentMd !== undefined ? { contentMd: input.contentMd } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          updatedById: tenant.userId,
        },
      });
      // Only re-chunk when the searchable text changed; chunks whose text is unchanged keep their
      // vectors either way. (A new title changes every chunk's heading, so all of them re-embed.)
      if (title !== existing.title || contentMd !== existing.contentMd) {
        await replaceDocumentChunks(tx, tenant.organizationId, id, chunkMarkdown(title, contentMd));
      }
      await this.audit.record(tx, tenant, requestId, {
        action: 'knowledge.document.updated',
        resourceType: 'knowledge_document',
        resourceId: id,
        metadata: {
          title,
          changed: Object.keys(input),
          ...(input.contentMd !== undefined ? { characters: contentMd.length } : {}),
        },
      });
    });
    await this.requestEmbedding(tenant.organizationId, id);
    return this.get(tenant, id);
  }

  async remove(tenant: TenantContext, requestId: string | undefined, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.knowledgeDocument.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { title: true },
      });
      if (!existing) throw ApiError.notFound('Document not found');
      // Its chunks go with it (the foreign key cascades); the audit entry is the permanent record.
      await tx.knowledgeDocument.deleteMany({
        where: { id, organizationId: tenant.organizationId },
      });
      await this.audit.record(tx, tenant, requestId, {
        action: 'knowledge.document.deleted',
        resourceType: 'knowledge_document',
        resourceId: id,
        metadata: { title: existing.title },
      });
    });
  }

  async search(tenant: TenantContext, q: string, limit: number): Promise<KnowledgeSearchResultDto> {
    await this.limitSearches(tenant.userId);
    return this.toResult(
      await retrieveKnowledge(this.prisma, {
        organizationId: tenant.organizationId,
        query: q,
        limit,
        provider: this.embeddings,
      }),
      q,
    );
  }

  /** Runbooks that look relevant to an incident: its title, service and tags are the query. */
  async forIncident(
    tenant: TenantContext,
    incidentId: string,
    limit: number,
  ): Promise<KnowledgeSearchResultDto> {
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, organizationId: tenant.organizationId },
      select: {
        title: true,
        description: true,
        service: { select: { name: true } },
        tags: { select: { tag: true } },
      },
    });
    if (!incident) throw ApiError.notFound('Incident not found');
    await this.limitSearches(tenant.userId);

    const query = [
      incident.title,
      incident.service?.name ?? '',
      ...incident.tags.map((t) => t.tag),
      incident.description.slice(0, 300),
    ]
      .filter(Boolean)
      .join(' ');
    return this.toResult(
      await retrieveKnowledge(this.prisma, {
        organizationId: tenant.organizationId,
        query,
        limit,
        provider: this.embeddings,
      }),
      query,
    );
  }

  private toResult(
    result: Awaited<ReturnType<typeof retrieveKnowledge>>,
    query: string,
  ): KnowledgeSearchResultDto {
    return {
      mode: result.mode,
      data: result.hits.map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        slug: hit.slug,
        tags: hit.tags,
        heading: hit.heading,
        snippet: makeSnippet(hit.content, query),
        score: hit.score,
        matchedBy: hit.matchedBy,
      })),
    };
  }

  /** Per-user limit. If the limiter itself is down, search still works: only an exceeded limit refuses. */
  private async limitSearches(userId: string): Promise<void> {
    try {
      await this.limiter.consume('knowledge-search', userId, SEARCHES_PER_MINUTE, 60);
    } catch (error) {
      if (error instanceof ApiError && error.getStatus() === 429) throw error;
    }
  }

  /** Ask a worker to embed the document's new chunks. The worker's sweep is the safety net. */
  private async requestEmbedding(organizationId: string, documentId: string): Promise<void> {
    const requestId = currentRequestId();
    const payload: EmbedDocumentPayload = {
      organizationId,
      documentId,
      ...(requestId ? { requestId } : {}),
    };
    try {
      await this.queue.add(KNOWLEDGE_JOBS.embed, payload, {
        // Unique per save: a finished job for an earlier version must not swallow this one.
        jobId: `kb-${documentId}-${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      });
    } catch (error) {
      this.logger.warn(
        `Could not queue embedding for a document: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
