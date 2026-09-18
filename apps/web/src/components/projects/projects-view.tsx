'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createProjectSchema, type ProjectDto } from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';
import { fetchers, keys } from '@/lib/queries';

type Values = z.input<typeof createProjectSchema>;

export function ProjectsView({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const projects = useQuery({
    queryKey: keys.projects(orgId),
    queryFn: () => fetchers.projects(orgId),
  });

  const archive = useMutation({
    mutationFn: (id: string) => apiFetch(`/orgs/${orgId}/projects/${id}`, { method: 'DELETE' }),
    onSettled: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
      void queryClient.invalidateQueries({ queryKey: keys.services(orgId) });
    },
  });

  return (
    <div className="space-y-6">
      {canManage && (
        <div>
          {showForm ? (
            <CreateProjectForm orgId={orgId} onDone={() => setShowForm(false)} />
          ) : (
            <Button onClick={() => setShowForm(true)}>New project</Button>
          )}
        </div>
      )}

      {archive.isError && <Alert>{describeError(archive.error)}</Alert>}

      {projects.isPending && (
        <div aria-busy="true" aria-label="Loading projects" className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}
      {projects.isError && (
        <div className="space-y-3">
          <Alert>{describeError(projects.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => projects.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {projects.data && projects.data.length === 0 && (
        <EmptyState
          title="No projects yet"
          description="A project groups related services, such as “Payments API” or “Customer Portal”."
        />
      )}

      {projects.data && projects.data.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {projects.data.map((project) => (
            <ProjectRow
              key={project.id}
              orgId={orgId}
              project={project}
              canManage={canManage}
              confirming={confirming === project.id}
              archiving={archive.isPending && confirming === project.id}
              onArchiveRequest={() => setConfirming(project.id)}
              onArchiveCancel={() => setConfirming(null)}
              onArchiveConfirm={() => archive.mutate(project.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectRow(props: {
  orgId: string;
  project: ProjectDto;
  canManage: boolean;
  confirming: boolean;
  archiving: boolean;
  onArchiveRequest: () => void;
  onArchiveCancel: () => void;
  onArchiveConfirm: () => void;
}) {
  const { project } = props;
  return (
    <li className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <Link
          href={`/orgs/${props.orgId}/projects/${project.id}`}
          className="font-medium hover:underline"
        >
          {project.name}
        </Link>
        <p className="truncate text-sm text-muted">
          {project.description || 'No description'} · {project.serviceCount}{' '}
          {project.serviceCount === 1 ? 'service' : 'services'}
        </p>
      </div>
      {props.canManage &&
        (props.confirming ? (
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted">Archive project and its services?</span>
            <Button
              variant="danger"
              size="sm"
              loading={props.archiving}
              onClick={props.onArchiveConfirm}
            >
              Confirm
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onArchiveCancel}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Archive ${project.name}`}
            onClick={props.onArchiveRequest}
          >
            Archive
          </Button>
        ))}
    </li>
  );
}

function CreateProjectForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof createProjectSchema>>({
    resolver: zodResolver(createProjectSchema),
  });

  async function onSubmit(values: z.output<typeof createProjectSchema>) {
    setError(null);
    try {
      await apiFetch(`/orgs/${orgId}/projects`, { method: 'POST', body: values });
      await queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
      reset();
      onDone();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="space-y-4 rounded-xl border border-border bg-surface p-5"
    >
      <h2 className="text-sm font-medium">New project</h2>
      {error && <Alert>{error}</Alert>}
      <Field label="Name" htmlFor="project-name" error={errors.name?.message}>
        <Input
          id="project-name"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'project-name-error' : undefined}
          {...register('name')}
        />
      </Field>
      <Field
        label="Description"
        htmlFor="project-description"
        error={errors.description?.message}
        hint="Optional"
      >
        <Input id="project-description" {...register('description')} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" loading={isSubmitting}>
          Create project
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
