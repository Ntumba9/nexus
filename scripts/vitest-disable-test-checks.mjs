// Vitest global setup shared by every package with integration tests.
//
// Tests create monitoring checks (directly, through the seed helpers, and through the API). A check
// is enabled by default, so each one stays scheduled forever: on a developer's database, every test
// run adds more checks for the dispatcher to enqueue and the worker to probe at URLs that no longer
// exist. The organizations they belong to cannot be deleted (the audit log is append-only and blocks
// it), so instead, when a run ends, every check created since it began is switched off.
//
// "Since it began" is read from the database's own clock, at the start and again at the end, so it
// does not depend on the test machine's clock. A check someone else creates while a test run is in
// progress would be switched off too; do not run tests against a database you are using at the time.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined; // Unit-only runs: nothing to clean.

  let prisma;
  try {
    const { createPrismaClient } = require('../packages/database/dist');
    prisma = createPrismaClient(url);
  } catch {
    return undefined; // The database package is not built; the tests need it anyway and will say so.
  }

  let startedAt;
  try {
    [{ now: startedAt }] = await prisma.$queryRaw`SELECT now() AS now`;
  } catch {
    await prisma.$disconnect().catch(() => undefined);
    return undefined; // No reachable database: integration tests skip themselves.
  }

  return async function teardown() {
    try {
      const { count } = await prisma.monitoringCheck.updateMany({
        where: { enabled: true, createdAt: { gte: startedAt } },
        data: { enabled: false },
      });
      if (count > 0) console.log(`Disabled ${count} monitoring check(s) created by this test run.`);
    } catch (error) {
      console.warn(`Could not disable test monitoring checks: ${error.message}`);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  };
}
