import { randomUUID } from 'node:crypto';
import { chunkMarkdown, EMBEDDING_DIMENSIONS } from '@nexus/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createEmbeddingProvider,
  createLocalEmbeddingProvider,
  createPrismaClient,
  documentsNeedingEmbedding,
  embedDocumentChunks,
  indexStatus,
  replaceDocumentChunks,
  retrieveKnowledge,
  toOrTsQuery,
  type EmbeddingProvider,
} from './index';

// Requires PostgreSQL with migrations applied. Goes straight to the database: proves what the
// database and the retrieval functions guarantee on their own, with no application code in between.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('knowledge base (integration)', () => {
  const prisma = createPrismaClient(url ?? 'postgresql://unused');
  const local = createLocalEmbeddingProvider();
  afterAll(() => prisma.$disconnect());

  async function org() {
    const suffix = randomUUID().slice(0, 8);
    return prisma.organization.create({ data: { name: `Org ${suffix}`, slug: `org-${suffix}` } });
  }

  /** Save a document and its chunks the way the API does; optionally embed them. */
  async function document(
    organizationId: string,
    title: string,
    contentMd: string,
    options: { embed?: EmbeddingProvider | false } = {},
  ) {
    const doc = await prisma.$transaction(async (tx) => {
      const created = await tx.knowledgeDocument.create({
        data: { organizationId, title, slug: `doc-${randomUUID().slice(0, 8)}`, contentMd },
      });
      await replaceDocumentChunks(tx, organizationId, created.id, chunkMarkdown(title, contentMd));
      return created;
    });
    if (options.embed !== false) {
      await embedDocumentChunks(prisma, options.embed ?? local, {
        organizationId,
        documentId: doc.id,
      });
    }
    return doc;
  }

  const RESTART = `# Restart\nRestart the checkout service with the deploy tool, then watch the error rate for ten minutes.`;
  const FAILOVER = `# Failover\nTo fail over the primary database, promote the replica and update the connection string.`;
  const BUDGET = `# Budget\nQuarterly budget planning covers hiring forecasts and vendor contracts.`;

  describe('schema guarantees', () => {
    it('refuses a chunk that points at another organization’s document', async () => {
      const a = await org();
      const b = await org();
      const doc = await document(a.id, 'Alpha runbook', RESTART, { embed: false });
      await expect(
        prisma.knowledgeChunk.create({
          data: {
            organizationId: b.id,
            documentId: doc.id,
            ordinal: 0,
            heading: 'x',
            content: 'y',
            contentHash: 'z',
          },
        }),
      ).rejects.toThrow();
    });

    it('deletes chunks with their document', async () => {
      const a = await org();
      const doc = await document(a.id, 'Temp', RESTART, { embed: false });
      await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
      expect(await prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBe(0);
    });

    it('requires a vector and its model together', async () => {
      const a = await org();
      const doc = await document(a.id, 'Pairs', RESTART, { embed: false });
      const chunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { documentId: doc.id } });
      const vector = `[${new Array(EMBEDDING_DIMENSIONS).fill(0.1).join(',')}]`;
      await expect(
        prisma.$executeRaw`UPDATE "KnowledgeChunk" SET "embedding" = ${vector}::vector WHERE "id" = ${chunk.id}::uuid`,
      ).rejects.toThrow();
    });

    it('rejects an over-long title, too many tags and a bad slug', async () => {
      const a = await org();
      const base = { organizationId: a.id, contentMd: '' };
      await expect(
        prisma.knowledgeDocument.create({
          data: { ...base, title: 'x'.repeat(201), slug: 'ok-slug' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.knowledgeDocument.create({
          data: {
            ...base,
            title: 'T',
            slug: 'ok-slug-2',
            tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.knowledgeDocument.create({ data: { ...base, title: 'T', slug: 'Bad Slug!' } }),
      ).rejects.toThrow();
    });
  });

  describe('replaceDocumentChunks', () => {
    it('keeps unchanged chunks (and their embeddings) when a document is edited', async () => {
      const a = await org();
      const long = `# One\n${'alpha bravo charlie delta '.repeat(6)}\n# Two\n${'echo foxtrot golf hotel '.repeat(6)}`;
      const doc = await document(a.id, 'Editable', long);
      const before = await prisma.knowledgeChunk.findMany({
        where: { documentId: doc.id },
        orderBy: { ordinal: 'asc' },
      });
      expect(before).toHaveLength(2);

      const edited = `# One\n${'alpha bravo charlie delta '.repeat(6)}\n# Two\n${'india juliet kilo lima '.repeat(6)}`;
      const result = await prisma.$transaction((tx) =>
        replaceDocumentChunks(tx, a.id, doc.id, chunkMarkdown('Editable', edited)),
      );
      expect(result).toEqual({ inserted: 1, kept: 1, removed: 1 });

      const after = await prisma.knowledgeChunk.findMany({
        where: { documentId: doc.id },
        orderBy: { ordinal: 'asc' },
      });
      expect(after[0]!.id).toBe(before[0]!.id); // same row, so it kept its vector
      expect(after[1]!.id).not.toBe(before[1]!.id);
      const status = await indexStatus(prisma, a.id, [doc.id], local.id);
      expect(status.get(doc.id)).toEqual({ chunks: 2, embedded: 1 });
    });

    it('is idempotent', async () => {
      const a = await org();
      const doc = await document(a.id, 'Same', RESTART);
      const result = await prisma.$transaction((tx) =>
        replaceDocumentChunks(tx, a.id, doc.id, chunkMarkdown('Same', RESTART)),
      );
      expect(result).toMatchObject({ inserted: 0, removed: 0 });
    });
  });

  describe('embedDocumentChunks', () => {
    it('embeds only what is missing and reports pending work', async () => {
      const a = await org();
      const doc = await document(a.id, 'Pending', RESTART, { embed: false });
      expect(
        (await documentsNeedingEmbedding(prisma, local.id, 1000)).some(
          (d) => d.documentId === doc.id,
        ),
      ).toBe(true);

      const first = await embedDocumentChunks(prisma, local, {
        organizationId: a.id,
        documentId: doc.id,
      });
      expect(first.embedded).toBeGreaterThan(0);
      const second = await embedDocumentChunks(prisma, local, {
        organizationId: a.id,
        documentId: doc.id,
      });
      expect(second).toEqual({ embedded: 0, skipped: 0 });
      expect(
        (await documentsNeedingEmbedding(prisma, local.id, 1000)).some(
          (d) => d.documentId === doc.id,
        ),
      ).toBe(false);
    });

    it('never writes a stale vector over text that changed while it was embedding', async () => {
      const a = await org();
      const doc = await document(a.id, 'Racy', RESTART, { embed: false });
      const slow: EmbeddingProvider = {
        id: 'slow-test',
        async embed(texts) {
          // The document is edited (its chunk replaced) while the provider is "thinking".
          await prisma.$transaction((tx) =>
            replaceDocumentChunks(tx, a.id, doc.id, chunkMarkdown('Racy', FAILOVER)),
          );
          return texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.05));
        },
      };
      const result = await embedDocumentChunks(prisma, slow, {
        organizationId: a.id,
        documentId: doc.id,
      });
      expect(result.embedded).toBe(0);
      expect(result.skipped).toBeGreaterThan(0);
      const status = await indexStatus(prisma, a.id, [doc.id], 'slow-test');
      expect(status.get(doc.id)!.embedded).toBe(0);
    });

    it('re-embeds when the provider changes, and keeps the models apart', async () => {
      const a = await org();
      const doc = await document(a.id, 'Switch', RESTART);
      const other: EmbeddingProvider = {
        id: 'other-model',
        embed: async (texts) => texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.05)),
      };
      const result = await embedDocumentChunks(prisma, other, {
        organizationId: a.id,
        documentId: doc.id,
      });
      expect(result.embedded).toBeGreaterThan(0);
      // Searching with the local provider now finds no vectors for it (they are 'other-model').
      const { hits, mode } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'zzzzqqq',
        provider: local,
      });
      expect(hits).toEqual([]);
      expect(mode).toBe('hybrid');
    });
  });

  describe('retrieveKnowledge', () => {
    it('finds the relevant document by keyword and by meaning, and ranks it first', async () => {
      const a = await org();
      const restart = await document(a.id, 'Checkout restart runbook', RESTART);
      await document(a.id, 'Database failover', FAILOVER);
      await document(a.id, 'Budget planning', BUDGET);

      const { hits, mode } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'how do I restart the checkout service',
        provider: local,
      });
      expect(mode).toBe('hybrid');
      expect(hits[0]!.documentId).toBe(restart.id);
      expect(hits[0]!.matchedBy).toEqual(['keyword', 'semantic']);
      expect(hits[0]!.score).toBeGreaterThan(0.5);
      expect(hits.map((h) => h.title)).not.toContain('Budget planning');
    });

    it('returns one result per document, its best chunk, with where it sits', async () => {
      const a = await org();
      const md = `# Setup\n${'install the agent and configure the token. '.repeat(3)}\n# Rollback\n${'rollback the release using the deploy tool immediately. '.repeat(3)}`;
      await document(a.id, 'Release guide', md);
      const { hits } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'rollback release',
        provider: local,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.heading).toBe('Release guide › Rollback');
    });

    it('finds a document by its title alone', async () => {
      const a = await org();
      const doc = await document(a.id, 'Kubernetes pod eviction', '');
      const { hits } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'pod eviction',
        provider: local,
      });
      expect(hits.map((h) => h.documentId)).toContain(doc.id);
    });

    it('works with keyword search only, and says so', async () => {
      const a = await org();
      const doc = await document(a.id, 'Restart guide', RESTART, { embed: false });
      const { hits, mode } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'restart checkout',
      });
      expect(mode).toBe('keyword');
      expect(hits[0]!.documentId).toBe(doc.id);
      expect(hits[0]!.matchedBy).toEqual(['keyword']);
    });

    it('degrades to keyword search when the embedding provider fails', async () => {
      const a = await org();
      const doc = await document(a.id, 'Restart guide', RESTART);
      const broken: EmbeddingProvider = {
        id: local.id,
        embed: () => Promise.reject(new Error('embedding service is down')),
      };
      const { hits, mode } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'restart checkout',
        provider: broken,
      });
      expect(mode).toBe('keyword');
      expect(hits[0]!.documentId).toBe(doc.id);
    });

    it('returns nothing for a query with no searchable words', async () => {
      const a = await org();
      await document(a.id, 'Restart guide', RESTART);
      const { hits } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'the and of ???',
        provider: local,
      });
      expect(hits).toEqual([]);
    });

    it('respects the limit', async () => {
      const a = await org();
      for (let i = 0; i < 4; i += 1) await document(a.id, `Restart guide ${i}`, RESTART);
      const { hits } = await retrieveKnowledge(prisma, {
        organizationId: a.id,
        query: 'restart checkout',
        provider: local,
        limit: 2,
      });
      expect(hits).toHaveLength(2);
    });

    it('never returns another organization’s knowledge, by either kind of search', async () => {
      const a = await org();
      const b = await org();
      const secret = await document(
        b.id,
        'Bravo private runbook',
        '# Secrets\nThe bravo vault rotation password procedure lives here.',
      );
      await document(a.id, 'Alpha note', '# Alpha\nUnrelated alpha content about lunch.');

      for (const provider of [local, null] as const) {
        const { hits } = await retrieveKnowledge(prisma, {
          organizationId: a.id,
          query: 'bravo vault rotation password procedure',
          provider,
        });
        expect(hits.map((h) => h.documentId)).not.toContain(secret.id);
        expect(JSON.stringify(hits)).not.toContain('bravo vault');
      }
      const own = await retrieveKnowledge(prisma, {
        organizationId: b.id,
        query: 'bravo vault rotation password procedure',
        provider: local,
      });
      expect(own.hits[0]!.documentId).toBe(secret.id);
    });

    it('still finds a small organization’s documents when other organizations have far more', async () => {
      const small = await org();
      const big = await org();
      const target = await document(
        small.id,
        'Payments outage',
        '# Outage\nPayments outage checklist for the on-call engineer.',
      );
      for (let i = 0; i < 25; i += 1) {
        await document(
          big.id,
          `Payments outage variant ${i}`,
          `# Outage ${i}\nPayments outage procedure number ${i} for the on-call engineer.`,
        );
      }
      const { hits } = await retrieveKnowledge(prisma, {
        organizationId: small.id,
        query: 'payments outage on-call',
        provider: local,
      });
      expect(hits.map((h) => h.documentId)).toEqual([target.id]);
    });

    it('refuses to run without a valid organization id', async () => {
      await expect(
        retrieveKnowledge(prisma, { organizationId: '', query: 'restart' }),
      ).rejects.toThrow(/organizationId/);
      await expect(
        retrieveKnowledge(prisma, { organizationId: "x' OR 1=1 --", query: 'restart' }),
      ).rejects.toThrow(/organizationId/);
    });

    it('treats hostile query text as data', async () => {
      const a = await org();
      await document(a.id, 'Restart guide', RESTART);
      for (const query of [
        `'; DROP TABLE "KnowledgeChunk"; --`,
        `restart' | 'x`,
        '\\',
        '"unbalanced',
        ':* & !',
      ]) {
        await expect(
          retrieveKnowledge(prisma, { organizationId: a.id, query, provider: local }),
        ).resolves.toBeDefined();
      }
      expect(
        await prisma.knowledgeChunk.count({ where: { organizationId: a.id } }),
      ).toBeGreaterThan(0);
    });
  });

  describe('toOrTsQuery', () => {
    it('quotes and ORs the words', () => {
      expect(toOrTsQuery('Restart the DB-primary!')).toBe(`'restart' | 'db-primary'`);
      expect(toOrTsQuery('the and of')).toBeNull();
    });
  });

  describe('createEmbeddingProvider', () => {
    it('builds the local provider, and refuses an incomplete remote one', () => {
      expect(createEmbeddingProvider({ provider: 'local' }).id).toBe('local-hash-v1');
      expect(() => createEmbeddingProvider({ provider: 'openai' })).toThrow(/EMBEDDING_API_URL/);
      expect(
        createEmbeddingProvider({ provider: 'openai', apiUrl: 'http://x/v1', model: 'm' }).id,
      ).toBe('openai:m');
    });
  });
});
