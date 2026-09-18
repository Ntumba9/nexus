'use client';

import {
  INCIDENT_SEVERITIES,
  SEVERITY_DESCRIPTION,
  SEVERITY_LABEL,
  createIncidentSchema,
  type IncidentDetailDto,
} from '@nexus/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, describeError } from '@/lib/api-client';
import { fetchers, keys } from '@/lib/queries';

type Values = Omit<z.input<typeof createIncidentSchema>, 'tags'> & { tags?: string };

export function CreateIncidentForm({ orgId, onCancel }: { orgId: string; onCancel: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const services = useQuery({
    queryKey: keys.services(orgId),
    queryFn: () => fetchers.services(orgId),
  });
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ defaultValues: { severity: 'SEV3', serviceId: '' } });

  async function onSubmit(values: Values) {
    setError(null);
    const parsed = createIncidentSchema.safeParse({
      title: values.title,
      description: values.description ?? '',
      severity: values.severity,
      serviceId: values.serviceId || null,
      // "api, latency" → ["api", "latency"]
      tags: (values.tags ?? '')
        .split(/[,\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]) as
          'title' | 'description' | 'severity' | 'serviceId' | 'tags';
        setFieldError(field, { message: issue.message });
      }
      return;
    }
    try {
      const incident = await apiFetch<IncidentDetailDto>(`/orgs/${orgId}/incidents`, {
        method: 'POST',
        body: parsed.data,
      });
      await queryClient.invalidateQueries({ queryKey: keys.incidents(orgId) });
      await queryClient.invalidateQueries({ queryKey: keys.dashboard(orgId) });
      router.push(`/orgs/${orgId}/incidents/${incident.id}`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      aria-label="Open an incident"
      className="space-y-4 rounded-xl border border-border bg-surface p-5"
    >
      <h2 className="text-sm font-medium">Open an incident</h2>
      {error && <Alert>{error}</Alert>}
      <Field label="Title" htmlFor="incident-title" error={errors.title?.message}>
        <Input
          id="incident-title"
          placeholder="API latency spike"
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'incident-title-error' : undefined}
          {...register('title')}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Severity" htmlFor="incident-severity" error={errors.severity?.message}>
          <Select id="incident-severity" {...register('severity')}>
            {INCIDENT_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {SEVERITY_LABEL[severity]}: {SEVERITY_DESCRIPTION[severity]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Affected service" htmlFor="incident-service" hint="Optional">
          <Select id="incident-service" disabled={services.isPending} {...register('serviceId')}>
            <option value="">No specific service</option>
            {(services.data ?? []).map((service) => (
              <option key={service.id} value={service.id}>
                {service.projectName} / {service.name} ({service.environment.toLowerCase()})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Description"
        htmlFor="incident-description"
        error={errors.description?.message}
        hint="What is happening, and who is affected?"
      >
        <Textarea id="incident-description" {...register('description')} />
      </Field>
      <Field
        label="Tags"
        htmlFor="incident-tags"
        error={errors.tags?.message}
        hint="Optional, separated by commas or spaces"
      >
        <Input id="incident-tags" placeholder="latency, api" {...register('tags')} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" loading={isSubmitting}>
          Open incident
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
