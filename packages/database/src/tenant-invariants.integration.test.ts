import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from './index';

// Requires PostgreSQL with migrations applied. Reads the LIVE catalog, so it checks the database as it
// really is, not the schema file: a new table, or a new relation, that weakens tenant isolation fails
// here until someone has made a deliberate decision about it (ADR-005, ADR-010, ADR-017).
const url = process.env.DATABASE_URL;

/**
 * Tables that are deliberately NOT owned by an organization. Everything else must carry an
 * `organizationId`. Adding a table to this list is a security decision: say why.
 */
const NOT_TENANT_OWNED = new Map<string, string>([
  ['Organization', 'is the tenant itself'],
  ['User', 'an account belongs to a person, who may be a member of several organizations'],
  ['Session', 'belongs to a person, not an organization'],
  ['PasswordReset', 'belongs to a person, not an organization'],
  ['_prisma_migrations', 'the migration tool’s own bookkeeping'],
]);

/**
 * Foreign keys between two tenant-owned tables that are allowed NOT to include `organizationId`.
 * None today. If one is ever needed it must be justified here, because such a key can point a row of
 * one organization at a row of another.
 */
const SINGLE_COLUMN_TENANT_FKS = new Map<string, string>();

interface ForeignKey {
  name: string;
  table: string;
  refTable: string;
  columns: string[];
}

describe.skipIf(!url)('tenant isolation invariants (integration)', () => {
  const prisma = createPrismaClient(url ?? 'postgresql://unused');
  afterAll(() => prisma.$disconnect());

  async function catalog() {
    const tables = (
      await prisma.$queryRaw<{ name: string }[]>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    ).map((row) => row.name);
    const tenantTables = new Set(
      (
        await prisma.$queryRaw<{ name: string }[]>`
          SELECT table_name AS name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'organizationId'`
      ).map((row) => row.name),
    );
    const foreignKeys = await prisma.$queryRaw<ForeignKey[]>`
      SELECT c.conname AS name, cl.relname AS "table", fl.relname AS "refTable",
             ARRAY(SELECT a.attname::text FROM unnest(c.conkey) AS k
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS columns
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class fl ON fl.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`;
    return { tables, tenantTables, foreignKeys };
  }

  it('every table either carries organizationId or is on the reviewed list of exceptions', async () => {
    const { tables, tenantTables } = await catalog();
    const unowned = tables.filter((t) => !tenantTables.has(t)).sort();
    expect(unowned).toEqual([...NOT_TENANT_OWNED.keys()].sort());
  });

  it('every tenant-owned table is anchored to an organization by a foreign key', async () => {
    const { tenantTables, foreignKeys } = await catalog();
    const unanchored = [...tenantTables].filter(
      (table) =>
        !foreignKeys.some((fk) => fk.table === table && fk.columns.includes('organizationId')),
    );
    expect(unanchored).toEqual([]);
  });

  it('every foreign key between two tenant-owned tables includes organizationId, so it cannot cross a tenant', async () => {
    const { tenantTables, foreignKeys } = await catalog();
    const crossable = foreignKeys
      .filter((fk) => tenantTables.has(fk.table) && tenantTables.has(fk.refTable))
      .filter((fk) => !fk.columns.includes('organizationId'))
      .filter((fk) => !SINGLE_COLUMN_TENANT_FKS.has(`${fk.table}.${fk.name}`))
      .map((fk) => `${fk.table}.${fk.name} → ${fk.refTable} (${fk.columns.join(', ')})`);
    expect(crossable).toEqual([]);
  });

  it('a tenant table may reference a person-owned table only through a person id, never to borrow data', async () => {
    // References to User are allowed (an author, an assignee); this pins that they stay single-column
    // ids of people, and that nothing tenant-owned points at Session or PasswordReset.
    const { foreignKeys } = await catalog();
    const toSecrets = foreignKeys.filter(
      (fk) => fk.refTable === 'Session' || fk.refTable === 'PasswordReset',
    );
    expect(toSecrets).toEqual([]);
  });

  it('the exceptions list has no stale entries', async () => {
    const { tables } = await catalog();
    for (const name of NOT_TENANT_OWNED.keys()) expect(tables, name).toContain(name);
  });
});
