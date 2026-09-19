/**
 * Audit metadata is written once and can never be edited or deleted (the table is append-only in the
 * database), so a secret that reaches it stays there forever. Everything is therefore redacted
 * BEFORE it is written: by key name, by size and by depth.
 */

/** Any key that looks like it carries a credential is replaced, whatever it holds. */
const SENSITIVE_KEY =
  /secret|password|passwd|token|authorization|signature|api[-_]?key|credential|cookie|private/i;

export const REDACTED = '[redacted]';
const MAX_DEPTH = 3;
const MAX_KEYS = 30;
const MAX_STRING = 300;
const MAX_ARRAY = 20;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function redactValue(value: unknown, depth: number): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value as number) || typeof value !== 'number' ? (value as Json) : null;
  }
  if (typeof value === 'string') {
    // A URL keeps its origin and path; the query string and any credentials are dropped.
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`.slice(0, MAX_STRING);
      } catch {
        return REDACTED;
      }
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') return redactObject(value as Record<string, unknown>, depth + 1);
  return null; // functions, symbols, undefined
}

function redactObject(input: Record<string, unknown>, depth: number): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(input).slice(0, MAX_KEYS)) {
    if (value === undefined) continue;
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, depth);
  }
  return out;
}

/** A safe, bounded copy of `metadata`, suitable for storing in the audit log. */
export function redactForAudit(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return redactObject(metadata ?? {}, 0);
}
