'use client';

import {
  createOutboundWebhookSchema,
  type CreatedOutboundWebhookDto,
  type OutboundWebhookDto,
} from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';
import { fetchers, keys } from '@/lib/queries';

/** Destinations for the "call a webhook" action. */
export function OutboundWebhooksPanel({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedOutboundWebhookDto | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const webhooks = useQuery({
    queryKey: keys.webhooks(orgId),
    queryFn: () => fetchers.webhooks(orgId),
  });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch<CreatedOutboundWebhookDto>(`/orgs/${orgId}/outbound-webhooks`, {
        method: 'POST',
        body,
      }),
    onSuccess: async (result) => {
      setName('');
      setUrl('');
      await queryClient.invalidateQueries({ queryKey: keys.webhooks(orgId) });
      setCreated(result);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createOutboundWebhookSchema.safeParse({ name, url });
    if (!parsed.success) {
      setFieldError('Enter a name and the URL to call.');
      return;
    }
    setFieldError(null);
    create.mutate(parsed.data);
  }

  return (
    <Card
      title="Outbound webhooks"
      description="Destinations that automation rules can call. Each call is signed so the receiver can verify it came from NEXUS."
    >
      <div className="space-y-6">
        {created && <Reveal created={created} onDismiss={() => setCreated(null)} />}

        <form
          onSubmit={submit}
          noValidate
          aria-label="Add an outbound webhook"
          className="space-y-4"
        >
          {create.isError && <Alert>{describeError(create.error)}</Alert>}
          {fieldError && <Alert>{fieldError}</Alert>}
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
            <Field label="Webhook name" htmlFor="hook-name">
              <Input
                id="hook-name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pager"
              />
            </Field>
            <Field label="Webhook URL" htmlFor="hook-url" hint="Public https:// addresses only.">
              <Input
                id="hook-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/nexus"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <Button type="submit" loading={create.isPending}>
            Add webhook
          </Button>
        </form>

        {webhooks.isPending && (
          <div aria-busy="true" aria-label="Loading webhooks">
            <Skeleton className="h-12" />
          </div>
        )}
        {webhooks.isError && <Alert>{describeError(webhooks.error)}</Alert>}
        {webhooks.data && webhooks.data.length === 0 && (
          <EmptyState
            title="No outbound webhooks"
            description="Add one above to call it from an automation rule."
          />
        )}
        {webhooks.data && webhooks.data.length > 0 && (
          <ul aria-label="Outbound webhooks" className="divide-y divide-border">
            {webhooks.data.map((webhook) => (
              <WebhookRow key={webhook.id} orgId={orgId} webhook={webhook} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function WebhookRow({ orgId, webhook }: { orgId: string; webhook: OutboundWebhookDto }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const disable = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}/outbound-webhooks/${webhook.id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.webhooks(orgId) }),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{webhook.name}</p>
        <p className="break-all font-mono text-xs text-muted">{webhook.url}</p>
        {disable.isError && <p className="text-xs text-danger">{describeError(disable.error)}</p>}
      </div>
      {confirming ? (
        <span className="flex items-center gap-2 text-sm">
          <span className="text-muted">Rules using it will fail.</span>
          <Button
            size="sm"
            variant="danger"
            loading={disable.isPending}
            onClick={() => disable.mutate()}
          >
            Disable webhook
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Disable ${webhook.name}`}
          onClick={() => setConfirming(true)}
        >
          Disable
        </Button>
      )}
    </li>
  );
}

/** Shown once, straight after creation: the signing secret cannot be retrieved again. */
function Reveal({
  created,
  onDismiss,
}: {
  created: CreatedOutboundWebhookDto;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <p className="text-sm font-medium">“{created.name}” was added</p>
      <p className="text-sm text-muted">
        Copy the signing secret now: it is stored encrypted and cannot be shown again. If you lose
        it, disable the webhook and add it again.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs">
          {created.signingSecret}
        </code>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Copy signing secret"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(created.signingSecret);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false); // the value is still selectable
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <details className="text-sm text-muted">
        <summary className="cursor-pointer text-foreground">
          How the receiver verifies a call
        </summary>
        <div className="mt-2 space-y-1">
          <p>
            Each request is a JSON <code className="font-mono">POST</code> with the headers{' '}
            <code className="font-mono">X-Nexus-Timestamp</code>,{' '}
            <code className="font-mono">X-Nexus-Signature-256</code>,{' '}
            <code className="font-mono">X-Nexus-Event</code> and{' '}
            <code className="font-mono">X-Nexus-Delivery</code>.
          </p>
          <p>
            The signature is <code className="font-mono">sha256=</code> followed by the hex
            HMAC-SHA256 of <code className="font-mono">{'{timestamp}.{raw body}'}</code> using the
            signing secret. Reject requests whose timestamp is more than a few minutes old, and use
            the delivery id to ignore repeats.
          </p>
        </div>
      </details>
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        I have saved the secret
      </Button>
    </div>
  );
}
