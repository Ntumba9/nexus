import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';
export * from './domain-events';
export * from './incident-writes';
export * from './service-health';

/** Create a Prisma client for an explicit connection string (never read from the environment here). */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: databaseUrl,
    // Interactive transactions wait for a pooled connection for at most `maxWait` (default 2s) and
    // otherwise fail, which surfaced as HTTP 500s during bursts of concurrent writes. Queueing
    // briefly is the right behaviour under load; the timeout still bounds a stuck transaction.
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  });
}

/** Cheap connectivity probe used by readiness checks. Throws if the database is unreachable. */
export async function pingDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}
