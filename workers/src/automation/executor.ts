import { recordIncidentEvent, type PrismaClient } from '@nexus/database';
import {
  actionResultListSchema,
  automationActionListSchema,
  type ActionResult,
  type AutomationAction,
  type AutomationJobPayload,
  type AutomationTrigger,
  type ExecutionStatus,
  type Facts,
} from '@nexus/shared';
import type { Logger } from '../logger';
import { runNotify, type ActionContext, type ActionOutcome } from './actions/notify';
import type { EmailSender } from './email';

export interface ExecutorDeps {
  prisma: PrismaClient;
  logger: Logger;
  email: EmailSender;
  webOrigin: string;
  /** Extra action handlers, keyed by action type (added by later steps of the engine). */
  handlers?: Partial<Record<AutomationAction['type'], ActionHandler>>;
}

export type ActionHandler = (ctx: ActionContext, action: never) => Promise<ActionOutcome>;

export type ExecutionOutcome =
  { status: 'finished'; result: ExecutionStatus } | { status: 'skipped'; reason: string };

const TERMINAL = new Set<ExecutionStatus>(['SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED']);

/** The overall verdict from the per-action results. */
export function summarise(results: readonly ActionResult[]): ExecutionStatus {
  const failed = results.filter((r) => r.status === 'FAILED').length;
  const partial = results.filter((r) => r.status === 'PARTIAL').length;
  const succeeded = results.filter((r) => r.status === 'SUCCEEDED').length;
  if (failed === 0 && partial === 0) return 'SUCCEEDED';
  return succeeded > 0 || partial > 0 ? 'PARTIAL' : 'FAILED';
}

/**
 * Runs one execution: the actions of the rule that matched an event.
 *
 * Safe to run more than once. The result of every action is saved as soon as it is known, so a retry
 * (BullMQ, or a worker that died mid-run) skips what already finished and only repeats actions that
 * failed for a reason that could pass on a second try. Each action is itself idempotent
 * (notifications are unique per recipient and action), so even a repeat cannot double-notify.
 */
export async function processExecution(
  deps: ExecutorDeps,
  payload: AutomationJobPayload,
  options: { isFinalAttempt: boolean },
): Promise<ExecutionOutcome> {
  const { prisma, logger } = deps;
  const execution = await prisma.automationExecution.findFirst({
    where: { id: payload.executionId, organizationId: payload.organizationId },
    select: {
      id: true,
      status: true,
      eventType: true,
      results: true,
      startedAt: true,
      rule: { select: { id: true, name: true, enabled: true, actions: true } },
      event: { select: { facts: true } },
    },
  });
  if (!execution) return { status: 'skipped', reason: 'execution no longer exists' };
  if (TERMINAL.has(execution.status)) {
    return { status: 'skipped', reason: `already ${execution.status}` };
  }

  // An administrator who disables a rule expects it to stop, including runs already queued.
  if (!execution.rule.enabled) {
    await prisma.automationExecution.updateMany({
      where: { id: execution.id, organizationId: payload.organizationId },
      data: { status: 'SKIPPED', skipReason: 'rule_disabled', finishedAt: new Date() },
    });
    return { status: 'finished', result: 'SKIPPED' };
  }

  await prisma.automationExecution.updateMany({
    where: { id: execution.id, organizationId: payload.organizationId },
    data: {
      status: 'RUNNING',
      attempts: { increment: 1 },
      startedAt: execution.startedAt ?? new Date(),
    },
  });

  const parsedActions = automationActionListSchema.safeParse(execution.rule.actions);
  if (!parsedActions.success) {
    // Rules are validated on write, so this means the stored definition was tampered with or the
    // schema changed. Fail loudly and permanently rather than guessing.
    await finish(prisma, payload, execution.id, [], 'FAILED');
    logger.error('automation rule has an invalid definition', { ruleId: execution.rule.id });
    return { status: 'finished', result: 'FAILED' };
  }
  const actions = parsedActions.data;
  const previous = actionResultListSchema.safeParse(execution.results);
  const results: ActionResult[] = previous.success ? [...previous.data] : [];
  const facts = execution.event.facts as Facts;
  const trigger = execution.eventType as AutomationTrigger;

  for (let index = 0; index < actions.length; index += 1) {
    const done = results.find((r) => r.index === index);
    // Keep what finished; only a transient failure is worth another try.
    const unfinished = done && (done.status === 'FAILED' || done.status === 'PARTIAL');
    if (done && !(unfinished && done.retryable)) continue;

    const action = actions[index]!;
    const ctx: ActionContext = {
      prisma,
      logger,
      email: deps.email,
      webOrigin: deps.webOrigin,
      organizationId: payload.organizationId,
      executionId: execution.id,
      ruleName: execution.rule.name,
      trigger,
      facts,
      actionIndex: index,
    };

    let outcome: ActionOutcome;
    try {
      outcome = await runAction(deps, ctx, action);
    } catch (error) {
      // An unexpected error (a database blip) is worth retrying; the detail is deliberately vague.
      logger.error('automation action threw', {
        executionId: execution.id,
        actionIndex: index,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = { status: 'FAILED', detail: 'unexpected error', retryable: true };
    }

    const entry: ActionResult = {
      index,
      type: action.type,
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.retryable ? { retryable: true } : {}),
    };
    const at = results.findIndex((r) => r.index === index);
    if (at >= 0) results[at] = entry;
    else results.push(entry);
    await prisma.automationExecution.updateMany({
      where: { id: execution.id, organizationId: payload.organizationId },
      data: { results: results as never },
    });
  }

  const stillRetryable = results.some(
    (r) => (r.status === 'FAILED' || r.status === 'PARTIAL') && r.retryable,
  );
  if (stillRetryable && !options.isFinalAttempt) {
    throw new Error('a transient failure: the job will be retried'); // BullMQ retries; state is saved
  }

  const verdict = summarise(results);
  await finish(prisma, payload, execution.id, results, verdict, {
    ruleId: execution.rule.id,
    ruleName: execution.rule.name,
    facts,
    actions,
  });
  return { status: 'finished', result: verdict };
}

function runAction(
  deps: ExecutorDeps,
  ctx: ActionContext,
  action: AutomationAction,
): Promise<ActionOutcome> {
  if (action.type === 'notify') return runNotify(ctx, action);
  const handler = deps.handlers?.[action.type];
  if (!handler) {
    return Promise.resolve({
      status: 'FAILED',
      detail: `${action.type} actions are not available`,
    });
  }
  return (handler as (c: ActionContext, a: AutomationAction) => Promise<ActionOutcome>)(
    ctx,
    action,
  );
}

/**
 * Store the verdict and, when the run was about an incident, note it on the incident timeline in the
 * same transaction, so "what ran" and "what the incident shows" cannot disagree.
 */
async function finish(
  prisma: PrismaClient,
  payload: AutomationJobPayload,
  executionId: string,
  results: ActionResult[],
  verdict: ExecutionStatus,
  about?: { ruleId: string; ruleName: string; facts: Facts; actions: AutomationAction[] },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.automationExecution.updateMany({
      where: { id: executionId, organizationId: payload.organizationId },
      data: { status: verdict, results: results as never, finishedAt: new Date() },
    });
    const incidentId = typeof about?.facts.incidentId === 'string' ? about.facts.incidentId : null;
    if (!about || !incidentId) return;
    const incident = await tx.incident.findFirst({
      where: { id: incidentId, organizationId: payload.organizationId },
      select: { id: true },
    });
    if (!incident) return;
    await recordIncidentEvent(tx, {
      organizationId: payload.organizationId,
      incidentId,
      type: 'AUTOMATION_EXECUTED',
      actor: { type: 'AUTOMATION', id: null },
      data: {
        ruleId: about.ruleId,
        ruleName: about.ruleName,
        executionId,
        status: verdict,
        actions: about.actions.map((action) => action.type),
      },
    });
  });
}
