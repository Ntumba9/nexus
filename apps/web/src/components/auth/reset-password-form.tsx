'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '@nexus/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';

const formSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match',
  });
type Values = z.input<typeof formSchema>;

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof formSchema>>({ resolver: zodResolver(formSchema) });

  if (!token) {
    return (
      <div className="space-y-4">
        <Alert>This reset link is not valid. Ask for a new one.</Alert>
        <p className="text-center text-sm">
          <Link href="/forgot-password" className="text-accent hover:underline">
            Send me a new link
          </Link>
        </p>
      </div>
    );
  }

  async function onSubmit(values: z.output<typeof formSchema>) {
    setFormError(null);
    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: { token, password: values.password },
      });
      router.replace('/login?reset=1');
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.code === 'INVALID_RESET_TOKEN'
          ? 'This reset link is invalid, has already been used, or has expired.'
          : describeError(error),
      );
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {formError && (
        <Alert>
          {formError}{' '}
          <Link href="/forgot-password" className="underline">
            Send a new link
          </Link>
        </Alert>
      )}
      <Field
        label="New password"
        htmlFor="password"
        error={errors.password?.message}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      >
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.password}
          aria-describedby={errors.password ? 'password-error' : undefined}
          {...register('password')}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={errors.confirm?.message}>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.confirm}
          aria-describedby={errors.confirm ? 'confirm-error' : undefined}
          {...register('confirm')}
        />
      </Field>
      <Button type="submit" loading={isSubmitting} className="w-full">
        Set new password
      </Button>
    </form>
  );
}
