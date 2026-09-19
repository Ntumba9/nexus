import type { PrismaClient } from '@nexus/database';

/**
 * Delete dispatched domain events (and, by cascade, the executions they produced) past the
 * retention window, in batches. Undispatched events are never deleted: they are work still to do.
 * Uses the database clock.
 */
export async function cleanupOldAutomationData(
  prisma: PrismaClient,
  retentionDays: number,
  batchSize = 5000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "DomainEvent"
      WHERE "id" IN (
        SELECT "id" FROM "DomainEvent"
        WHERE "dispatchedAt" IS NOT NULL
          AND "dispatchedAt" < now() - make_interval(days => ${retentionDays}::int)
        LIMIT ${batchSize}
      )`;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

/** Delete notifications past the retention window, in batches. */
export async function cleanupOldNotifications(
  prisma: PrismaClient,
  retentionDays: number,
  batchSize = 5000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "Notification"
      WHERE "id" IN (
        SELECT "id" FROM "Notification"
        WHERE "createdAt" < now() - make_interval(days => ${retentionDays}::int)
        LIMIT ${batchSize}
      )`;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
