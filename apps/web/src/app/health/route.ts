// Liveness endpoint for container health checks; intentionally has no dependencies.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
