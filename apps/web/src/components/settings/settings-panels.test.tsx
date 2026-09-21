import type { MemberDto } from '@nexus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: api.apiFetch,
}));

import { MembersPanel } from './members-panel';
import { SecurityPanel } from './security-panel';

const ORG = 'org-1';
const member = (over: Partial<MemberDto>): MemberDto => ({
  id: 'm1',
  userId: 'u1',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'DEVELOPER',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const MEMBERS = [
  member({ id: 'm1', userId: 'me', name: 'Me', email: 'me@example.com', role: 'ADMIN' }),
  member({ id: 'm2', userId: 'u2', name: 'Grace', email: 'grace@example.com', role: 'OWNER' }),
  member({ id: 'm3', userId: 'u3', name: 'Linus', email: 'linus@example.com', role: 'VIEWER' }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SecurityPanel', () => {
  async function fillPasswords(current: string, next: string, confirm: string) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Current password'), current);
    await user.type(screen.getByLabelText('New password'), next);
    await user.type(screen.getByLabelText('Confirm new password'), confirm);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    return user;
  }

  it('refuses a mismatched confirmation without calling the API', async () => {
    render(<SecurityPanel />);
    await fillPasswords('old passphrase here', 'a brand new passphrase', 'a different passphrase');
    expect(await screen.findByText('The passwords do not match')).toBeInTheDocument();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('refuses reusing the current password', async () => {
    render(<SecurityPanel />);
    await fillPasswords('same passphrase here', 'same passphrase here', 'same passphrase here');
    expect(await screen.findByText(/Choose a password you have not used/)).toBeInTheDocument();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('changes the password, confirms, and clears the fields', async () => {
    api.apiFetch.mockResolvedValue({});
    render(<SecurityPanel />);
    await fillPasswords('old passphrase here', 'a brand new passphrase', 'a brand new passphrase');
    expect(await screen.findByText(/Every other device has been signed out/)).toBeInTheDocument();
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/change-password', {
      method: 'POST',
      body: { currentPassword: 'old passphrase here', newPassword: 'a brand new passphrase' },
    });
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('says so when the current password is wrong', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'no'));
    render(<SecurityPanel />);
    await fillPasswords('wrong passphrase!!', 'a brand new passphrase', 'a brand new passphrase');
    expect(await screen.findByText('Your current password is not correct.')).toBeInTheDocument();
  });

  it('needs a second click before signing out everywhere, and can be cancelled', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel />);
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(api.apiFetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
  });

  it('signs out everywhere and returns to login', async () => {
    api.apiFetch.mockResolvedValue({});
    const user = userEvent.setup();
    render(<SecurityPanel />);
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await user.click(screen.getByRole('button', { name: 'Yes, sign me out everywhere' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login'));
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/logout-all', { method: 'POST' });
  });

  it('stays put and reports a failed sign-out', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'));
    const user = userEvent.setup();
    render(<SecurityPanel />);
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await user.click(screen.getByRole('button', { name: 'Yes, sign me out everywhere' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
  });
});

describe('MembersPanel', () => {
  function renderPanel(props: { myRole?: 'OWNER' | 'ADMIN'; canManage?: boolean } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MembersPanel
          orgId={ORG}
          myRole={props.myRole ?? 'ADMIN'}
          myUserId="me"
          canManage={props.canManage ?? true}
        />
      </QueryClientProvider>,
    );
  }
  const respond = (members: MemberDto[] = MEMBERS) =>
    api.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) =>
      !init?.method ? { data: members } : {},
    );

  it('lists members and marks the current user', async () => {
    respond();
    renderPanel();
    expect(await screen.findByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    expect(api.apiFetch).toHaveBeenCalledWith(`/orgs/${ORG}/members`);
  });

  it('shows an empty state and an error with retry', async () => {
    respond([]);
    const first = renderPanel();
    expect(await screen.findByText('No members')).toBeInTheDocument();
    first.unmount();

    api.apiFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'down'));
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    respond();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Grace')).toBeInTheDocument();
  });

  it('read-only for viewers: no role selects, no remove buttons, no add form', async () => {
    respond();
    renderPanel({ canManage: false });
    await screen.findByText('Grace');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.getByText(/Only owners and admins can manage members/)).toBeInTheDocument();
  });

  it('locks owners for an admin, and never offers the OWNER role to one', async () => {
    respond();
    renderPanel({ myRole: 'ADMIN' });
    await screen.findByText('Grace');
    expect(screen.queryByLabelText('Role for Grace')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Grace' })).not.toBeInTheDocument();
    const options = within(screen.getByLabelText('Role for Linus')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).not.toContain('OWNER');
  });

  it('lets an owner grant the OWNER role', async () => {
    respond();
    renderPanel({ myRole: 'OWNER' });
    await screen.findByText('Grace');
    const options = within(screen.getByLabelText('Role for Linus')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toContain('OWNER');
    expect(screen.getByLabelText('Role for Grace')).toBeInTheDocument();
  });

  it('changes a role with a PATCH and refreshes the list', async () => {
    respond();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Linus');
    await user.selectOptions(screen.getByLabelText('Role for Linus'), 'DEVELOPER');
    await waitFor(() =>
      expect(api.apiFetch).toHaveBeenCalledWith(`/orgs/${ORG}/members/m3`, {
        method: 'PATCH',
        body: { role: 'DEVELOPER' },
      }),
    );
  });

  it('asks for confirmation before removing, and cancelling removes nothing', async () => {
    respond();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Linus');
    await user.click(screen.getByRole('button', { name: 'Remove Linus' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.apiFetch).not.toHaveBeenCalledWith(expect.any(String), { method: 'DELETE' });

    await user.click(screen.getByRole('button', { name: 'Remove Linus' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.apiFetch).toHaveBeenCalledWith(`/orgs/${ORG}/members/m3`, { method: 'DELETE' }),
    );
  });

  it('shows the API error when a change is refused', async () => {
    api.apiFetch.mockImplementation(async (_p: string, init?: { method?: string }) => {
      if (!init?.method) return { data: MEMBERS };
      throw new ApiError(403, 'FORBIDDEN', 'You cannot change this role');
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Linus');
    await user.selectOptions(screen.getByLabelText('Role for Linus'), 'DEVELOPER');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('adds a member by email with the chosen role, then clears the field', async () => {
    respond();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Linus');
    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'SUPPORT');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(api.apiFetch).toHaveBeenCalledWith(`/orgs/${ORG}/members`, {
        method: 'POST',
        body: { email: 'new@example.com', role: 'SUPPORT' },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Email address')).toHaveValue(''));
  });

  it('keeps the typed email and shows the error when adding fails', async () => {
    api.apiFetch.mockImplementation(async (_p: string, init?: { method?: string }) => {
      if (!init?.method) return { data: MEMBERS };
      throw new ApiError(404, 'USER_NOT_FOUND', 'No such account');
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Linus');
    await user.type(screen.getByLabelText('Email address'), 'ghost@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('ghost@example.com');
  });
});
