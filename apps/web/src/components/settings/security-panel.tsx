'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '@nexus/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/field';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';

const formSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match',
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password you have not used just now',
  });
type Values = z.input<typeof formSchema>;

/** Your own account (not the organization's): change the password, or end every session. */
export function SecurityPanel() {
  const router = useRouter();
  const [status, setStatus] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [everywhere, setEverywhere] = useState<'idle' | 'confirm' | 'working'>('idle');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof formSchema>>({ resolver: zodResolver(formSchema) });

  async function onSubmit(values: z.output<typeof formSchema>) {
    setStatus(null);
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      reset();
      setStatus({
        tone: 'success',
        text: 'Password changed. Every other device has been signed out.',
      });
    } catch (error) {
      setStatus({
        tone: 'error',
        text:
          error instanceof ApiError && error.code === 'INVALID_CURRENT_PASSWORD'
            ? 'Your current password is not correct.'
            : describeError(error),
      });
    }
  }

  async function signOutEverywhere() {
    setEverywhere('working');
    try {
      await apiFetch('/auth/logout-all', { method: 'POST' });
      router.replace('/login');
      router.refresh();
    } catch (error) {
      setEverywhere('idle');
      setStatus({ tone: 'error', text: describeError(error) });
    }
  }

  return (
    <div className="max-w-md space-y-8">
      {status && <Alert tone={status.tone}>{status.text}</Alert>}

      <form
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="space-y-4"
        aria-label="Change password"
      >
        <Field
          label="Current password"
          htmlFor="current-password"
          error={errors.currentPassword?.message}
        >
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!errors.currentPassword}
            {...register('currentPassword')}
          />
        </Field>
        <Field
          label="New password"
          htmlFor="new-password"
          error={errors.newPassword?.message}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Changing it signs out your other devices.`}
        >
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.newPassword}
            {...register('newPassword')}
          />
        </Field>
        <Field
          label="Confirm new password"
          htmlFor="confirm-new-password"
          error={errors.confirm?.message}
        >
          <Input
            id="confirm-new-password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.confirm}
            {...register('confirm')}
          />
        </Field>
        <Button type="submit" loading={isSubmitting}>
          Change password
        </Button>
      </form>

      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-sm font-semibold">Sign out everywhere</h3>
        <p className="text-sm text-muted">
          Ends every session of your account on every device, including this one. Use it if you
          think someone else may be signed in as you.
        </p>
        {everywhere === 'idle' ? (
          <Button variant="secondary" onClick={() => setEverywhere('confirm')}>
            Sign out everywhere
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="danger" loading={everywhere === 'working'} onClick={signOutEverywhere}>
              Yes, sign me out everywhere
            </Button>
            <Button variant="ghost" onClick={() => setEverywhere('idle')}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
