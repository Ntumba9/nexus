import type { PrismaClient } from '@nexus/database';
import { EMAIL_JOBS } from '@nexus/shared';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { EmailError, type EmailSender } from '../automation/email';
import type { Logger } from '../logger';
import { emailWorker, processPasswordResetEmail, type PasswordResetDeps } from './password-reset';

const TOKEN = 'a'.repeat(43);
const job = { userId: '3f0c7c1e-0000-4000-8000-000000000001', token: TOKEN };
const activeUser = { email: 'a@example.com', name: 'A', disabledAt: null };

function setup(
  options: {
    user?: { email: string; name: string; disabledAt: Date | null } | null;
    send?: EmailSender['send'];
    revealLinkInLogs?: boolean;
    webOrigin?: string;
  } = {},
) {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const findUnique = vi
    .fn()
    .mockResolvedValue(options.user === undefined ? activeUser : options.user);
  const send = vi.fn(options.send ?? (async () => undefined));
  const deps: PasswordResetDeps = {
    prisma: { user: { findUnique } } as unknown as PrismaClient,
    email: { send },
    logger,
    webOrigin: options.webOrigin ?? 'https://nexus.example.com',
    revealLinkInLogs: options.revealLinkInLogs ?? false,
  };
  return { deps, logger, findUnique, send };
}

describe('processPasswordResetEmail', () => {
  it('sends the link to the address on the account, looked up from the id', async () => {
    const { deps, send, findUnique } = setup();
    expect(await processPasswordResetEmail(deps, job)).toEqual({ status: 'sent' });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: job.userId } }));
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe('a@example.com');
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text).toContain(`https://nexus.example.com/reset-password?token=${TOKEN}`);
  });

  it('does not double the slash when the origin has a trailing one', async () => {
    const { deps, send } = setup({ webOrigin: 'https://nexus.example.com//' });
    await processPasswordResetEmail(deps, job);
    expect(send.mock.calls[0]![0].text).toContain('https://nexus.example.com/reset-password?');
  });

  it.each([
    ['missing', null],
    ['disabled', { ...activeUser, disabledAt: new Date() }],
  ])('sends nothing for a %s account', async (_label, user) => {
    const { deps, send } = setup({ user });
    expect(await processPasswordResetEmail(deps, job)).toEqual({
      status: 'skipped',
      reason: 'no active account',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('gives up on a permanent delivery failure without logging the address', async () => {
    const { deps, logger } = setup({
      send: async () => {
        throw new EmailError('mailbox does not exist', false);
      },
    });
    expect(await processPasswordResetEmail(deps, job)).toEqual({
      status: 'skipped',
      reason: 'undeliverable',
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('a@example.com');
  });

  it('rethrows transient and unexpected failures so the queue retries', async () => {
    const transient = setup({
      send: async () => {
        throw new EmailError('timeout', true);
      },
    });
    await expect(processPasswordResetEmail(transient.deps, job)).rejects.toThrow('timeout');
    const unexpected = setup({
      send: async () => {
        throw new TypeError('boom');
      },
    });
    await expect(processPasswordResetEmail(unexpected.deps, job)).rejects.toThrow('boom');
  });

  it('prints the link only when explicitly allowed', async () => {
    const off = setup({ revealLinkInLogs: false });
    await processPasswordResetEmail(off.deps, job);
    expect(JSON.stringify(vi.mocked(off.logger.info).mock.calls)).not.toContain(TOKEN);

    const on = setup({ revealLinkInLogs: true });
    await processPasswordResetEmail(on.deps, job);
    expect(JSON.stringify(vi.mocked(on.logger.info).mock.calls)).toContain(TOKEN);
  });
});

describe('emailWorker', () => {
  it('rejects unknown job names and malformed payloads', async () => {
    const { deps } = setup();
    const worker = emailWorker(deps, 2);
    expect(worker.concurrency).toBe(2);
    await expect(worker.process({ name: 'other', data: job } as Job)).rejects.toThrow(
      'Unknown email job',
    );
    await expect(
      worker.process({ name: EMAIL_JOBS.passwordReset, data: { userId: 'nope' } } as Job),
    ).rejects.toThrow();
  });

  it('processes a valid password-reset job', async () => {
    const { deps, send } = setup();
    const worker = emailWorker(deps, 1);
    const result = await worker.process({ name: EMAIL_JOBS.passwordReset, data: job } as Job);
    expect(result).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledOnce();
  });
});
