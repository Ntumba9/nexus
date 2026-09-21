import { randomUUID } from 'node:crypto';
import { createLocalEmbeddingProvider, embedDocumentChunks } from '@nexus/database';
import type {
  AuditLogPageDto,
  KnowledgeDocumentDto,
  KnowledgeDocumentSummaryDto,
  KnowledgeSearchResultDto,
  Role,
} from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIncident, createProject, createService } from '../testing/fixtures';
import {
  HAS_INFRA,
  createOrg,
  createTestApp,
  registerUser,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT', 'VIEWER'];
/** Hand-written expectations, independent of the shared permission map. */
const MANAGES: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER'];

const RESTART = `# Restart\nRestart the checkout service with the deploy tool, then watch the error rate for ten minutes.`;

describe.skipIf(!HAS_INFRA)('knowledge base API (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  const actors = {} as Record<Role, TestUser & { memberId: string }>;
  const local = createLocalEmbeddingProvider();

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerUser(t, 'Knowledge Owner');
    orgId = (await createOrg(owner, 'Knowledge Org')).id;
    for (const role of ROLES) actors[role] = await userWithRole(t, orgId, role);
  });
  afterAll(() => t.close());

  const create = async (user: TestUser = owner, body: Record<string, unknown> = {}, org = orgId) =>
    user.client.post(`/orgs/${org}/knowledge`, {
      title: 'Checkout restart runbook',
      contentMd: RESTART,
      tags: ['checkout', 'runbook'],
      ...body,
    });

  const embedNow = (org: string, documentId: string) =>
    embedDocumentChunks(t.prisma, local, { organizationId: org, documentId });

  describe('permissions', () => {
    for (const role of ROLES) {
      it(`${role}: reads, ${MANAGES.includes(role) ? 'and manages' : 'but cannot manage'}`, async () => {
        const actor = actors[role];
        const doc = (await create()).body as KnowledgeDocumentDto;

        expect((await actor.client.get(`/orgs/${orgId}/knowledge`)).status).toBe(200);
        expect((await actor.client.get(`/orgs/${orgId}/knowledge/${doc.id}`)).status).toBe(200);
        expect((await actor.client.get(`/orgs/${orgId}/knowledge/search?q=restart`)).status).toBe(
          200,
        );

        const expected = MANAGES.includes(role) ? [201, 200, 204] : [403, 403, 403];
        const created = await create(actor, { title: `By ${role}` });
        expect(created.status).toBe(expected[0]);
        const patched = await actor.client.patch(`/orgs/${orgId}/knowledge/${doc.id}`, {
          title: `Renamed by ${role}`,
        });
        expect(patched.status).toBe(expected[1]);
        const removed = await actor.client.delete(`/orgs/${orgId}/knowledge/${doc.id}`);
        expect(removed.status).toBe(expected[2]);
      });
    }

    it('requires a session', async () => {
      const res = await owner.client.get(`/orgs/${orgId}/knowledge`, { cookie: null });
      expect(res.status).toBe(401);
    });
  });

  describe('documents', () => {
    it('creates, reads, lists, updates and deletes a document', async () => {
      const created = await create(owner, { title: 'Payments failover', tags: ['db', 'DB'] });
      expect(created.status).toBe(201);
      const doc = created.body as KnowledgeDocumentDto;
      expect(doc).toMatchObject({
        title: 'Payments failover',
        contentMd: RESTART,
        tags: ['db'], // lower-cased and de-duplicated
        createdByName: 'Knowledge Owner',
        updatedByName: 'Knowledge Owner',
      });
      expect(doc.slug).toMatch(/^payments-failover-[0-9a-f]{6}$/);
      expect(doc.index.chunks).toBeGreaterThan(0);

      const got = await owner.client.get(`/orgs/${orgId}/knowledge/${doc.id}`);
      expect(got.body).toMatchObject({ id: doc.id, title: 'Payments failover' });

      const listed = (await owner.client.get(`/orgs/${orgId}/knowledge`)).body as {
        data: KnowledgeDocumentSummaryDto[];
      };
      const row = listed.data.find((d) => d.id === doc.id)!;
      expect(row).toBeTruthy();
      expect('contentMd' in row).toBe(false); // the list is summaries

      const patched = await owner.client.patch(`/orgs/${orgId}/knowledge/${doc.id}`, {
        title: 'Payments failover v2',
        contentMd: '# Failover\nPromote the replica and update the connection string.',
        tags: ['db', 'payments'],
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        title: 'Payments failover v2',
        tags: ['db', 'payments'],
        slug: doc.slug, // a stable link
      });

      const removed = await owner.client.delete(`/orgs/${orgId}/knowledge/${doc.id}`);
      expect(removed.status).toBe(204);
      expect((await owner.client.get(`/orgs/${orgId}/knowledge/${doc.id}`)).status).toBe(404);
      expect(await t.prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBe(0);
    });

    it('filters the list by title and by tag', async () => {
      const a = (await create(owner, { title: 'Alpha needle guide', tags: ['alpha'] }))
        .body as KnowledgeDocumentDto;
      const b = (await create(owner, { title: 'Bravo guide', tags: ['bravo'] }))
        .body as KnowledgeDocumentDto;
      const byTitle = (await owner.client.get(`/orgs/${orgId}/knowledge?q=NEEDLE`)).body as {
        data: KnowledgeDocumentSummaryDto[];
      };
      expect(byTitle.data.map((d) => d.id)).toEqual([a.id]);
      const byTag = (await owner.client.get(`/orgs/${orgId}/knowledge?tag=bravo`)).body as {
        data: KnowledgeDocumentSummaryDto[];
      };
      expect(byTag.data.map((d) => d.id)).toEqual([b.id]);
    });

    it('validates input', async () => {
      const bad: [string, Record<string, unknown>][] = [
        ['empty title', { title: '   ' }],
        ['huge title', { title: 'x'.repeat(201) }],
        ['too many tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
        ['bad tag', { tags: ['Not Valid!'] }],
        ['huge content', { contentMd: 'x'.repeat(100_001) }],
        ['wrong type', { contentMd: 42 }],
      ];
      for (const [label, body] of bad) {
        const res = await create(owner, body);
        expect(res.status, label).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      const doc = (await create()).body as KnowledgeDocumentDto;
      expect((await owner.client.patch(`/orgs/${orgId}/knowledge/${doc.id}`, {})).status).toBe(400);
      // A malformed id is indistinguishable from an unknown one.
      expect((await owner.client.get(`/orgs/${orgId}/knowledge/not-a-uuid`)).status).toBe(404);
      expect((await owner.client.get(`/orgs/${orgId}/knowledge/${randomUUID()}`)).status).toBe(404);
    });

    it('stores markup as inert text and returns it unchanged', async () => {
      const evil =
        '<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>';
      const doc = (await create(owner, { title: 'Evil <b>title</b>', contentMd: evil }))
        .body as KnowledgeDocumentDto;
      expect(doc.contentMd).toBe(evil);
      expect(doc.title).toBe('Evil <b>title</b>');
    });

    it('enforces the per-organization document limit', async () => {
      const org = await createOrg(owner, 'Full Org');
      await t.prisma.knowledgeDocument.createMany({
        data: Array.from({ length: 500 }, (_, i) => ({
          organizationId: org.id,
          title: `Doc ${i}`,
          slug: `doc-${i}-aaaaaa`,
        })),
      });
      const res = await create(owner, {}, org.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOCUMENT_LIMIT');
    });
  });

  describe('search', () => {
    it('finds a document by keyword straight away, and by meaning once embedded', async () => {
      const org = await createOrg(owner, 'Search Org');
      const restart = (await create(owner, { title: 'Checkout restart runbook' }, org.id))
        .body as KnowledgeDocumentDto;
      await create(
        owner,
        {
          title: 'Quarterly budget',
          contentMd: '# Budget\nHiring forecasts and vendor contract renewals.',
        },
        org.id,
      );

      const before = (
        await owner.client.get(
          `/orgs/${org.id}/knowledge/search?q=${encodeURIComponent('restart checkout')}`,
        )
      ).body as KnowledgeSearchResultDto;
      expect(before.data[0]).toMatchObject({ documentId: restart.id, matchedBy: ['keyword'] });
      expect(before.data[0]!.snippet).toContain('Restart');
      expect(before.data[0]!.heading).toContain('Checkout restart runbook');

      await embedNow(org.id, restart.id);
      const after = (
        await owner.client.get(
          `/orgs/${org.id}/knowledge/search?q=${encodeURIComponent('restart checkout')}`,
        )
      ).body as KnowledgeSearchResultDto;
      expect(after.mode).toBe('hybrid');
      expect(after.data[0]).toMatchObject({
        documentId: restart.id,
        matchedBy: ['keyword', 'semantic'],
      });
      expect(after.data.map((d) => d.title)).not.toContain('Quarterly budget');
    });

    it('index status reflects embedding progress', async () => {
      const org = await createOrg(owner, 'Status Org');
      const doc = (await create(owner, {}, org.id)).body as KnowledgeDocumentDto;
      expect(doc.index.embedded).toBe(0);
      await embedNow(org.id, doc.id);
      const after = (await owner.client.get(`/orgs/${org.id}/knowledge/${doc.id}`))
        .body as KnowledgeDocumentDto;
      expect(after.index.embedded).toBe(after.index.chunks);
    });

    it('validates the query', async () => {
      for (const q of ['', '   ', 'x'.repeat(301)]) {
        const res = await owner.client.get(
          `/orgs/${orgId}/knowledge/search?q=${encodeURIComponent(q)}`,
        );
        expect(res.status, q.slice(0, 10)).toBe(400);
      }
      expect((await owner.client.get(`/orgs/${orgId}/knowledge/search?q=a&limit=99`)).status).toBe(
        400,
      );
      expect((await owner.client.get(`/orgs/${orgId}/knowledge/search`)).status).toBe(400);
    });

    it('treats hostile queries as data', async () => {
      for (const q of [`'; DROP TABLE "KnowledgeChunk"; --`, `x' | 'y`, '\\', ':* & !']) {
        const res = await owner.client.get(
          `/orgs/${orgId}/knowledge/search?q=${encodeURIComponent(q)}`,
        );
        expect(res.status, q).toBe(200);
      }
    });

    it('is rate limited per user', async () => {
      const user = await userWithRole(t, orgId, 'VIEWER');
      let last = 200;
      for (let i = 0; i < 61; i += 1) {
        last = (await user.client.get(`/orgs/${orgId}/knowledge/search?q=restart`)).status;
      }
      expect(last).toBe(429);
    }, 30_000);
  });

  describe('runbooks for an incident', () => {
    it('suggests relevant runbooks from the incident’s title, service and tags', async () => {
      const org = await createOrg(owner, 'Incident KB Org');
      const project = await createProject(owner, org.id, 'Payments');
      const service = await createService(owner, org.id, project.id, 'Checkout API');
      const runbook = (
        await create(owner, { title: 'Checkout service restart', contentMd: RESTART }, org.id)
      ).body as KnowledgeDocumentDto;
      await create(
        owner,
        { title: 'Office snacks', contentMd: '# Snacks\nFruit is delivered on Mondays.' },
        org.id,
      );
      await embedNow(org.id, runbook.id);

      const incident = await createIncident(owner, org.id, {
        title: 'Checkout errors after deploy',
        serviceId: service.id,
      });
      const res = await owner.client.get(`/orgs/${org.id}/knowledge/for-incident/${incident.id}`);
      expect(res.status).toBe(200);
      const body = res.body as KnowledgeSearchResultDto;
      expect(body.data[0]!.documentId).toBe(runbook.id);
      expect(body.data.map((d) => d.title)).not.toContain('Office snacks');
    });

    it('does not reveal or use another organization’s incident', async () => {
      const otherOrg = await createOrg(owner, 'Other Incident Org');
      const incident = await createIncident(owner, otherOrg.id, { title: 'Secret outage' });
      const res = await owner.client.get(`/orgs/${orgId}/knowledge/for-incident/${incident.id}`);
      expect(res.status).toBe(404);
    });
  });

  describe('audit', () => {
    it('records who created, changed and deleted a document', async () => {
      const org = await createOrg(owner, 'Audited KB Org');
      const doc = (await create(owner, { title: 'Audited doc' }, org.id))
        .body as KnowledgeDocumentDto;
      await owner.client.patch(`/orgs/${org.id}/knowledge/${doc.id}`, { title: 'Audited doc 2' });
      await owner.client.delete(`/orgs/${org.id}/knowledge/${doc.id}`);

      const log = (await owner.client.get(`/orgs/${org.id}/audit-logs?limit=50`))
        .body as AuditLogPageDto;
      const entries = log.data.filter((e) => e.resourceId === doc.id);
      expect(entries.map((e) => e.action).sort()).toEqual([
        'knowledge.document.created',
        'knowledge.document.deleted',
        'knowledge.document.updated',
      ]);
      expect(entries.every((e) => e.actorLabel === 'Knowledge Owner')).toBe(true);
      // The document body is never copied into the audit log.
      expect(JSON.stringify(entries)).not.toContain('watch the error rate');
    });
  });

  describe('tenant isolation', () => {
    it('keeps organizations apart, whatever ids are supplied', async () => {
      const alpha = await registerUser(t, 'Alpha Owner');
      const alphaOrg = (await createOrg(alpha, 'Alpha KB')).id;
      const bravo = await registerUser(t, 'Bravo Owner');
      const bravoOrg = (await createOrg(bravo, 'Bravo KB')).id;
      const secret = (
        await create(
          bravo,
          {
            title: 'Bravo vault rotation',
            contentMd: '# Rotation\nThe bravo vault rotation password procedure.',
          },
          bravoOrg,
        )
      ).body as KnowledgeDocumentDto;
      await embedNow(bravoOrg, secret.id);

      // Alpha cannot use Bravo's organization path at all.
      expect((await alpha.client.get(`/orgs/${bravoOrg}/knowledge`)).status).toBe(404);
      expect((await alpha.client.get(`/orgs/${bravoOrg}/knowledge/${secret.id}`)).status).toBe(404);
      expect((await create(alpha, {}, bravoOrg)).status).toBe(404);

      // Nor can it reach Bravo's document through its own path.
      expect((await alpha.client.get(`/orgs/${alphaOrg}/knowledge/${secret.id}`)).status).toBe(404);
      expect(
        (await alpha.client.patch(`/orgs/${alphaOrg}/knowledge/${secret.id}`, { title: 'pwned' }))
          .status,
      ).toBe(404);
      expect((await alpha.client.delete(`/orgs/${alphaOrg}/knowledge/${secret.id}`)).status).toBe(
        404,
      );
      const untouched = await t.prisma.knowledgeDocument.findUniqueOrThrow({
        where: { id: secret.id },
      });
      expect(untouched.title).toBe('Bravo vault rotation');

      // Search and lists never cross over, for either kind of search.
      const q = encodeURIComponent('bravo vault rotation password procedure');
      const found = (await alpha.client.get(`/orgs/${alphaOrg}/knowledge/search?q=${q}`))
        .body as KnowledgeSearchResultDto;
      expect(found.data).toEqual([]);
      const list = (await alpha.client.get(`/orgs/${alphaOrg}/knowledge`)).body as {
        data: unknown[];
      };
      expect(list.data).toEqual([]);
      // And a body-supplied organization id is ignored.
      const forged = await create(alpha, { organizationId: bravoOrg }, alphaOrg);
      expect(
        (forged.body as KnowledgeDocumentDto & { organizationId?: string }).organizationId,
      ).toBe(undefined);
      expect(
        await t.prisma.knowledgeDocument.count({
          where: { organizationId: bravoOrg, title: 'Checkout restart runbook' },
        }),
      ).toBe(0);
    });
  });
});
