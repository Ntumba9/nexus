import { loadEnv, webEnvSchema } from '@nexus/config';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { fetchApiStatus } from '@/lib/api-health';

export const metadata: Metadata = {
  title: 'Backend offline',
  // A page for a passing condition; it should never be what a search engine remembers.
  robots: { index: false, follow: false },
};

// The answer depends on whether the API is up right now.
export const dynamic = 'force-dynamic';

const REPOSITORY_URL = 'https://github.com/Ntumba9/nexus';

/**
 * Shown when the web app is running but the API behind it is not (a demo whose backend is switched
 * off, a host that is still waking up, a deploy in progress). It makes no API call that can fail the
 * page: it asks for the API's readiness, and once the API is healthy it sends the visitor on to the
 * app, so a page left open or bookmarked recovers by itself.
 */
export default async function OfflinePage() {
  const status = await fetchApiStatus(loadEnv(webEnvSchema).API_INTERNAL_URL);
  if (status.kind === 'report' && status.report.status === 'ok') redirect('/');

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="font-mono text-xs tracking-[0.3em] text-accent">NEXUS</p>
        <h1 className="text-2xl font-semibold tracking-tight">The backend is offline</h1>
        <p className="text-muted">
          You have reached the NEXUS web app, and it is running. The API and database it depends on
          are not reachable right now, so there is nothing to sign in to yet.
        </p>
      </header>

      <section aria-labelledby="what-heading" className="space-y-2 text-sm">
        <h2 id="what-heading" className="font-medium">
          What is NEXUS?
        </h2>
        <p className="text-muted">
          A developer operations and incident platform: services are monitored, outages open
          incidents, and the team investigates with runbooks, automation and an AI assistant that
          cites its evidence. The demo runs on a small hosted backend that is not always switched
          on.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a
          href="/"
          className="rounded-lg bg-accent px-4 py-2 font-medium text-black hover:opacity-90"
        >
          Try again
        </a>
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-border px-4 py-2 hover:bg-white/5"
        >
          View the source on GitHub
        </a>
      </div>

      {status.kind === 'unreachable' && (
        <p className="text-xs text-muted">Status: {status.reason}.</p>
      )}
    </main>
  );
}
