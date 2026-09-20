'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@nexus/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';

type LoginValues = z.input<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const justReset = useSearchParams().get('reset') === '1';
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues, unknown, z.output<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
  });

  async function onSubmit(values: z.output<typeof loginSchema>) {
    setFormError(null);
    try {
      await apiFetch('/auth/login', { method: 'POST', body: values });
      router.replace('/');
      router.refresh();
    } catch (error) {
      // The API deliberately does not say whether the email or the password was wrong.
      setFormError(
        error instanceof ApiError && error.code === 'INVALID_CREDENTIALS'
          ? 'Invalid email or password.'
          : describeError(error),
      );
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {justReset && !formError && (
        <Alert tone="success">Your password was changed. Log in with the new one.</Alert>
      )}
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
      <Field label="Password" htmlFor="password" error={errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!errors.password}
          aria-describedby={errors.password ? 'password-error' : undefined}
          {...register('password')}
        />
      </Field>
      <Button type="submit" loading={isSubmitting} className="w-full">
        Log in
      </Button>
      <p className="text-center text-sm">
        <Link href="/forgot-password" className="text-muted hover:text-foreground hover:underline">
          Forgot your password?
        </Link>
      </p>
      <p className="text-center text-sm text-muted">
        New to NEXUS?{' '}
        <Link href="/register" className="text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
