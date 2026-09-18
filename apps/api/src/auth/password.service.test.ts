import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an Argon2id PHC string that does not contain the password', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse');
  });

  it('salts: hashing the same password twice gives different hashes', async () => {
    const [a, b] = await Promise.all([
      service.hash('same password 123'),
      service.hash('same password 123'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(await service.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await service.verify(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('returns false for malformed stored hashes instead of throwing', async () => {
    expect(await service.verify('not-a-hash', 'whatever')).toBe(false);
    expect(await service.verify('', 'whatever')).toBe(false);
  });

  it('verifyOrDummy always fails when there is no stored hash', async () => {
    expect(await service.verifyOrDummy(undefined, 'anything at all')).toBe(false);
  });

  it('handles unicode and long passwords', async () => {
    const password = 'pässwörd-🔐-'.repeat(8);
    const hash = await service.hash(password);
    expect(await service.verify(hash, password)).toBe(true);
  });
});
