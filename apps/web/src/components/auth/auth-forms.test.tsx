import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  search: new URLSearchParams(),
}));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }),
  useSearchParams: () => nav.search,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: api.apiFetch,
}));

import { ForgotPasswordForm } from './forgot-password-form';
import { LoginForm } from './login-form';
import { ResetPasswordForm } from './reset-password-form';

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = new URLSearchParams();
});

describe('LoginForm', () => {
  it('validates before calling the API', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findAllByText(/./, { selector: '[id$="-error"]' })).not.toHaveLength(0);
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('logs in and moves to the app', async () => {
    api.apiFetch.mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/'));
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { email: 'a@example.com', password: 'correct horse battery' },
    });
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('gives one generic message for bad credentials', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'nope'));
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password here');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('confirms a completed password reset', async () => {
    nav.search = new URLSearchParams('reset=1');
    render(<LoginForm />);
    expect(screen.getByText(/Your password was changed/)).toBeInTheDocument();
  });

  it('hides the sign-up link when sign-up is closed, and keeps password recovery', () => {
    render(<LoginForm registrationEnabled={false} />);
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toBeInTheDocument();
  });

  it('links to password recovery and registration', () => {
    render(<LoginForm />);
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    );
  });
});

describe('ForgotPasswordForm', () => {
  it('shows the same neutral confirmation whatever the API says about the account', async () => {
    api.apiFetch.mockResolvedValue({});
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.click(screen.getByRole('button'));
    expect(await screen.findByText(/If an account exists for someone@example.com/)).toBeVisible();
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'someone@example.com' },
    });
  });

  it('explains rate limiting', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'slow down'));
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.click(screen.getByRole('button'));
    expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
  });

  it('rejects a malformed address without calling the API', async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});

describe('ResetPasswordForm', () => {
  it('offers a new link when the URL carries no token', () => {
    render(<ResetPasswordForm token="" />);
    expect(screen.getByText(/not valid/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Send me a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('refuses mismatched passwords', async () => {
    const user = userEvent.setup();
    render(<ResetPasswordForm token="tok" />);
    await user.type(screen.getByLabelText('New password'), 'a long enough passphrase');
    await user.type(screen.getByLabelText('Confirm new password'), 'something different entirely');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('The passwords do not match')).toBeInTheDocument();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('sets the password with the token and sends the user to log in', async () => {
    api.apiFetch.mockResolvedValue({});
    const user = userEvent.setup();
    render(<ResetPasswordForm token="tok-123" />);
    await user.type(screen.getByLabelText('New password'), 'a long enough passphrase');
    await user.type(screen.getByLabelText('Confirm new password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?reset=1'));
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/reset-password', {
      method: 'POST',
      body: { token: 'tok-123', password: 'a long enough passphrase' },
    });
  });

  it('explains an invalid, used or expired link and offers another', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(400, 'INVALID_RESET_TOKEN', 'bad'));
    const user = userEvent.setup();
    render(<ResetPasswordForm token="tok" />);
    await user.type(screen.getByLabelText('New password'), 'a long enough passphrase');
    await user.type(screen.getByLabelText('Confirm new password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/invalid, has already been used, or has expired/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Send a new link' })).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
