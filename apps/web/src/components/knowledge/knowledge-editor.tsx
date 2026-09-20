'use client';

import {
  KNOWLEDGE_LIMITS,
  createKnowledgeDocumentSchema,
  type KnowledgeDocumentDto,
} from '@nexus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { MarkdownView } from '@/components/knowledge/markdown-view';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const parseTags = (raw: string): string[] =>
  raw
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

/** Write a new document, or edit an existing one. */
export function KnowledgeEditor({
  orgId,
  document,
}: {
  orgId: string;
  document?: KnowledgeDocumentDto;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(document?.title ?? '');
  const [tags, setTags] = useState(document?.tags.join(', ') ?? '');
  const [content, setContent] = useState(document?.contentMd ?? '');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [errors, setErrors] = useState<Partial<Record<'title' | 'tags' | 'contentMd', string>>>({});

  const save = useMutation({
    mutationFn: (body: unknown) =>
      document
        ? apiFetch<KnowledgeDocumentDto>(`/orgs/${orgId}/knowledge/${document.id}`, {
            method: 'PATCH',
            body,
          })
        : apiFetch<KnowledgeDocumentDto>(`/orgs/${orgId}/knowledge`, { method: 'POST', body }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge', orgId] });
      await queryClient.invalidateQueries({ queryKey: ['incident-runbooks', orgId] });
      router.push(`/orgs/${orgId}/knowledge/${saved.id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createKnowledgeDocumentSchema.safeParse({
      title,
      contentMd: content,
      tags: parseTags(tags),
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === 'title' || field === 'tags' || field === 'contentMd') && !next[field]) {
          next[field] = issue.message;
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  const serverError = save.error;
  const tooLong = content.length > KNOWLEDGE_LIMITS.contentMax;

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <Field label="Title" htmlFor="doc-title" error={errors.title}>
        <Input
          id="doc-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={KNOWLEDGE_LIMITS.titleMax}
          aria-invalid={Boolean(errors.title)}
          placeholder="Checkout service restart runbook"
        />
      </Field>

      <Field
        label="Tags"
        htmlFor="doc-tags"
        error={errors.tags}
        hint="Separate with commas. Lowercase letters, numbers and hyphens."
      >
        <Input
          id="doc-tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          aria-invalid={Boolean(errors.tags)}
          placeholder="checkout, runbook, database"
        />
      </Field>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="doc-content" className="text-sm font-medium">
            Content
          </label>
          <div role="group" aria-label="Editor mode" className="flex gap-1 text-xs">
            {(['write', 'preview'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={tab === mode}
                onClick={() => setTab(mode)}
                className={cn(
                  'rounded-md px-2.5 py-1 capitalize',
                  tab === mode ? 'bg-white/10 text-foreground' : 'text-muted hover:bg-white/5',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        {tab === 'write' ? (
          <Textarea
            id="doc-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={18}
            className="font-mono text-[13px] leading-6"
            aria-invalid={Boolean(errors.contentMd) || tooLong}
            placeholder={'# When to use this\n\n## Steps\n1. …'}
          />
        ) : (
          <div
            aria-label="Preview"
            className="min-h-64 rounded-lg border border-border bg-surface p-4"
          >
            <MarkdownView source={content} />
          </div>
        )}
        <p className={cn('text-xs', tooLong ? 'text-danger' : 'text-muted')}>
          Markdown: headings, lists, code blocks, links. {content.length.toLocaleString()} /{' '}
          {KNOWLEDGE_LIMITS.contentMax.toLocaleString()} characters.
        </p>
        {errors.contentMd && (
          <p role="alert" className="text-xs text-danger">
            {errors.contentMd}
          </p>
        )}
      </div>

      {serverError && (
        <Alert>
          {serverError instanceof ApiError && serverError.details.length > 0
            ? serverError.details.map((d) => d.message).join(' ')
            : describeError(serverError)}
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          {document ? 'Save changes' : 'Create document'}
        </Button>
        <Link
          href={document ? `/orgs/${orgId}/knowledge/${document.id}` : `/orgs/${orgId}/knowledge`}
          className="text-sm text-muted hover:text-foreground"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
