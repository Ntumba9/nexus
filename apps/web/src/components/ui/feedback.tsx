import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Alert({
  tone = 'error',
  children,
  className,
}: {
  tone?: 'error' | 'success';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        tone === 'error'
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-success/30 bg-success/10 text-success',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-white/5', className)} />;
}

export function Card({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-surface', className)}>
      {(title || description) && (
        <header className="border-b border-border px-5 py-4">
          {title && <h2 className="text-sm font-medium">{title}</h2>}
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
