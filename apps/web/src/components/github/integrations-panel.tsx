'use client';

import {
  createGitHubIntegrationSchema,
  type CreatedGitHubIntegrationDto,
  type GitHubIntegrationDto,
} from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';
import { timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';

/** Copy text to the clipboard; false when the browser refuses (the value is still selectable). */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            setCopied(await copy(value));
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/** Shown once, straight after creation: the secret cannot be retrieved again. */
function SecretReveal({
  created,
  onDismiss,
}: {
  created: CreatedGitHubIntegrationDto;
  onDismiss: () => void;
}) {
  const url = `${window.location.origin}${created.webhookPath}`;
  return (
    <div className="space-y-4 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect {created.repoFullName} in GitHub</p>
        <p className="text-sm text-muted">
          Copy the secret now: it is not stored in a readable form and cannot be shown again. If you
          lose it, disconnect and reconnect the repository to get a new one.
        </p>
      </div>
      <CopyRow label="Payload URL" value={url} />
      <CopyRow label="Secret" value={created.webhookSecret} />
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>
          In the repository, open <strong>Settings → Webhooks → Add webhook</strong>.
        </li>
        <li>
          Paste the payload URL, set the content type to <strong>application/json</strong>, and
          paste the secret.
        </li>
        <li>
          Choose <strong>Let me select individual events</strong> and tick{' '}
          <strong>Deployment statuses</strong>.
        </li>
      </ol>
      <p className="text-xs text-muted">
        GitHub must be able to reach this address. A NEXUS running on localhost is not reachable
        from the internet without a tunnel.
      </p>
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        I have saved the secret
      </Button>
    </div>
  );
}

function ConnectForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated: (c: CreatedGitHubIntegrationDto) => void;
}) {
  const queryClient = useQueryClient();
  const [repo, setRepo] = useState('');
  const [projectId, setProjectId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: keys.projects(orgId),
    queryFn: () => fetchers.projects(orgId),
  });
  const services = useQuery({
    queryKey: keys.services(orgId, projectId),
    queryFn: () => fetchers.services(orgId, projectId),
    enabled: projectId !== '',
  });

  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch<CreatedGitHubIntegrationDto>(`/orgs/${orgId}/integrations/github`, {
        method: 'POST',
        body,
      }),
    onSuccess: async (created) => {
      setRepo('');
      setServiceId('');
      await queryClient.invalidateQueries({ queryKey: keys.integrations(orgId) });
      onCreated(created);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = createGitHubIntegrationSchema.safeParse({
      repoFullName: repo,
      projectId,
      serviceId: serviceId || null,
    });
    if (!parsed.success) {
      setFieldError(
        parsed.error.issues.some((i) => i.path[0] === 'repoFullName')
          ? 'Enter the repository as owner/name, for example acme/storefront.'
          : 'Choose a project.',
      );
      return;
    }
    setFieldError(null);
    create.mutate(parsed.data);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {create.isError && <Alert>{describeError(create.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Repository"
          htmlFor="gh-repo"
          error={fieldError && fieldError.startsWith('Enter') ? fieldError : undefined}
        >
          <Input
            id="gh-repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Project"
          htmlFor="gh-project"
          error={fieldError && fieldError.startsWith('Choose') ? fieldError : undefined}
        >
          <Select
            id="gh-project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setServiceId('');
            }}
          >
            <option value="">Select a project…</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Service"
          htmlFor="gh-service"
          hint="Optional. Links deployments to incidents."
        >
          <Select
            id="gh-service"
            value={serviceId}
            disabled={projectId === ''}
            onChange={(e) => setServiceId(e.target.value)}
          >
            <option value="">All services in the project</option>
            {services.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.environment.toLowerCase()})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" loading={create.isPending}>
        Connect repository
      </Button>
    </form>
  );
}

function IntegrationRow({
  orgId,
  integration,
}: {
  orgId: string;
  integration: GitHubIntegrationDto;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const disable = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}/integrations/github/${integration.id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.integrations(orgId) }),
  });

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="font-mono text-sm">{integration.repoFullName}</p>
        <p className="text-xs text-muted">
          {integration.lastEventAt
            ? `Last delivery ${timeAgo(integration.lastEventAt)}`
            : 'No deliveries received yet'}
        </p>
        {disable.isError && <p className="text-xs text-danger">{describeError(disable.error)}</p>}
      </div>
      {confirming ? (
        <span className="flex items-center gap-2 text-sm">
          <span className="text-muted">Stop receiving deliveries?</span>
          <Button
            size="sm"
            variant="danger"
            loading={disable.isPending}
            onClick={() => disable.mutate()}
          >
            Disconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
          Disconnect
        </Button>
      )}
    </li>
  );
}

export function IntegrationsPanel({ orgId }: { orgId: string }) {
  const [created, setCreated] = useState<CreatedGitHubIntegrationDto | null>(null);
  const integrations = useQuery({
    queryKey: keys.integrations(orgId),
    queryFn: () => fetchers.integrations(orgId),
  });

  return (
    <div className="space-y-6">
      {created && <SecretReveal created={created} onDismiss={() => setCreated(null)} />}

      <Card
        title="Connect a repository"
        description="NEXUS records deployments GitHub reports for the repository and suggests them as causes of incidents."
      >
        <ConnectForm orgId={orgId} onCreated={setCreated} />
      </Card>

      <Card title="Connected repositories">
        {integrations.isPending && (
          <div aria-busy="true" aria-label="Loading integrations">
            <Skeleton className="h-16" />
          </div>
        )}
        {integrations.isError && <Alert>{describeError(integrations.error)}</Alert>}
        {integrations.data && integrations.data.length === 0 && (
          <EmptyState
            title="No repositories connected"
            description="Connect one above to start recording deployments."
          />
        )}
        {integrations.data && integrations.data.length > 0 && (
          <ul aria-label="Connected repositories" className="divide-y divide-border">
            {integrations.data.map((integration) => (
              <IntegrationRow key={integration.id} orgId={orgId} integration={integration} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
