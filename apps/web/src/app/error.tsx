'use client';

import { Button } from '@/components/ui/button';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-xs tracking-[0.3em] text-accent">NEXUS</p>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted">
        We could not load this page. The service may be starting up or temporarily unavailable.
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
