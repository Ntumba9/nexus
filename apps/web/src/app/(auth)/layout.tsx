import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getMe } from '@/lib/server-api';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  // Already signed in? Skip the login/register screens.
  if (await getMe()) redirect('/');
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <p className="text-center font-mono text-xs tracking-[0.3em] text-accent">NEXUS</p>
      {children}
    </main>
  );
}
