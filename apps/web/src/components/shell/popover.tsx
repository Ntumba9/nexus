'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A small accessible disclosure popover: the trigger toggles it, Escape and outside clicks close it.
 * `children` may be a function receiving `close`, so menu items can dismiss the popover.
 */
export function Popover({
  trigger,
  triggerLabel,
  children,
  align = 'left',
}: {
  trigger: ReactNode;
  triggerLabel: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent"
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          className={cn(
            'absolute z-20 mt-2 min-w-64 rounded-xl border border-border bg-surface p-1 shadow-xl shadow-black/40',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}
