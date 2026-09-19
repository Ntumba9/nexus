import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeGitHubSignature,
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  parseEncryptionKey,
  verifyGitHubSignature,
} from './webhook-security';

const body = Buffer.from('{"zen":"Keep it logically awesome."}');

describe('verifyGitHubSignature', () => {
  const secret = 's3cret';
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the correct signature', () => {
    expect(verifyGitHubSignature(secret, body, good)).toBe(true);
    expect(computeGitHubSignature(secret, body)).toBe(good);
  });

  it('rejects a wrong secret, a tampered body and a different signature', () => {
    expect(verifyGitHubSignature('other', body, good)).toBe(false);
    expect(verifyGitHubSignature(secret, Buffer.from('{"zen":"x"}'), good)).toBe(false);
    expect(verifyGitHubSignature(secret, body, good.slice(0, -1) + '0')).toBe(false);
  });

  it.each([undefined, '', 'sha256=', 'sha1=abc', good.slice(7), `${good}00`, 'sha256=zz'])(
    'rejects a missing or malformed header (%s) without throwing',
    (header) => {
      expect(verifyGitHubSignature(secret, body, header)).toBe(false);
    },
  );
});

describe('secret encryption', () => {
  const key = randomBytes(32);

  it('round-trips and never stores plaintext', () => {
    const stored = encryptSecret('hunter2', key, 'row-1');
    expect(stored).not.toContain('hunter2');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptSecret(stored, key, 'row-1')).toBe('hunter2');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret('x', key, 'a')).not.toBe(encryptSecret('x', key, 'a'));
  });

  it('fails when moved to another row, with another key, or tampered with', () => {
    const stored = encryptSecret('hunter2', key, 'row-1');
    expect(() => decryptSecret(stored, key, 'row-2')).toThrow();
    expect(() => decryptSecret(stored, randomBytes(32), 'row-1')).toThrow();
    const parts = stored.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join(':'), key, 'row-1')).toThrow();
    expect(() => decryptSecret('garbage', key, 'row-1')).toThrow();
  });

  it('validates the key length', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('base64')).length).toBe(32);
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow();
  });

  it('generates distinct 256-bit webhook secrets', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});
