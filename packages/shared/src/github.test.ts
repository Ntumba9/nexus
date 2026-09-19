import { describe, expect, it } from 'vitest';
import {
  createGitHubIntegrationSchema,
  isHandledGitHubEvent,
  normaliseDeploymentStatus,
  repoFullNameSchema,
} from './github';

const event = (over: { state?: string; sha?: string; id?: number | string } = {}) => ({
  action: 'created',
  deployment_status: {
    state: over.state ?? 'success',
    created_at: '2026-09-20T10:05:00Z',
    description: 'Deployed',
  },
  deployment: {
    id: over.id ?? 4242,
    sha: over.sha ?? 'ABCDEF1234567890abcdef1234567890abcdef12',
    ref: 'main',
    environment: 'production',
    created_at: '2026-09-20T10:00:00Z',
    creator: { login: 'octocat' },
  },
  repository: { full_name: 'acme/storefront' },
  sender: { login: 'ignored' },
});

describe('normaliseDeploymentStatus', () => {
  it('maps a successful deployment', () => {
    const result = normaliseDeploymentStatus(event());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deployment).toMatchObject({
      externalId: '4242',
      repoFullName: 'acme/storefront',
      environment: 'production',
      ref: 'main',
      status: 'SUCCESS',
      author: 'octocat',
      commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    });
    expect(result.deployment.startedAt.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(result.deployment.statusAt.toISOString()).toBe('2026-09-20T10:05:00.000Z');
  });

  it.each([
    ['queued', 'PENDING'],
    ['pending', 'PENDING'],
    ['in_progress', 'IN_PROGRESS'],
    ['failure', 'FAILURE'],
    ['error', 'FAILURE'],
    ['inactive', 'INACTIVE'],
  ])('maps state %s to %s', (state, expected) => {
    const result = normaliseDeploymentStatus(event({ state }));
    expect(result.ok && result.deployment.status).toBe(expected);
  });

  it('accepts string deployment ids and rejects unknown states', () => {
    const ok = normaliseDeploymentStatus(event({ id: 'abc-1' }));
    expect(ok.ok && ok.deployment.externalId).toBe('abc-1');
    const bad = normaliseDeploymentStatus(event({ state: 'exploded' }));
    expect(bad).toEqual({ ok: false, reason: expect.stringContaining('unsupported') });
  });

  it.each([null, 'x', {}, { ...event(), repository: {} }, event({ sha: 'not-a-sha!' })])(
    'rejects malformed payloads without throwing',
    (payload) => {
      expect(normaliseDeploymentStatus(payload).ok).toBe(false);
    },
  );

  it('bounds the size of stored text fields', () => {
    const big = event();
    big.deployment_status.description = 'x'.repeat(5000);
    big.deployment.ref = 'y'.repeat(5000);
    const result = normaliseDeploymentStatus(big);
    expect(result.ok && result.deployment.description?.length).toBe(500);
    expect(result.ok && result.deployment.ref.length).toBe(250);
  });
});

describe('inputs', () => {
  it('validates repository names', () => {
    expect(repoFullNameSchema.safeParse('acme/storefront').success).toBe(true);
    for (const bad of ['acme', 'a/b/c', '/x', 'x/', 'ac me/x', 'https://github.com/a/b']) {
      expect(repoFullNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('requires a project and allows an optional service', () => {
    const projectId = '3f1c1f0e-6f0e-4d5e-9d64-0a6f2e2f9a10';
    const ok = createGitHubIntegrationSchema.safeParse({ repoFullName: 'a/b', projectId });
    expect(ok.success).toBe(true);
    expect(createGitHubIntegrationSchema.safeParse({ repoFullName: 'a/b' }).success).toBe(false);
  });

  it('knows which events it handles', () => {
    expect(isHandledGitHubEvent('deployment_status')).toBe(true);
    expect(isHandledGitHubEvent('ping')).toBe(true);
    expect(isHandledGitHubEvent('push')).toBe(false);
  });
});
