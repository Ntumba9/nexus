import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, systemPingPayloadSchema } from './index';

describe('queue contracts', () => {
  it('exposes the system queue', () => {
    expect(QUEUE_NAMES.system).toBe('system');
  });

  it('rejects empty or oversized nonces', () => {
    expect(systemPingPayloadSchema.safeParse({ nonce: '' }).success).toBe(false);
    expect(systemPingPayloadSchema.safeParse({ nonce: 'x'.repeat(65) }).success).toBe(false);
    expect(systemPingPayloadSchema.safeParse({ nonce: 'abc' }).success).toBe(true);
  });
});
