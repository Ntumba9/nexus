import { describe, expect, it } from 'vitest';
import { readCookie } from './cookies';

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie('a=1; nexus_session=abc; b=2', 'nexus_session')).toBe('abc');
  });

  it('returns undefined when absent, empty header, or name only partially matches', () => {
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('', 'x')).toBeUndefined();
    expect(readCookie('xnexus_session=1', 'nexus_session')).toBeUndefined();
  });

  it('does not throw on malformed percent-encoding', () => {
    expect(readCookie('nexus_session=%E0%A4%A', 'nexus_session')).toBeUndefined();
  });

  it('keeps "=" characters inside the value', () => {
    expect(readCookie('t=a=b==', 't')).toBe('a=b==');
  });
});
