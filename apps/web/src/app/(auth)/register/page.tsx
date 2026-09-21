import { loadEnv, webEnvSchema } from '@nexus/config';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RegisterForm } from '@/components/auth/register-form';

export const metadata: Metadata = { title: 'Create account' };

export default function RegisterPage() {
  if (loadEnv(webEnvSchema).REGISTRATION_ENABLED !== 'true') {
    // The API refuses sign-ups too; this is only so a visitor is not shown a form that cannot work.
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sign-up is closed</h1>
        <p className="text-sm text-muted">This server is not accepting new accounts.</p>
        <p className="text-sm">
          <Link href="/login" className="text-accent hover:underline">
            Back to log in
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted">Then set up an organization for your team.</p>
      </header>
      <RegisterForm />
    </div>
  );
}
