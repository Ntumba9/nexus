'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createOrganizationSchema, type OrganizationDetailDto } from '@nexus/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { apiFetch, describeError } from '@/lib/api-client';
import { rememberOrganization } from '@/lib/last-org';

type Values = z.input<typeof createOrganizationSchema>;

export function CreateOrganizationForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof createOrganizationSchema>>({
    resolver: zodResolver(createOrganizationSchema),
  });

  async function onSubmit(values: z.output<typeof createOrganizationSchema>) {
    setFormError(null);
    try {
      const org = await apiFetch<OrganizationDetailDto>('/orgs', { method: 'POST', body: values });
      rememberOrganization(org.id);
      router.replace(`/orgs/${org.id}`);
      router.refresh();
    } catch (error) {
      setFormError(describeError(error));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {formError && <Alert>{formError}</Alert>}
      <Field
        label="Organization name"
        htmlFor="name"
        error={errors.name?.message}
        hint="Usually your company or team name. You can change it later."
      >
        <Input
          id="name"
          autoComplete="organization"
          placeholder="Acme Technologies"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'name-error' : undefined}
          {...register('name')}
        />
      </Field>
      <Button type="submit" loading={isSubmitting} className="w-full">
        Create organization
      </Button>
    </form>
  );
}
