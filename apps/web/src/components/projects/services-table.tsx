'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { SERVICE_ENVIRONMENTS, createServiceSchema, type ServiceDto } from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { EnvironmentBadge, HealthBadge } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';
import { fetchers, keys } from '@/lib/queries';

type Values = z.input<typeof createServiceSchema>;

/**
 * Services for one project (with an add form), or across the whole organisation when `projectId`
 * is omitted (read-only listing that links back to each project).
 */
export function ServicesTable({
  orgId,
  projectId,
  canManage,
}: {
  orgId: string;
  projectId?: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const services = useQuery({
    queryKey: keys.services(orgId, projectId),
    queryFn: () => fetchers.services(orgId, projectId),
  });

  const archive = useMutation({
    mutationFn: (id: string) => apiFetch(`/orgs/${orgId}/services/${id}`, { method: 'DELETE' }),
    onSettled: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: ['services', orgId] });
      void queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
    },
  });

  return (
    <div className="space-y-4">
      {archive.isError && <Alert>{describeError(archive.error)}</Alert>}

      {services.isPending && (
        <div aria-busy="true" aria-label="Loading services" className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {services.isError && (
        <div className="space-y-3">
          <Alert>{describeError(services.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => services.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {services.data && services.data.length === 0 && (
        <EmptyState
          title="No services yet"
          description={
            projectId
              ? 'Add the services that make up this project, such as an API, a database or an email provider.'
              : 'Services live inside projects. Create a project, then add services to it.'
          }
        />
      )}

      {services.data && services.data.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Services</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  Service
                </th>
                {!projectId && (
                  <th scope="col" className="px-5 py-3 font-medium">
                    Project
                  </th>
                )}
                <th scope="col" className="px-5 py-3 font-medium">
                  Environment
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Health
                </th>
                {canManage && (
                  <th scope="col" className="px-5 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {services.data.map((service) => (
                <ServiceRow
                  key={service.id}
                  orgId={orgId}
                  service={service}
                  showProject={!projectId}
                  canManage={canManage}
                  confirming={confirming === service.id}
                  archiving={archive.isPending && confirming === service.id}
                  onArchiveRequest={() => setConfirming(service.id)}
                  onArchiveCancel={() => setConfirming(null)}
                  onArchiveConfirm={() => archive.mutate(service.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {projectId && canManage && (
        <div>
          {showForm ? (
            <CreateServiceForm
              orgId={orgId}
              projectId={projectId}
              onDone={() => setShowForm(false)}
            />
          ) : (
            <Button variant="secondary" onClick={() => setShowForm(true)}>
              Add service
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ServiceRow(props: {
  orgId: string;
  service: ServiceDto;
  showProject: boolean;
  canManage: boolean;
  confirming: boolean;
  archiving: boolean;
  onArchiveRequest: () => void;
  onArchiveCancel: () => void;
  onArchiveConfirm: () => void;
}) {
  const { service } = props;
  return (
    <tr>
      <td className="px-5 py-3 font-medium">
        <Link
          href={`/orgs/${props.orgId}/services/${service.id}`}
          className="hover:text-accent hover:underline"
        >
          {service.name}
        </Link>
      </td>
      {props.showProject && (
        <td className="px-5 py-3">
          <Link
            href={`/orgs/${props.orgId}/projects/${service.projectId}`}
            className="text-muted hover:text-foreground hover:underline"
          >
            {service.projectName}
          </Link>
        </td>
      )}
      <td className="px-5 py-3">
        <EnvironmentBadge environment={service.environment} />
      </td>
      <td className="px-5 py-3">
        <HealthBadge health={service.healthStatus} />
      </td>
      {props.canManage && (
        <td className="px-5 py-3 text-right">
          {props.confirming ? (
            <span className="inline-flex gap-2">
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
              aria-label={`Archive ${service.name}`}
              onClick={props.onArchiveRequest}
            >
              Archive
            </Button>
          )}
        </td>
      )}
    </tr>
  );
}

function CreateServiceForm({
  orgId,
  projectId,
  onDone,
}: {
  orgId: string;
  projectId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof createServiceSchema>>({
    resolver: zodResolver(createServiceSchema),
    defaultValues: { environment: 'PRODUCTION' },
  });

  async function onSubmit(values: z.output<typeof createServiceSchema>) {
    setError(null);
    try {
      await apiFetch(`/orgs/${orgId}/projects/${projectId}/services`, {
        method: 'POST',
        body: values,
      });
      await queryClient.invalidateQueries({ queryKey: ['services', orgId] });
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
      <h3 className="text-sm font-medium">Add a service</h3>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="service-name" error={errors.name?.message}>
          <Input
            id="service-name"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? 'service-name-error' : undefined}
            {...register('name')}
          />
        </Field>
        <Field label="Environment" htmlFor="service-environment">
          <Select id="service-environment" {...register('environment')}>
            {SERVICE_ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {env.charAt(0) + env.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={isSubmitting}>
          Create service
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
