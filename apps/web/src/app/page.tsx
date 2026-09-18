import { loadEnv, webEnvSchema } from '@nexus/config';
import { fetchApiStatus } from '@/lib/api-health';
import { cn } from '@/lib/utils';

// Status must reflect the live system, never a build-time snapshot.
export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = { postgres: 'PostgreSQL', redis: 'Redis' };

export default async function HomePage() {
  const env = loadEnv(webEnvSchema);
  const status = await fetchApiStatus(env.API_INTERNAL_URL);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-10 px-6 py-16">
      <header className="space-y-3">
        <p className="font-mono text-xs tracking-[0.3em] text-accent">NEXUS</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Developer operations &amp; incident intelligence
        </h1>
        <p className="text-muted">
          Foundation build. Authentication, incidents and monitoring arrive in later phases.
        </p>
      </header>

      <section
        aria-labelledby="status-heading"
        className="rounded-xl border border-border bg-surface"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="status-heading" className="text-sm font-medium">
            Platform status
          </h2>
          <StatusPill ok={status.kind === 'report' && status.report.status === 'ok'} />
        </div>

        {status.kind === 'unreachable' ? (
          <p role="alert" className="px-5 py-4 text-sm text-danger">
            {status.reason}. Check that the API is running and{' '}
            <code className="font-mono">API_INTERNAL_URL</code> is correct.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {Object.entries(status.report.checks).map(([name, check]) => (
              <li key={name} className="flex items-center justify-between px-5 py-3 text-sm">
                <span>{LABELS[name] ?? name}</span>
                <span className="flex items-center gap-3 font-mono text-xs text-muted">
                  {check.status === 'up' ? `${check.latencyMs} ms` : check.error}
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 rounded-full',
                      check.status === 'up' ? 'bg-success' : 'bg-danger',
                    )}
                  />
                  <span className="sr-only">{check.status}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 font-mono text-xs',
        ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
      )}
    >
      {ok ? 'operational' : 'degraded'}
    </span>
  );
}
