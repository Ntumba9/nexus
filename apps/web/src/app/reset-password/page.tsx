import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password' };
// The token is in the query string: never cache or share this page.
export const dynamic = 'force-dynamic';

/**
 * Outside the (auth) group on purpose: someone who is already signed in and clicks the emailed link
 * must still reach it, not be sent to the dashboard.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <p className="text-center font-mono text-xs tracking-[0.3em] text-accent">NEXUS</p>
      <div className="space-y-6">
        <header className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
          <p className="text-sm text-muted">
            You will be signed out everywhere and asked to log in with it.
          </p>
        </header>
        <ResetPasswordForm token={typeof token === 'string' ? token : ''} />
      </div>
    </main>
  );
}
