import { randomUUID } from 'node:crypto';
import {
  EmbeddingError,
  createLocalEmbeddingProvider,
  indexStatus,
  replaceDocumentChunks,
  type EmbeddingProvider,
  type PrismaClient,
} from '@nexus/database';
import { chunkMarkdown, organizationOfChannel, type RealtimeMessage } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { HAS_DB, seedService, testPrisma } from '../testing/db';
import { processEmbedJob, startEmbeddingSweep, type KnowledgeDeps } from './embed';

const logger = createLogger('silent');
const TEXT =
  '# Restart\nRestart the checkout service with the deploy tool and watch the error rate.';

describe.skipIf(!HAS_DB)('knowledge embedding worker (integration)', () => {
  let prisma: PrismaClient;
  const local = createLocalEmbeddingProvider();
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  async function pendingDocument() {
    const { organizationId } = await seedService(prisma);
    const doc = await prisma.$transaction(async (tx) => {
      const created = await tx.knowledgeDocument.create({
        data: {
          organizationId,
          title: 'Runbook',
          slug: `runbook-${randomUUID().slice(0, 8)}`,
          contentMd: TEXT,
        },
      });
      await replaceDocumentChunks(tx, organizationId, created.id, chunkMarkdown('Runbook', TEXT));
      return created;
    });
    return { organizationId, documentId: doc.id };
  }

  const status = async (scope: { organizationId: string; documentId: string }, model: string) =>
    (await indexStatus(prisma, scope.organizationId, [scope.documentId], model)).get(
      scope.documentId,
    )!;

  const deps = (provider: EmbeddingProvider, sent: RealtimeMessage[] = []): KnowledgeDeps => ({
    prisma,
    provider,
    logger,
    realtime: {
      publish: async (channel: string, raw: string) => {
        if (organizationOfChannel(channel)) sent.push(JSON.parse(raw) as RealtimeMessage);
        return 1;
      },
    },
  });

  it('embeds a document’s chunks and tells the browser the index changed', async () => {
    const scope = await pendingDocument();
    const sent: RealtimeMessage[] = [];
    const result = await processEmbedJob(deps(local, sent), scope, { isFinalAttempt: false });
    expect(result.embedded).toBeGreaterThan(0);
    const after = await status(scope, local.id);
    expect(after.embedded).toBe(after.chunks);
    expect(sent).toEqual([{ topic: 'knowledge' }]);
  });

  it('is idempotent: a duplicate job embeds nothing and announces nothing', async () => {
    const scope = await pendingDocument();
    await processEmbedJob(deps(local), scope, { isFinalAttempt: false });
    const sent: RealtimeMessage[] = [];
    const again = await processEmbedJob(deps(local, sent), scope, { isFinalAttempt: false });
    expect(again).toEqual({ embedded: 0, skipped: 0 });
    expect(sent).toEqual([]);
  });

  it('retries a transient provider failure (throws) and leaves the chunks pending', async () => {
    const scope = await pendingDocument();
    const flaky: EmbeddingProvider = {
      id: 'flaky',
      embed: () => Promise.reject(new EmbeddingError('the embedding service answered 503', true)),
    };
    await expect(
      processEmbedJob(deps(flaky), scope, { isFinalAttempt: false }),
    ).rejects.toBeInstanceOf(EmbeddingError);
    expect((await status(scope, 'flaky')).embedded).toBe(0);
  });

  it('gives up on a permanent failure without retrying, and keyword search still works', async () => {
    const scope = await pendingDocument();
    const wrongModel: EmbeddingProvider = {
      id: 'wrong-dims',
      embed: () =>
        Promise.reject(
          new EmbeddingError('the model returned 2 dimensions but 384 are required', false),
        ),
    };
    // Resolves (so BullMQ does not retry) rather than throwing.
    await expect(
      processEmbedJob(deps(wrongModel), scope, { isFinalAttempt: false }),
    ).resolves.toEqual({ embedded: 0, skipped: 0 });
  });

  it('rejects vectors of the wrong size before they reach the database', async () => {
    const scope = await pendingDocument();
    const bad: EmbeddingProvider = {
      id: 'short',
      embed: async (texts) => texts.map(() => [1, 2, 3]),
    };
    await expect(processEmbedJob(deps(bad), scope, { isFinalAttempt: true })).rejects.toThrow(
      /384/,
    );
    expect((await status(scope, 'short')).embedded).toBe(0);
  });

  it('the sweep finds and embeds documents whose job was never queued', async () => {
    const scope = await pendingDocument();
    const sweep = startEmbeddingSweep({ deps: deps(local), intervalMs: 50 });
    try {
      const deadline = Date.now() + 10_000;
      while ((await status(scope, local.id)).embedded === 0) {
        if (Date.now() > deadline) throw new Error('the sweep never embedded the document');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await sweep.stop();
    }
    const after = await status(scope, local.id);
    expect(after.embedded).toBe(after.chunks);
  });
});
