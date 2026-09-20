import {
  EmbeddingError,
  documentsNeedingEmbedding,
  embedDocumentChunks,
  type EmbeddingProvider,
  type PrismaClient,
} from '@nexus/database';
import {
  KNOWLEDGE_JOBS,
  QUEUE_NAMES,
  embedDocumentPayloadSchema,
  publishRealtime,
  type RealtimePublisher,
} from '@nexus/shared';
import type { Job } from 'bullmq';
import type { WorkerDefinition } from '../create-worker';
import type { Logger } from '../logger';

export interface KnowledgeDeps {
  prisma: PrismaClient;
  provider: EmbeddingProvider;
  logger: Logger;
  realtime?: RealtimePublisher;
}

export type EmbedOutcome = { embedded: number; skipped: number };

/**
 * Embed the chunks of one document that have no vector for the configured provider. Idempotent, so a
 * retry, a duplicate job and the sweep below can all run it without harm.
 */
export async function processEmbedJob(
  deps: KnowledgeDeps,
  payload: { organizationId: string; documentId: string },
  options: { isFinalAttempt: boolean },
): Promise<EmbedOutcome> {
  try {
    const result = await embedDocumentChunks(deps.prisma, deps.provider, payload);
    if (result.embedded > 0 && deps.realtime) {
      // The document's "search index ready" status changed.
      await publishRealtime(deps.realtime, payload.organizationId, [{ topic: 'knowledge' }]);
    }
    return result;
  } catch (error) {
    // A permanent failure (a model with the wrong dimensions) will not fix itself; retrying only
    // burns the provider's quota. Keyword search keeps working meanwhile.
    if (error instanceof EmbeddingError && !error.retryable) {
      deps.logger.error('embedding failed permanently', {
        documentId: payload.documentId,
        error: error.message,
      });
      return { embedded: 0, skipped: 0 };
    }
    if (options.isFinalAttempt) {
      deps.logger.error('embedding gave up after retries', { documentId: payload.documentId });
    }
    throw error;
  }
}

export function knowledgeWorker(
  deps: KnowledgeDeps,
  concurrency: number,
): WorkerDefinition<unknown, EmbedOutcome> {
  return {
    queue: QUEUE_NAMES.knowledge,
    concurrency,
    async process(job: Job) {
      if (job.name !== KNOWLEDGE_JOBS.embed) throw new Error(`Unknown knowledge job: ${job.name}`);
      const payload = embedDocumentPayloadSchema.parse(job.data);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return processEmbedJob(deps, payload, { isFinalAttempt });
    },
  };
}

/**
 * The safety net: documents whose chunks still lack a vector (the API could not queue the job, Redis
 * was down, the provider was switched) are found in the database and embedded. Runs slowly and
 * never overlaps itself.
 */
export function startEmbeddingSweep(options: { deps: KnowledgeDeps; intervalMs: number }): {
  stop(): Promise<void>;
} {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const { deps } = options;

  const tick = () => {
    if (running || stopped) return;
    running = true;
    inFlight = (async () => {
      const pending = await documentsNeedingEmbedding(deps.prisma, deps.provider.id, 10);
      for (const scope of pending) {
        if (stopped) break;
        await processEmbedJob(deps, scope, { isFinalAttempt: false }).catch((error: unknown) =>
          deps.logger.warn('embedding sweep could not embed a document', {
            documentId: scope.documentId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })()
      .catch((error: unknown) =>
        deps.logger.error('embedding sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
