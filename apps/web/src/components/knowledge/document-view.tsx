'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KnowledgeEditor } from '@/components/knowledge/knowledge-editor';
import { Tag } from '@/components/knowledge/knowledge-panel';
import { MarkdownView } from '@/components/knowledge/markdown-view';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';
import { timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';

/** One document, read-only, or in the editor. */
export function DocumentView({
  orgId,
  documentId,
  canManage,
  editing = false,
}: {
  orgId: string;
  documentId: string;
  canManage: boolean;
  editing?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const doc = useQuery({
    queryKey: keys.knowledgeDoc(orgId, documentId),
    queryFn: () => fetchers.knowledgeDoc(orgId, documentId),
  });
  const remove = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/orgs/${orgId}/knowledge/${documentId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: keys.knowledgeDoc(orgId, documentId) });
      await queryClient.invalidateQueries({ queryKey: ['knowledge', orgId] });
      await queryClient.invalidateQueries({ queryKey: ['incident-runbooks', orgId] });
      router.push(`/orgs/${orgId}/knowledge`);
    },
  });

  if (doc.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading document" className="space-y-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (doc.isError) {
    const notFound = doc.error instanceof ApiError && doc.error.status === 404;
    return (
      <div className="space-y-3">
        <Alert>
          {notFound
            ? 'This document does not exist, or you do not have access to it.'
            : describeError(doc.error)}
        </Alert>
        <Link href={`/orgs/${orgId}/knowledge`} className="text-sm text-accent">
          Back to the knowledge base
        </Link>
      </div>
    );
  }

  const data = doc.data;
  if (editing) {
    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Knowledge</p>
          <h1 className="text-2xl font-semibold tracking-tight">Edit document</h1>
        </header>
        <KnowledgeEditor orgId={orgId} document={data} />
      </div>
    );
  }

  const { chunks, embedded } = data.index;
  return (
    <article className="space-y-6">
      <header className="space-y-3">
        <Link
          href={`/orgs/${orgId}/knowledge`}
          className="text-xs text-muted hover:text-foreground"
        >
          ← Knowledge base
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{data.title}</h1>
          {canManage && (
            <div className="flex items-center gap-2">
              <Link href={`/orgs/${orgId}/knowledge/${data.id}/edit`}>
                <Button variant="secondary" size="sm">
                  Edit
                </Button>
              </Link>
              {confirming ? (
                <>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Delete for good
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    Keep it
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {data.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
          <span>
            Updated {timeAgo(data.updatedAt)}
            {data.updatedByName ? ` by ${data.updatedByName}` : ''}
          </span>
          {chunks > 0 && embedded < chunks && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
              Indexing {embedded}/{chunks}
            </span>
          )}
        </div>
        {remove.isError && <Alert>{describeError(remove.error)}</Alert>}
      </header>
      <MarkdownView source={data.contentMd} />
    </article>
  );
}
