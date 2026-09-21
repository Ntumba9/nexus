import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchApiStatus: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
vi.mock('@/lib/api-health', () => ({ fetchApiStatus: mocks.fetchApiStatus }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import OfflinePage from './page';

beforeEach(() => vi.clearAllMocks());

const report = (status: 'ok' | 'down') => ({
  kind: 'report' as const,
  report: { status, checks: {} },
});

describe('the offline page', () => {
  it('explains that the app is running but its backend is not, with a way to retry', async () => {
    mocks.fetchApiStatus.mockResolvedValue({
      kind: 'unreachable',
      reason: 'Could not reach the API',
    });
    render(await OfflinePage());
    expect(
      screen.getByRole('heading', { level: 1, name: 'The backend is offline' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/web app, and it is running/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/');
    expect(screen.getByText(/Could not reach the API/)).toBeInTheDocument();
  });

  it('links to the source, opening safely in a new tab', async () => {
    mocks.fetchApiStatus.mockResolvedValue({ kind: 'unreachable', reason: 'x' });
    render(await OfflinePage());
    const link = screen.getByRole('link', { name: /View the source on GitHub/ });
    expect(link).toHaveAttribute('href', 'https://github.com/Ntumba9/nexus');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('stays on the page when the API answers but a dependency is down', async () => {
    mocks.fetchApiStatus.mockResolvedValue(report('down'));
    render(await OfflinePage());
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('sends the visitor on to the app once the API is healthy again', async () => {
    mocks.fetchApiStatus.mockResolvedValue(report('ok'));
    await expect(OfflinePage()).rejects.toThrow('NEXT_REDIRECT:/');
  });
});
