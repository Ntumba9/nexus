'use client';

import {
  SOURCE_KIND_LABEL,
  type ContextSource,
  type InvestigationDto,
  type InvestigationOutput,
} from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';
import { timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { pollEvery } from '@/lib/realtime';
import { cn } from '@/lib/utils';

const isActive = (run: InvestigationDto) => run.status === 'QUEUED' || run.status === 'RUNNING';

const CONFIDENCE_TONE = {
  low: 'bg-white/5 text-muted',
  medium: 'bg-amber-400/15 text-amber-300',
  high: 'bg-emerald-400/15 text-emerald-300',
} as const;

function Badge({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 font-mono text-[11px]', className)}>{children}</span>
  );
}

/** Ask for an investigation of this incident, and read what came back (and what it was based on). */
export function AiInvestigation({
  orgId,
  incidentId,
  canRun,
}: {
  orgId: string;
  incidentId: string;
  canRun: boolean;
}) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState('');
  const [openSource, setOpenSource] = useState<string | null>(null);

  const status = useQuery({
    queryKey: keys.aiStatus(orgId),
    queryFn: () => fetchers.aiStatus(orgId),
    staleTime: 5 * 60_000,
  });
  const runs = useQuery({
    queryKey: keys.investigations(orgId, incidentId),
    queryFn: () => fetchers.investigations(orgId, incidentId),
    // While one is running, look often; otherwise the live stream tells us.
    refetchInterval: (query) =>
      (query.state.data ?? []).some(isActive) ? 2_500 : pollEvery(30_000)(),
  });

  const start = useMutation({
    mutationFn: () =>
      apiFetch<InvestigationDto>(`/orgs/${orgId}/incidents/${incidentId}/investigations`, {
        method: 'POST',
        body: question.trim() ? { question: question.trim() } : {},
      }),
    onSuccess: async () => {
      setQuestion('');
      setOpenSource(null);
      await queryClient.invalidateQueries({ queryKey: keys.investigations(orgId, incidentId) });
    },
  });

  const list = runs.data ?? [];
  const latest = list[0];
  const running = list.some(isActive);
  const available = status.data?.available ?? false;
  const canStart = canRun && available && !running;

  return (
    <Card
      title="Investigation"
      description="Looks at this incident's timeline, recent deployments, health checks, earlier incidents and runbooks, and cites what it used."
    >
      <div className="space-y-4">
        {status.data && (
          <p className="text-xs text-muted">
            {status.data.available ? (
              <>
                Analysis by <span className="text-foreground">{status.data.label}</span>
                {status.data.kind === 'rules' &&
                  '. It is a fixed set of rules over the evidence, not a language model.'}
              </>
            ) : (
              status.data.label
            )}
          </p>
        )}

        {canRun && available && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (canStart) start.mutate();
            }}
          >
            <div className="min-w-48 flex-1">
              <label htmlFor="investigation-question" className="sr-only">
                Question for the investigation (optional)
              </label>
              <Input
                id="investigation-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={500}
                placeholder="Optional: what should it focus on?"
                disabled={!canStart}
              />
            </div>
            <Button type="submit" loading={start.isPending || running} disabled={!canStart}>
              {running ? 'Investigating…' : latest ? 'Investigate again' : 'Investigate'}
            </Button>
          </form>
        )}
        {!canRun && (
          <p className="text-xs text-muted">Only people who can update incidents can start one.</p>
        )}

        {start.isError && (
          <Alert>
            {start.error instanceof ApiError && start.error.status === 429
              ? 'You have started too many investigations this hour. Try again later.'
              : describeError(start.error)}
          </Alert>
        )}

        {runs.isPending ? (
          <Skeleton className="h-24" />
        ) : runs.isError ? (
          <p className="text-sm text-muted">Investigations could not be loaded.</p>
        ) : !latest ? (
          <p className="text-sm text-muted">No investigation has been run for this incident yet.</p>
        ) : (
          <Run
            orgId={orgId}
            run={latest}
            openSource={openSource}
            onOpenSource={(label) => setOpenSource((current) => (current === label ? null : label))}
          />
        )}

        {list.length > 1 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted hover:text-foreground">
              Earlier investigations ({list.length - 1})
            </summary>
            <ul className="mt-2 space-y-2">
              {list.slice(1).map((run) => (
                <li key={run.id} className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted">
                    {timeAgo(run.createdAt)} · {run.status.toLowerCase()} · {run.providerLabel}
                  </p>
                  {run.output && <p className="mt-1">{run.output.summary}</p>}
                  {run.error && <p className="mt-1 text-danger">{run.error}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

function Run({
  orgId,
  run,
  openSource,
  onOpenSource,
}: {
  orgId: string;
  run: InvestigationDto;
  openSource: string | null;
  onOpenSource: (label: string) => void;
}) {
  if (isActive(run)) {
    return (
      <div aria-live="polite" className="space-y-2">
        <p className="text-sm">
          {run.status === 'QUEUED' ? 'Waiting for a worker…' : 'Reading the evidence…'}
        </p>
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (run.status === 'FAILED' || !run.output) {
    return (
      <Alert>
        The investigation did not finish{run.error ? `: ${run.error}` : ''}. You can run it again.
      </Alert>
    );
  }
  const bySource = new Map(run.sources.map((s) => [s.label, s]));
  const opened = openSource ? bySource.get(openSource) : undefined;

  return (
    <div className="space-y-5" aria-label="Investigation result">
      <Result output={run.output} onCite={onOpenSource} openSource={openSource} run={run} />
      {opened && <SourceView orgId={orgId} source={opened} />}
      <Notes run={run} />
      <p className="text-xs text-muted">
        {run.requestedByName ? `Requested by ${run.requestedByName}, ` : ''}
        {timeAgo(run.createdAt)} · {run.providerLabel} · {run.sources.length} sources read
      </p>
    </div>
  );
}

function Citations({
  labels,
  onCite,
  openSource,
}: {
  labels: string[];
  onCite: (label: string) => void;
  openSource: string | null;
}) {
  if (labels.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          aria-pressed={openSource === label}
          aria-label={`Show source ${label}`}
          onClick={() => onCite(label)}
          className={cn(
            'rounded border px-1 font-mono text-[11px] transition',
            openSource === label
              ? 'border-accent bg-accent/15 text-foreground'
              : 'border-border text-muted hover:bg-white/5',
          )}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function Result({
  output,
  onCite,
  openSource,
  run,
}: {
  output: InvestigationOutput;
  onCite: (label: string) => void;
  openSource: string | null;
  run: InvestigationDto;
}) {
  const cite = { onCite, openSource };
  return (
    <>
      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Summary</h3>
          <Badge className={CONFIDENCE_TONE[output.confidence]}>
            {`${output.confidence} confidence`}
          </Badge>
        </div>
        <p className="text-sm leading-6">{output.summary}</p>
      </section>

      {output.possibleCauses.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Possible causes</h3>
          <ul className="space-y-2">
            {output.possibleCauses.map((cause, i) => (
              <li key={i} className="rounded-lg border border-border p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge
                    className={
                      cause.kind === 'evidence'
                        ? 'bg-emerald-400/15 text-emerald-300'
                        : 'bg-amber-400/15 text-amber-300'
                    }
                  >
                    {cause.kind === 'evidence' ? 'Backed by sources' : 'Inference'}
                  </Badge>
                  <Badge className={CONFIDENCE_TONE[cause.confidence]}>{cause.confidence}</Badge>
                </div>
                {cause.description}
                <Citations labels={cause.sources} {...cite} />
                {cause.kind === 'inference' && (
                  <p className="mt-1 text-xs text-muted">
                    This is reasoning, not something the sources state.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {output.evidence.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Evidence</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            {output.evidence.map((item, i) => (
              <li key={i}>
                {item.statement}
                <Citations labels={item.sources} {...cite} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {output.recommendedInvestigations.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">What to look at next</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {output.recommendedInvestigations.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </section>
      )}

      {output.recommendedActions.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            Suggestions{' '}
            <span className="font-normal text-muted">(advisory, NEXUS runs none of these)</span>
          </h3>
          <ul className="space-y-1.5 text-sm">
            {output.recommendedActions.map((action, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge className={CONFIDENCE_TONE[action.risk]}>{`${action.risk} risk`}</Badge>
                <span>{action.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.question && (
        <p className="text-xs text-muted">
          You asked: <span className="text-foreground">{run.question}</span>
        </p>
      )}
    </>
  );
}

/** What a cited source actually said, exactly as the analysis saw it. */
function SourceView({ orgId, source }: { orgId: string; source: ContextSource }) {
  const href =
    source.kind === 'knowledge' && source.refId
      ? `/orgs/${orgId}/knowledge/${source.refId}`
      : source.kind === 'previous_incident' && source.refId
        ? `/orgs/${orgId}/incidents/${source.refId}`
        : null;
  return (
    <aside
      aria-label={`Source ${source.label}`}
      className="space-y-1 rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm"
    >
      <p className="font-mono text-[11px] text-muted">
        {source.label} · {SOURCE_KIND_LABEL[source.kind]}
        {source.occurredAt ? ` · ${new Date(source.occurredAt).toLocaleString()}` : ''}
      </p>
      <p className="font-medium">{source.title}</p>
      {/* Rendered as text: React escapes it, so a source can never inject markup. */}
      <p className="whitespace-pre-wrap text-xs leading-5 text-foreground/90">{source.text}</p>
      {href && (
        <Link href={href} className="text-xs text-accent">
          Open the original
        </Link>
      )}
    </aside>
  );
}

function Notes({ run }: { run: InvestigationDto }) {
  const notes: string[] = [];
  if (run.droppedCitations > 0) {
    notes.push(
      `${run.droppedCitations} citation${run.droppedCitations === 1 ? '' : 's'} named a source that was not provided and ${run.droppedCitations === 1 ? 'was' : 'were'} removed.`,
    );
  }
  if (run.droppedClaims > 0) {
    notes.push(
      `${run.droppedClaims} statement${run.droppedClaims === 1 ? '' : 's'} with no valid source ${run.droppedClaims === 1 ? 'was' : 'were'} left out.`,
    );
  }
  if (run.downgradedCauses > 0) {
    notes.push(
      `${run.downgradedCauses} cause${run.downgradedCauses === 1 ? '' : 's'} claimed as evidence had no valid source and ${run.downgradedCauses === 1 ? 'is' : 'are'} shown as inference.`,
    );
  }
  if (run.truncated) notes.push('Some older material was left out to fit the size limit.');
  if (notes.length === 0) return null;
  return (
    <ul aria-label="Verification notes" className="space-y-0.5 text-xs text-muted">
      {notes.map((note) => (
        <li key={note}>· {note}</li>
      ))}
    </ul>
  );
}
