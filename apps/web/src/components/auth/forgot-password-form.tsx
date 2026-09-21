'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@nexus/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';

type Values = z.input<typeof forgotPasswordSchema>;

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  async function onSubmit(values: z.output<typeof forgotPasswordSchema>) {
    setFormError(null);
    try {
      await apiFetch('/auth/forgot-password', { method: 'POST', body: values });
      setSentTo(values.email);
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 429
          ? 'Too many requests for this address. Try again in an hour.'
          : describeError(error),
      );
    }
  }

  if (sentTo) {
    // The same message whether or not the address has an account: the page must not reveal which do.
    return (
      <div className="space-y-4">
        <Alert tone="success">
          If an account exists for {sentTo}, a link to reset the password is on its way. It works
          once and expires in an hour.
        </Alert>
        <p className="text-center text-sm text-muted">
          <Link href="/login" className="text-accent hover:underline">
            Back to log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {formError && <Alert>{formError}</Alert>}
      <Field label="Email" htmlFor="email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? 'email-error' : undefined}
          {...register('email')}
        />
      </Field>
      <Button type="submit" loading={isSubmitting} className="w-full">
        Send reset link
      </Button>
      <p className="text-center text-sm text-muted">
        <Link href="/login" className="text-accent hover:underline">
          Back to log in
        </Link>
      </p>
    </form>
  );
}
