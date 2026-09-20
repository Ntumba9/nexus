import { tokenize, type KnowledgeMatchKind } from '@nexus/shared';
import type { PrismaClient } from '@prisma/client';
import type { EmbeddingProvider } from './embeddings';
import { toVectorLiteral } from './write';

/** Reciprocal-rank-fusion constant. 60 is the value from the original paper and works well in practice. */
const RRF_K = 60;
/** How many candidates each ranking contributes before they are fused. */
const CANDIDATES = 30;
/** Below this cosine similarity a vector match is treated as noise. */
const DEFAULT_MIN_SIMILARITY = 0.2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RetrieveOptions {
  /**
   * REQUIRED, and there is no variant of this function without it: every query below filters by it
   * first, so retrieval can never reach across organisations (ADR-006). Callers take it from the
   * verified session or from a stored record, never from request input.
   */
  organizationId: string;
  query: string;
  limit?: number;
  /** Without one (or if it fails) only keyword search runs. */
  provider?: EmbeddingProvider | null;
  minSimilarity?: number;
}

export interface RetrievedChunk {
  documentId: string;
  chunkId: string;
  title: string;
  slug: string;
  tags: string[];
  heading: string;
  content: string;
  /** 0 to 1; 1 means the best possible agreement between both rankings. */
  score: number;
  matchedBy: KnowledgeMatchKind[];
}

export interface RetrievalResult {
  hits: RetrievedChunk[];
  mode: 'hybrid' | 'keyword';
}

/**
 * A tsquery that matches ANY of the query's words (`'restart' | 'checkout'`), ranked by how many
 * match. Questions ("how do I restart checkout?") rarely have every word in the answer, so requiring
 * all of them would return nothing. Terms are quoted, and contain only letters, digits, `_` and `-`.
 */
export function toOrTsQuery(query: string): string | null {
  const terms = [...new Set(tokenize(query))].slice(0, 20);
  return terms.length === 0 ? null : terms.map((term) => `'${term}'`).join(' | ');
}

async function keywordRanking(
  prisma: PrismaClient,
  organizationId: string,
  tsquery: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c."id"
    FROM "KnowledgeChunk" c
    WHERE c."organizationId" = ${organizationId}::uuid
      AND to_tsvector('english', c."heading" || ' ' || c."content") @@ to_tsquery('english', ${tsquery})
    ORDER BY ts_rank_cd(to_tsvector('english', c."heading" || ' ' || c."content"),
                        to_tsquery('english', ${tsquery})) DESC, c."id"
    LIMIT ${CANDIDATES}`;
  return rows.map((row) => row.id);
}

async function semanticRanking(
  prisma: PrismaClient,
  organizationId: string,
  provider: EmbeddingProvider,
  query: string,
  minSimilarity: number,
): Promise<string[]> {
  const [vector] = await provider.embed([query]);
  const literal = toVectorLiteral(vector!);
  return prisma.$transaction(async (tx) => {
    // The index is shared by every organisation. Without this, it returns its nearest rows across ALL
    // tenants first and the organisation filter is applied afterwards, which can leave a small
    // organisation with no results at all. Iterative scans keep going until the filter is satisfied.
    await tx.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
    const rows = await tx.$queryRaw<{ id: string; similarity: number }[]>`
      SELECT c."id", 1 - (c."embedding" <=> ${literal}::vector) AS similarity
      FROM "KnowledgeChunk" c
      WHERE c."organizationId" = ${organizationId}::uuid
        AND c."embedding" IS NOT NULL
        AND c."embeddingModel" = ${provider.id}
      ORDER BY c."embedding" <=> ${literal}::vector
      LIMIT ${CANDIDATES}`;
    return rows.filter((row) => row.similarity >= minSimilarity).map((row) => row.id);
  });
}

/**
 * Find the parts of an organisation's knowledge base that best answer `query`: keyword search and
 * meaning-based search, fused by rank, one result per document (its best chunk). If meaning-based
 * search is unavailable the answer is keyword-only and says so; it never fails because of it.
 */
export async function retrieveKnowledge(
  prisma: PrismaClient,
  options: RetrieveOptions,
): Promise<RetrievalResult> {
  const { organizationId, query } = options;
  if (!UUID.test(organizationId)) throw new Error('retrieveKnowledge requires an organizationId');
  const limit = options.limit ?? 8;

  const tsquery = toOrTsQuery(query);
  const keyword = tsquery ? await keywordRanking(prisma, organizationId, tsquery) : [];

  let semantic: string[] = [];
  let mode: RetrievalResult['mode'] = 'keyword';
  if (options.provider && query.trim() !== '') {
    try {
      semantic = await semanticRanking(
        prisma,
        organizationId,
        options.provider,
        query,
        options.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      );
      mode = 'hybrid';
    } catch {
      // The embedder is down or misconfigured: keyword results are still worth returning.
    }
  }

  const fused = new Map<string, { score: number; matchedBy: Set<KnowledgeMatchKind> }>();
  const add = (ids: string[], kind: KnowledgeMatchKind) =>
    ids.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, matchedBy: new Set<KnowledgeMatchKind>() };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.matchedBy.add(kind);
      fused.set(id, entry);
    });
  add(keyword, 'keyword');
  add(semantic, 'semantic');
  if (fused.size === 0) return { hits: [], mode };

  const rows = await prisma.knowledgeChunk.findMany({
    where: { organizationId, id: { in: [...fused.keys()] } },
    select: {
      id: true,
      documentId: true,
      heading: true,
      content: true,
      document: { select: { title: true, slug: true, tags: true } },
    },
  });

  // One result per document: its best-scoring chunk.
  const best = new Map<string, RetrievedChunk>();
  const ceiling = mode === 'hybrid' ? 2 / (RRF_K + 1) : 1 / (RRF_K + 1);
  for (const row of rows) {
    const entry = fused.get(row.id)!;
    const candidate: RetrievedChunk = {
      documentId: row.documentId,
      chunkId: row.id,
      title: row.document.title,
      slug: row.document.slug,
      tags: row.document.tags,
      heading: row.heading,
      content: row.content,
      score: Math.round(Math.min(1, entry.score / ceiling) * 100) / 100,
      matchedBy: [...entry.matchedBy].sort(),
    };
    const current = best.get(row.documentId);
    if (!current || candidate.score > current.score) best.set(row.documentId, candidate);
  }
  const hits = [...best.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
  return { hits, mode };
}
