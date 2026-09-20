import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS, embeddingInput, type KnowledgeChunkDraft } from '@nexus/shared';
import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../incident-writes';
import type { EmbeddingProvider } from './embeddings';

export const chunkHash = (chunk: Pick<KnowledgeChunkDraft, 'heading' | 'content'>): string =>
  createHash('sha256').update(chunk.heading).update('\u0000').update(chunk.content).digest('hex');

export interface ChunkWriteResult {
  inserted: number;
  kept: number;
  removed: number;
}

/**
 * Make a document's stored chunks equal `chunks`. A chunk whose text did not change keeps its row and
 * therefore its embedding, so editing one paragraph of a long runbook re-embeds one chunk, not all of
 * them. Call inside the transaction that saves the document.
 */
export async function replaceDocumentChunks(
  tx: Tx,
  organizationId: string,
  documentId: string,
  chunks: readonly KnowledgeChunkDraft[],
): Promise<ChunkWriteResult> {
  const existing = await tx.knowledgeChunk.findMany({
    where: { organizationId, documentId },
    select: { id: true, contentHash: true },
  });
  const available = new Map<string, string[]>();
  for (const row of existing) {
    const ids = available.get(row.contentHash) ?? [];
    ids.push(row.id);
    available.set(row.contentHash, ids);
  }

  let kept = 0;
  const toInsert: { chunk: KnowledgeChunkDraft; hash: string }[] = [];
  for (const chunk of chunks) {
    const hash = chunkHash(chunk);
    const id = available.get(hash)?.pop();
    if (id) {
      kept += 1;
      await tx.knowledgeChunk.updateMany({
        where: { id, organizationId },
        data: { ordinal: chunk.ordinal },
      });
    } else {
      toInsert.push({ chunk, hash });
    }
  }

  const stale = [...available.values()].flat();
  if (stale.length > 0) {
    await tx.knowledgeChunk.deleteMany({ where: { organizationId, id: { in: stale } } });
  }
  if (toInsert.length > 0) {
    await tx.knowledgeChunk.createMany({
      data: toInsert.map(({ chunk, hash }) => ({
        organizationId,
        documentId,
        ordinal: chunk.ordinal,
        heading: chunk.heading,
        content: chunk.content,
        contentHash: hash,
      })),
    });
  }
  return { inserted: toInsert.length, kept, removed: stale.length };
}

/** A pgvector text literal. Refuses anything that is not a finite number of the right length. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error(`an embedding must be ${EMBEDDING_DIMENSIONS} finite numbers`);
  }
  return `[${vector.join(',')}]`;
}

const BATCH = 16;

export interface EmbedResult {
  embedded: number;
  /** Chunks that changed or disappeared while they were being embedded (nothing wrong). */
  skipped: number;
}

/**
 * Give every chunk of a document that lacks a vector for `provider` one. Safe to run any number of
 * times and from several workers at once: a chunk is only updated if it still has the text that was
 * embedded, so an edit made in the meantime is never overwritten with a stale vector.
 */
export async function embedDocumentChunks(
  prisma: PrismaClient,
  provider: EmbeddingProvider,
  scope: { organizationId: string; documentId: string },
): Promise<EmbedResult> {
  const { organizationId, documentId } = scope;
  const result: EmbedResult = { embedded: 0, skipped: 0 };

  for (;;) {
    const pending = await prisma.knowledgeChunk.findMany({
      where: {
        organizationId,
        documentId,
        OR: [{ embeddingModel: null }, { embeddingModel: { not: provider.id } }],
      },
      orderBy: { ordinal: 'asc' },
      take: BATCH,
      select: { id: true, heading: true, content: true, contentHash: true },
    });
    if (pending.length === 0) return result;

    const vectors = await provider.embed(pending.map((chunk) => embeddingInput(chunk)));
    let progressed = 0;
    for (const [i, chunk] of pending.entries()) {
      const literal = toVectorLiteral(vectors[i]!);
      const updated = await prisma.$executeRaw`
        UPDATE "KnowledgeChunk"
        SET "embedding" = ${literal}::vector, "embeddingModel" = ${provider.id}, "embeddedAt" = now()
        WHERE "id" = ${chunk.id}::uuid AND "organizationId" = ${organizationId}::uuid
          AND "contentHash" = ${chunk.contentHash}`;
      if (updated > 0) {
        result.embedded += 1;
        progressed += 1;
      } else {
        result.skipped += 1;
      }
    }
    // Every row in the batch changed under us: stop rather than spin; the next job picks it up.
    if (progressed === 0) return result;
  }
}

/** Documents that still have chunks without a vector for `model` (the worker's safety-net sweep). */
export async function documentsNeedingEmbedding(
  prisma: PrismaClient,
  model: string,
  limit = 20,
): Promise<{ organizationId: string; documentId: string }[]> {
  return prisma.knowledgeChunk.findMany({
    where: { OR: [{ embeddingModel: null }, { embeddingModel: { not: model } }] },
    distinct: ['organizationId', 'documentId'],
    take: limit,
    select: { organizationId: true, documentId: true },
  });
}

/** How many chunks each document has, and how many already have a vector for `model`. */
export async function indexStatus(
  prisma: PrismaClient,
  organizationId: string,
  documentIds: readonly string[],
  model: string,
): Promise<Map<string, { chunks: number; embedded: number }>> {
  const status = new Map<string, { chunks: number; embedded: number }>();
  if (documentIds.length === 0) return status;
  const rows = await prisma.$queryRaw<{ documentId: string; chunks: number; embedded: number }[]>`
    SELECT "documentId",
           count(*)::int AS chunks,
           (count(*) FILTER (WHERE "embeddingModel" = ${model}))::int AS embedded
    FROM "KnowledgeChunk"
    WHERE "organizationId" = ${organizationId}::uuid AND "documentId" = ANY(${[...documentIds]}::uuid[])
    GROUP BY "documentId"`;
  for (const row of rows)
    status.set(row.documentId, { chunks: row.chunks, embedded: row.embedded });
  return status;
}
