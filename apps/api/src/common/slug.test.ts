import { describe, expect, it } from 'vitest';
import { slugify } from './slug';

const VALID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('slugify', () => {
  it('lower-cases, strips accents and punctuation, and appends a random suffix', () => {
    expect(slugify('Ünïcode & Friends!')).toMatch(/^unicode-friends-[0-9a-f]{6}$/);
    expect(slugify('Payments API')).toMatch(/^payments-api-[0-9a-f]{6}$/);
  });

  it('always satisfies the database slug format, even for hostile input', () => {
    for (const input of [
      '',
      '   ',
      '---',
      '💥💥💥',
      "'; DROP TABLE x; --",
      'a'.repeat(500),
      '../../etc',
    ]) {
      const slug = slugify(input);
      expect(slug, input).toMatch(VALID);
      expect(slug.length).toBeGreaterThanOrEqual(3);
      expect(slug.length).toBeLessThanOrEqual(63);
    }
  });

  it('is not deterministic, so equal names do not collide', () => {
    expect(slugify('Same')).not.toBe(slugify('Same'));
  });
});
