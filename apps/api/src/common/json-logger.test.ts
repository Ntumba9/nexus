import { describe, expect, it } from 'vitest';
import { JsonLogger } from './json-logger';
import { requestStore } from './request-store';

function capture(level = 'info') {
  const lines: { line: Record<string, unknown>; level: string }[] = [];
  const logger = new JsonLogger(level, { service: 'test' }, (line, lvl) =>
    lines.push({ line: JSON.parse(line) as Record<string, unknown>, level: lvl }),
  );
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('writes one JSON object per call with level, time, message, context and service', () => {
    const { logger, lines } = capture();
    logger.log('hello', 'Bootstrap');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toMatchObject({
      level: 'info',
      msg: 'hello',
      context: 'Bootstrap',
      service: 'test',
    });
    expect(new Date(lines[0]!.line.time as string).toString()).not.toBe('Invalid Date');
  });

  it('attaches the request id, person and organization of the request being served', () => {
    const { logger, lines } = capture();
    requestStore.run({ requestId: 'req-1', userId: 'user-1', organizationId: 'org-1' }, () =>
      logger.warn('inside'),
    );
    logger.warn('outside');
    expect(lines[0]!.line).toMatchObject({
      requestId: 'req-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(lines[1]!.line).not.toHaveProperty('requestId');
  });

  it('sees scope filled in later in the same request', () => {
    const { logger, lines } = capture();
    requestStore.run({ requestId: 'req-2' }, () => {
      requestStore.getStore()!.userId = 'late-user';
      logger.log('after guards');
    });
    expect(lines[0]!.line).toMatchObject({ requestId: 'req-2', userId: 'late-user' });
  });

  it('removes credentials from messages and stack traces', () => {
    const { logger, lines } = capture();
    logger.log(
      'connecting postgres://admin:hunter2pw@db/app with token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    logger.error(
      'failed with Bearer abcdef1234567890xyz',
      'Error: boom sk-live-abcdefghijklmnopqrstuv\n    at x',
      'Ctx',
    );
    const text = JSON.stringify(lines.map((l) => l.line));
    for (const secret of [
      'hunter2pw',
      'ghp_abcdefghijkl',
      'abcdef1234567890xyz',
      'sk-live-abcdefghij',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(lines[1]!.line).toHaveProperty('stack');
  });

  it('sends errors to stderr and everything else to stdout', () => {
    const { logger, lines } = capture();
    logger.log('a');
    logger.error('b');
    logger.warn('c');
    expect(lines.map((l) => l.level)).toEqual(['log', 'error', 'warn']);
  });

  it('honours the level threshold, including silent', () => {
    const warn = capture('warn');
    warn.logger.log('info hidden');
    warn.logger.debug('debug hidden');
    warn.logger.warn('shown');
    warn.logger.error('shown too');
    expect(warn.lines.map((l) => l.line.msg)).toEqual(['shown', 'shown too']);

    const silent = capture('silent');
    silent.logger.fatal('nothing');
    expect(silent.lines).toHaveLength(0);

    const debug = capture('debug');
    debug.logger.debug('shown');
    debug.logger.verbose('hidden');
    expect(debug.lines).toHaveLength(1);
  });

  it('copes with errors, objects and empty input', () => {
    const { logger, lines } = capture();
    logger.error(new Error('kaboom'));
    logger.log({ some: 'object' });
    expect(lines[0]!.line.msg).toBe('kaboom');
    expect(lines[1]!.line.msg).toBe('{"some":"object"}');
  });
});
