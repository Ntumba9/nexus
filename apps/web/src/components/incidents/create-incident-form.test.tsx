import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const api = vi.hoisted(() => ({ apiFetch: vi.fn(), services: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: api.apiFetch,
}));
vi.mock('@/lib/queries', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/queries')>();
  return { ...original, fetchers: { ...original.fetchers, services: api.services } };
});

import { CreateIncidentForm } from './create-incident-form';

const ORG = 'org-1';
const SERVICE_ID = '3f0c7c1e-0000-4000-8000-000000000009';

function renderForm(onCancel = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CreateIncidentForm orgId={ORG} onCancel={onCancel} />
    </QueryClientProvider>,
  );
  return { ...view, onCancel, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.services.mockResolvedValue([
    { id: SERVICE_ID, name: 'checkout', projectName: 'Shop', environment: 'PRODUCTION' },
  ]);
});

describe('CreateIncidentForm', () => {
  it('lists services with their project and environment, plus a "none" choice', async () => {
    renderForm();
    expect(
      await screen.findByRole('option', { name: 'Shop / checkout (production)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'No specific service' })).toBeInTheDocument();
  });

  it('defaults to SEV-3 and offers every severity with its meaning', () => {
    renderForm();
    const select = screen.getByLabelText('Severity') as HTMLSelectElement;
    expect(select.value).toBe('SEV3');
    expect(select.options).toHaveLength(4);
  });

  it('will not open an incident without a title', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Open incident' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('creates the incident, splits tags on commas and spaces, and opens it', async () => {
    api.apiFetch.mockResolvedValue({ id: 'inc-42' });
    const user = userEvent.setup();
    renderForm();
    await screen.findByRole('option', { name: /checkout/ });
    await user.type(screen.getByLabelText('Title'), 'API latency spike');
    await user.selectOptions(screen.getByLabelText('Severity'), 'SEV1');
    await user.selectOptions(screen.getByLabelText('Affected service'), SERVICE_ID);
    await user.type(screen.getByLabelText('Description'), 'p99 is 4s');
    await user.type(screen.getByLabelText('Tags'), 'latency, api  checkout');
    await user.click(screen.getByRole('button', { name: 'Open incident' }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/orgs/${ORG}/incidents/inc-42`));
    expect(api.apiFetch).toHaveBeenCalledWith(`/orgs/${ORG}/incidents`, {
      method: 'POST',
      body: expect.objectContaining({
        title: 'API latency spike',
        severity: 'SEV1',
        serviceId: SERVICE_ID,
        description: 'p99 is 4s',
        tags: ['latency', 'api', 'checkout'],
      }),
    });
  });

  it('sends no service when none is chosen', async () => {
    api.apiFetch.mockResolvedValue({ id: 'inc-1' });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Title'), 'Something broke');
    await user.click(screen.getByRole('button', { name: 'Open incident' }));
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(api.apiFetch.mock.calls[0]![1].body.serviceId).toBeNull();
  });

  it('refreshes the incident list and dashboard after creating', async () => {
    api.apiFetch.mockResolvedValue({ id: 'inc-1' });
    const user = userEvent.setup();
    const { client } = renderForm();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await user.type(screen.getByLabelText('Title'), 'Something broke');
    await user.click(screen.getByRole('button', { name: 'Open incident' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const keysInvalidated = invalidate.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    );
    expect(keysInvalidated).toEqual(expect.arrayContaining(['incidents', 'dashboard']));
  });

  it('shows the API error and stays on the form', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'You cannot open incidents'));
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Title'), 'Something broke');
    await user.click(screen.getByRole('button', { name: 'Open incident' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('can be cancelled', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});
