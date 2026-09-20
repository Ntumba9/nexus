'use client';

import type { KnowledgeDocumentSummaryDto, KnowledgeSearchHitDto } from '@nexus/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Highlight } from '@/components/knowledge/markdown-view';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { describeError } from '@/lib/api-client';
import { timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** How a hit was found, in words a person would use. */
export function matchLabel(matchedBy: KnowledgeSearchHitDto['matchedBy']): string {
  if (matchedBy.length === 2) return 'Keyword + meaning';
  return matchedBy[0] === 'semantic' ? 'Similar meaning' : 'Keyword';
}

export function Tag({ children }: { children: string }) {
  return (
    <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {children}
    </span>
  );
}

/** The knowledge base: search it, or browse its documents. */
export function KnowledgePanel({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | undefined>();

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const searching = query.length > 0;
  const docs = useQuery({
    queryKey: keys.knowledge(orgId, tag),
    queryFn: () => fetchers.knowledge(orgId, tag),
    enabled: !searching,
  });
  const results = useQuery({
    queryKey: keys.knowledgeSearch(orgId, query),
    queryFn: () => fetchers.knowledgeSearch(orgId, query),
    enabled: searching,
    staleTime: 30_000,
  });
  const allDocs = useQuery({
    queryKey: keys.knowledge(orgId),
    queryFn: () => fetchers.knowledge(orgId),
    enabled: !searching,
  });
  const tags = [...new Set((allDocs.data ?? []).flatMap((doc) => doc.tags))].sort();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1">
          <label htmlFor="knowledge-search" className="sr-only">
            Search the knowledge base
          </label>
          <Input
            id="knowledge-search"
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search runbooks: “how do I restart checkout?”"
            maxLength={300}
            autoComplete="off"
          />
        </div>
        {canManage && (
          <Link href={`/orgs/${orgId}/knowledge/new`}>
            <Button>New document</Button>
          </Link>
        )}
      </div>

      {searching ? (
        <SearchResults orgId={orgId} query={query} state={results} />
      ) : (
        <>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
              {[undefined, ...tags].map((t) => (
                <button
                  key={t ?? 'all'}
                  type="button"
                  aria-pressed={tag === t}
                  onClick={() => setTag(t)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition',
                    tag === t
                      ? 'border-accent bg-accent/15 text-foreground'
                      : 'border-border text-muted hover:bg-white/5',
                  )}
                >
                  {t ?? 'All'}
                </button>
              ))}
            </div>
          )}
          <DocumentList orgId={orgId} state={docs} canManage={canManage} />
        </>
      )}
    </div>
  );
}

function SearchResults({
  orgId,
  query,
  state,
}: {
  orgId: string;
  query: string;
  state: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchers.knowledgeSearch>>>>;
}) {
  if (state.isPending) {
    return (
      <div aria-busy="true" aria-label="Searching" className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (state.isError) return <Alert>{describeError(state.error)}</Alert>;
  const { data, mode } = state.data;
  return (
    <div className="space-y-3">
      {mode === 'keyword' && (
        <Alert tone="success">
          Showing keyword matches only. Meaning-based search is not available right now.
        </Alert>
      )}
      {data.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description={`No document mentions “${query}”. Try fewer or different words.`}
        />
      ) : (
        <ul aria-label="Search results" className="space-y-3">
          {data.map((hit) => (
            <li key={hit.documentId} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/orgs/${orgId}/knowledge/${hit.documentId}`}
                  className="font-medium hover:underline"
                >
                  <Highlight text={hit.title} query={query} />
                </Link>
                <span className="font-mono text-[11px] text-muted">
                  {matchLabel(hit.matchedBy)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">{hit.heading}</p>
              <p className="mt-2 text-sm text-foreground/90">
                <Highlight text={hit.snippet} query={query} />
              </p>
              {hit.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {hit.tags.map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IndexBadge({ doc }: { doc: KnowledgeDocumentSummaryDto }) {
  const { chunks, embedded } = doc.index;
  if (chunks === 0 || embedded >= chunks) return null;
  return (
    <span
      title="Keyword search already finds this document; meaning-based search will include it shortly."
      className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-muted"
    >
      Indexing {embedded}/{chunks}
    </span>
  );
}

function DocumentList({
  orgId,
  state,
  canManage,
}: {
  orgId: string;
  state: ReturnType<typeof useQuery<KnowledgeDocumentSummaryDto[]>>;
  canManage: boolean;
}) {
  if (state.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading documents" className="space-y-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (state.isError) {
    return (
      <div className="space-y-3">
        <Alert>{describeError(state.error)}</Alert>
        <Button variant="secondary" onClick={() => state.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (state.data.length === 0) {
    return (
      <EmptyState
        title="No documents yet"
        description="Runbooks, postmortems and how-tos live here. They are searchable, and relevant ones are suggested on incidents."
        action={
          canManage ? (
            <Link href={`/orgs/${orgId}/knowledge/new`}>
              <Button>Write the first document</Button>
            </Link>
          ) : undefined
        }
      />
    );
  }
  return (
    <ul aria-label="Documents" className="divide-y divide-border rounded-xl border border-border">
      {state.data.map((doc) => (
        <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 space-y-1">
            <Link
              href={`/orgs/${orgId}/knowledge/${doc.id}`}
              className="font-medium hover:underline"
            >
              {doc.title}
            </Link>
            <div className="flex flex-wrap items-center gap-1.5">
              {doc.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
              <IndexBadge doc={doc} />
            </div>
          </div>
          <p className="text-xs text-muted">
            Updated {timeAgo(doc.updatedAt)}
            {doc.updatedByName ? ` by ${doc.updatedByName}` : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}
