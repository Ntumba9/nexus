'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { updateOrganizationSchema } from '@nexus/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';

type Values = z.input<typeof updateOrganizationSchema>;

export function GeneralSettingsForm({
  orgId,
  name,
  slug,
  canEdit,
}: {
  orgId: string;
  name: string;
  slug: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values, unknown, z.output<typeof updateOrganizationSchema>>({
    resolver: zodResolver(updateOrganizationSchema),
    defaultValues: { name },
  });

  async function onSubmit(values: z.output<typeof updateOrganizationSchema>) {
    setStatus(null);
    try {
      await apiFetch(`/orgs/${orgId}`, { method: 'PATCH', body: values });
      setStatus({ tone: 'success', text: 'Settings saved.' });
      router.refresh(); // re-fetch server data so the switcher and headings show the new name
    } catch (error) {
      setStatus({ tone: 'error', text: describeError(error) });
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="max-w-md space-y-4">
      {status && <Alert tone={status.tone}>{status.text}</Alert>}
      <Field label="Organization name" htmlFor="org-name" error={errors.name?.message}>
        <Input
          id="org-name"
          disabled={!canEdit}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'org-name-error' : undefined}
          {...register('name')}
        />
      </Field>
      <Field
        label="Identifier"
        htmlFor="org-slug"
        hint="Generated automatically; it cannot be changed."
      >
        <Input id="org-slug" value={slug} readOnly disabled className="font-mono" />
      </Field>
      {canEdit ? (
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          Save changes
        </Button>
      ) : (
        <p className="text-sm text-muted">
          Only owners and admins can change organization settings.
        </p>
      )}
    </form>
  );
}
