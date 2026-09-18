import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient, pingDatabase } from './index';

// Requires a running PostgreSQL with migrations applied (`pnpm db:migrate:deploy`).
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('database (integration)', () => {
  const client = createPrismaClient(url ?? 'postgresql://unused');
  afterAll(() => client.$disconnect());

  it('answers a ping', async () => {
    await expect(pingDatabase(client)).resolves.toBeUndefined();
  });

  it('has pgvector and citext installed by the migrations', async () => {
    const rows = await client.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'citext') ORDER BY extname`;
    expect(rows.map((row) => row.extname)).toEqual(['citext', 'vector']);
  });
});
