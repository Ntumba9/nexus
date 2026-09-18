import { randomBytes } from 'node:crypto';

/**
 * URL-safe slug from a display name, with a random suffix so two entities with the same name never
 * collide ("Payments API" → "payments-api-3fa91c"). Matches the database CHECK (lowercase
 * alphanumerics and hyphens, 3–63 characters).
 */
export function slugify(name: string, fallback = 'item'): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || fallback}-${randomBytes(3).toString('hex')}`;
}
