import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';

/** Create a Prisma client for an explicit connection string (never read from the environment here). */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

/** Cheap connectivity probe used by readiness checks. Throws if the database is unreachable. */
export async function pingDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}
