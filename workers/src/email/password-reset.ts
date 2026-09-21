import type { PrismaClient } from '@nexus/database';
import {
  EMAIL_JOBS,
  QUEUE_NAMES,
  passwordResetJobSchema,
  type PasswordResetJob,
} from '@nexus/shared';
import type { Job } from 'bullmq';
import { EmailError, type EmailSender } from '../automation/email';
import type { WorkerDefinition } from '../create-worker';
import type { Logger } from '../logger';

export interface PasswordResetDeps {
  prisma: PrismaClient;
  email: EmailSender;
  logger: Logger;
  /** Origin of the web app, for the link in the email. */
  webOrigin: string;
  /**
   * Development convenience: with the `log` transport nothing is really sent, so print the link.
   * Never true in production (see main.ts): a reset link in a log is a way into the account.
   */
  revealLinkInLogs: boolean;
}

export type PasswordResetOutcome = { status: 'sent' } | { status: 'skipped'; reason: string };

/**
 * Email a password-reset link. The address comes from the user's own record, looked up here from the
 * id, so a job can only ever reach the account it names and can never be pointed at another address.
 */
export async function processPasswordResetEmail(
  deps: PasswordResetDeps,
  job: PasswordResetJob,
): Promise<PasswordResetOutcome> {
  const user = await deps.prisma.user.findUnique({
    where: { id: job.userId },
    select: { email: true, name: true, disabledAt: true },
  });
  if (!user || user.disabledAt) return { status: 'skipped', reason: 'no active account' };

  const link = `${deps.webOrigin.replace(/\/+$/, '')}/reset-password?token=${job.token}`;
  try {
    await deps.email.send({
      to: user.email,
      subject: 'Reset your NEXUS password',
      text:
        `Someone asked to reset the password for your NEXUS account.\n\n` +
        `To choose a new password, open this link within the hour:\n${link}\n\n` +
        `If that was not you, ignore this message: your password has not changed. ` +
        `The link works once, and asking for another one cancels this one.\n`,
    });
  } catch (error) {
    // A transient failure is retried; a permanent one (a bad address) is not worth retrying.
    if (error instanceof EmailError && !error.retryable) {
      deps.logger.warn('password reset email could not be delivered', { userId: job.userId });
      return { status: 'skipped', reason: 'undeliverable' };
    }
    throw error;
  }
  if (deps.revealLinkInLogs) {
    deps.logger.info('password reset link (development only)', { to: user.email, link });
  }
  return { status: 'sent' };
}

export function emailWorker(
  deps: PasswordResetDeps,
  concurrency: number,
): WorkerDefinition<unknown, PasswordResetOutcome> {
  return {
    queue: QUEUE_NAMES.email,
    concurrency,
    async process(job: Job) {
      if (job.name !== EMAIL_JOBS.passwordReset) throw new Error(`Unknown email job: ${job.name}`);
      return processPasswordResetEmail(deps, passwordResetJobSchema.parse(job.data));
    },
  };
}
