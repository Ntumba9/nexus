import {
  AnalysisError,
  assembleIncidentContext,
  recordIncidentEvent,
  type AnalysisProvider,
  type EmbeddingProvider,
  type Prisma,
  type PrismaClient,
} from '@nexus/database';
import {
  AI_JOBS,
  QUEUE_NAMES,
  investigationJobPayloadSchema,
  investigationOutputSchema,
  publishRealtime,
  verifyInvestigation,
  type RealtimePublisher,
} from '@nexus/shared';
import type { Job } from 'bullmq';
import type { WorkerDefinition } from '../create-worker';
import type { Logger } from '../logger';

export interface AiDeps {
  prisma: PrismaClient;
  provider: AnalysisProvider;
  /** Used only to retrieve runbooks for the context. */
  embeddings: EmbeddingProvider | null;
  logger: Logger;
  realtime?: RealtimePublisher;
}

export type InvestigationOutcome =
  | { status: 'succeeded'; droppedCitations: number }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

const ACTIVE = ['QUEUED', 'RUNNING'] as const;

/**
 * Run one investigation. The provider's answer is treated as untrusted whoever produced it: it must
 * match the answer schema, and every citation is checked against the sources the analysis was really
 * given before anything is stored. State is saved as it goes, so a retry (BullMQ, or a worker that
 * died) carries on safely; a finished investigation is never run again.
 */
export async function processInvestigation(
  deps: AiDeps,
  payload: { organizationId: string; investigationId: string },
  options: { isFinalAttempt: boolean },
): Promise<InvestigationOutcome> {
  const { prisma, provider, logger } = deps;
  const { organizationId, investigationId } = payload;

  const row = await prisma.aiInvestigation.findFirst({
    where: { id: investigationId, organizationId },
    select: {
      status: true,
      incidentId: true,
      question: true,
      requestedById: true,
      requestedBy: { select: { name: true } },
    },
  });
  if (!row) return { status: 'skipped', reason: 'investigation no longer exists' };
  if (row.status === 'SUCCEEDED' || row.status === 'FAILED') {
    return { status: 'skipped', reason: `already ${row.status}` };
  }

  await prisma.aiInvestigation.updateMany({
    where: { id: investigationId, organizationId, status: { in: [...ACTIVE] } },
    data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date() },
  });

  const fail = async (reason: string): Promise<InvestigationOutcome> => {
    await prisma.aiInvestigation.updateMany({
      where: { id: investigationId, organizationId, status: { in: [...ACTIVE] } },
      data: { status: 'FAILED', error: reason.slice(0, 300), finishedAt: new Date() },
    });
    await announce(deps, organizationId);
    logger.warn('ai investigation failed', { investigationId, reason });
    return { status: 'failed', reason };
  };

  const context = await assembleIncidentContext(prisma, {
    organizationId,
    incidentId: row.incidentId,
    embeddings: deps.embeddings,
  });
  if (!context) return fail('the incident no longer exists');

  let raw: unknown;
  try {
    raw = await provider.analyze({
      incident: context.incident,
      sources: context.sources,
      question: row.question,
    });
  } catch (error) {
    if (error instanceof AnalysisError) {
      // Transient (a timeout, a 429, a 5xx): let BullMQ try again, unless this was the last try.
      if (error.retryable && !options.isFinalAttempt) throw error;
      return fail(error.message);
    }
    logger.error('ai provider threw unexpectedly', {
      investigationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail('the analysis hit an unexpected error');
  }

  const parsed = investigationOutputSchema.safeParse(raw);
  if (!parsed.success) {
    // A model that returns the wrong shape often gets it right on a second try.
    if (provider.kind === 'model' && !options.isFinalAttempt) {
      throw new AnalysisError('the AI answer did not match the expected format', true);
    }
    return fail('the AI answer did not match the expected format');
  }

  const report = verifyInvestigation(parsed.data, new Set(context.sources.map((s) => s.label)));

  await prisma.$transaction(async (tx) => {
    const updated = await tx.aiInvestigation.updateMany({
      where: { id: investigationId, organizationId, status: { in: [...ACTIVE] } },
      data: {
        status: 'SUCCEEDED',
        context: context.sources as unknown as Prisma.InputJsonArray,
        output: report.output as unknown as Prisma.InputJsonObject,
        droppedCitations: report.droppedCitations,
        droppedClaims: report.droppedClaims,
        downgradedCauses: report.downgradedCauses,
        truncated: context.truncated,
        error: null,
        finishedAt: new Date(),
      },
    });
    if (updated.count === 0) return; // finished by someone else in the meantime
    await recordIncidentEvent(tx, {
      organizationId,
      incidentId: row.incidentId,
      type: 'AI_INVESTIGATED',
      actor: row.requestedById
        ? { type: 'USER', id: row.requestedById }
        : { type: 'SYSTEM', id: null },
      data: {
        investigationId,
        provider: provider.label,
        confidence: report.output.confidence,
        causes: report.output.possibleCauses.length,
      },
    });
  });

  await announce(deps, organizationId);
  return { status: 'succeeded', droppedCitations: report.droppedCitations };
}

async function announce(deps: AiDeps, organizationId: string): Promise<void> {
  if (!deps.realtime) return;
  await publishRealtime(deps.realtime, organizationId, [{ topic: 'ai' }, { topic: 'incidents' }]);
}

export function investigationWorker(
  deps: AiDeps,
  concurrency: number,
): WorkerDefinition<unknown, InvestigationOutcome> {
  return {
    queue: QUEUE_NAMES.ai,
    concurrency,
    async process(job: Job) {
      if (job.name !== AI_JOBS.investigate) throw new Error(`Unknown AI job: ${job.name}`);
      const payload = investigationJobPayloadSchema.parse(job.data);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return processInvestigation(deps, payload, { isFinalAttempt });
    },
  };
}
