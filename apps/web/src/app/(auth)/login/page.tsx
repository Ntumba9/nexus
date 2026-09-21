import { loadEnv, webEnvSchema } from '@nexus/config';
import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = { title: 'Log in' };

export default function LoginPage() {
  const env = loadEnv(webEnvSchema);
  const demo =
    env.DEMO_LOGIN_EMAIL && env.DEMO_LOGIN_PASSWORD
      ? { email: env.DEMO_LOGIN_EMAIL, password: env.DEMO_LOGIN_PASSWORD }
      : null;
  return (
    <div className="space-y-6">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted">Log in to your NEXUS account.</p>
      </header>
      {demo && (
        <aside
          aria-label="Demo account"
          className="space-y-1 rounded-lg border border-border bg-surface p-4 text-sm"
        >
          <p className="font-medium">Try the demo</p>
          <p className="text-muted">A read-only account on a sample organization. Sign in with:</p>
          <p>
            <span className="text-muted">Email </span>
            <code className="font-mono">{demo.email}</code>
          </p>
          <p>
            <span className="text-muted">Password </span>
            <code className="font-mono">{demo.password}</code>
          </p>
        </aside>
      )}
      <LoginForm registrationEnabled={env.REGISTRATION_ENABLED === 'true'} />
    </div>
  );
}
