import type { PrismaClient } from '@nexus/database';

/**
 * Delete monitoring results older than the retention window, in batches so a large backlog never
 * holds a long lock or produces one enormous transaction. Returns the number of rows deleted.
 * Time is taken from the database clock.
 */
export async function cleanupOldResults(
  prisma: PrismaClient,
  retentionDays: number,
  batchSize = 5000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "MonitoringResult"
      WHERE "id" IN (
        SELECT "id" FROM "MonitoringResult"
        WHERE "checkedAt" < now() - make_interval(days => ${retentionDays}::int)
        LIMIT ${batchSize}
      )`;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
