import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAuditLog } from './audit';
import { createPrismaClient } from './index';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('the audit log writer (integration)', () => {
  const prisma = createPrismaClient(url ?? 'postgresql://unused');
  afterAll(() => prisma.$disconnect());

  let orgId: string;
  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    orgId = (
      await prisma.organization.create({ data: { name: `Org ${suffix}`, slug: `org-${suffix}` } })
    ).id;
  });

  const write = (metadata: Record<string, unknown>) =>
    prisma.$transaction((tx) =>
      writeAuditLog(tx, {
        organizationId: orgId,
        actor: { type: 'SYSTEM', id: null, label: 'NEXUS' },
        action: 'automation.rule.created',
        resourceType: 'automation_rule',
        resourceId: randomUUID(),
        metadata,
        requestId: 'req-1',
      }),
    );

  it('stores redacted, bounded metadata: a secret never reaches the (permanent) log', async () => {
    const id = await write({
      name: 'Rule',
      signingSecret: 'super-secret-value',
      url: 'https://hooks.example.com/path?token=abc123',
      nested: { password: 'hunter2', ok: 'fine' },
    });
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row.metadata).toEqual({
      name: 'Rule',
      signingSecret: '[redacted]',
      url: 'https://hooks.example.com/path',
      nested: { password: '[redacted]', ok: 'fine' },
    });
    expect(JSON.stringify(row)).not.toMatch(/super-secret-value|abc123|hunter2/);
    expect(row).toMatchObject({ actorLabel: 'NEXUS', requestId: 'req-1', actorType: 'SYSTEM' });
  });

  it('leaves no entry when the change it describes rolls back', async () => {
    const before = await prisma.auditLog.count({ where: { organizationId: orgId } });
    await expect(
      prisma.$transaction(async (tx) => {
        await writeAuditLog(tx, {
          organizationId: orgId,
          actor: { type: 'SYSTEM', id: null, label: 'NEXUS' },
          action: 'automation.rule.deleted',
          resourceType: 'automation_rule',
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await prisma.auditLog.count({ where: { organizationId: orgId } })).toBe(before);
  });
});
