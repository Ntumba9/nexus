import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { processSystemJob } from './system';

const job = (name: string, data: unknown) => ({ name, data }) as Job;

describe('processSystemJob', () => {
  it('echoes the nonce with a processing timestamp', async () => {
    const result = await processSystemJob(job('ping', { nonce: 'abc' }));
    expect(result.nonce).toBe('abc');
    expect(Number.isNaN(Date.parse(result.processedAt))).toBe(false);
  });

  it('rejects malformed payloads', async () => {
    await expect(processSystemJob(job('ping', { nonce: '' }))).rejects.toThrow();
    await expect(processSystemJob(job('ping', undefined))).rejects.toThrow();
  });

  it('rejects unknown job names', async () => {
    await expect(processSystemJob(job('nope', { nonce: 'abc' }))).rejects.toThrow(
      /Unknown system job/,
    );
  });
});
