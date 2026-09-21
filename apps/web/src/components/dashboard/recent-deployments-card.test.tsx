import type { DeploymentDto } from '@nexus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ deployments: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/queries', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/queries')>();
  return { ...original, fetchers: { ...original.fetchers, deployments: api.deployments } };
});

import { RecentDeploymentsCard } from './recent-deployments-card';

const ORG = 'org-1';
const deployment = (over: Partial<DeploymentDto>): DeploymentDto => ({
  id: 'd1',
  projectId: 'p1',
  serviceId: null,
  repoFullName: 'acme/storefront',
  environment: 'production',
  ref: 'main',
  commitSha: 'abc1234def5678',
  status: 'SUCCESS',
  author: 'ada',
  description: null,
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  deployedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  ...over,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecentDeploymentsCard orgId={ORG} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('RecentDeploymentsCard', () => {
  it('asks for only the few it shows, from the deployments endpoint', async () => {
    api.deployments.mockResolvedValue([]);
    renderCard();
    await screen.findByText(/No deployments yet/);
    expect(api.deployments).toHaveBeenCalledWith(ORG, undefined, 3);
  });

  it('points to Integrations when there are none, instead of promising a future feature', async () => {
    api.deployments.mockResolvedValue([]);
    renderCard();
    expect(await screen.findByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'href',
      `/orgs/${ORG}/integrations`,
    );
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('lists the latest deployments with commit, status and age, and links to all of them', async () => {
    api.deployments.mockResolvedValue([
      deployment({ id: 'd1' }),
      deployment({ id: 'd2', commitSha: '9999999aaaaaaa', status: 'FAILURE' }),
    ]);
    renderCard();
    expect(await screen.findByText('acme/storefront@abc1234')).toBeInTheDocument();
    expect(screen.getByText('acme/storefront@9999999')).toBeInTheDocument();
    expect(screen.getAllByText(/ago/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /View all deployments/ })).toHaveAttribute(
      'href',
      `/orgs/${ORG}/deployments`,
    );
  });

  it('never shows more than three, whatever the endpoint returns', async () => {
    api.deployments.mockResolvedValue(
      ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
        deployment({ id, commitSha: `${i}${i}${i}${i}${i}${i}${i}aaaa` }),
      ),
    );
    renderCard();
    await screen.findByText('acme/storefront@0000000');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('says so when they cannot be loaded, without breaking the dashboard', async () => {
    api.deployments.mockRejectedValue(new Error('boom'));
    renderCard();
    expect(await screen.findByText('Deployments could not be loaded.')).toBeInTheDocument();
  });
});
