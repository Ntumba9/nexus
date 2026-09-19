import { randomUUID } from 'node:crypto';
import { emitDomainEvent, type PrismaClient } from '@nexus/database';
import {
  organizationOfChannel,
  type AutomationJobPayload,
  type RealtimeMessage,
} from '@nexus/shared';
import type { JobsOptions } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { HAS_DB, seedService, testPrisma } from '../testing/db';
import { dispatchDomainEvents, type AutomationQueue, type DispatchResult } from './dispatcher';

const logger = createLogger('silent');

type EventType = 'incident.created' | 'service.health_changed';

class NullQueue implements AutomationQueue {
  async add(_name: string, _data: AutomationJobPayload, _options: JobsOptions): Promise<void> {}
}

/** Records what would be published, and can be told to fail like an unreachable Redis. */
class RecordingPublisher {
  sent: { organizationId: string; message: RealtimeMessage }[] = [];
  failing = false;
  async publish(channel: string, raw: string): Promise<number> {
    if (this.failing) throw new Error('redis is down');
    const organizationId = organizationOfChannel(channel);
    if (!organizationId) throw new Error(`unexpected channel ${channel}`);
    this.sent.push({ organizationId, message: JSON.parse(raw) as RealtimeMessage });
    return 1;
  }
  topics(organizationId: string): string[] {
    return this.sent.filter((s) => s.organizationId === organizationId).map((s) => s.message.topic);
  }
}

describe.skipIf(!HAS_DB)('real-time signals from the worker (integration)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  /**
   * Emit events in a fresh organisation and dispatch them with the dispatcher under test. A worker
   * running elsewhere against the same database (a dev stack, say) may claim the events first, so
   * try again with a fresh organisation until this dispatcher is the one that got them.
   */
  async function emitAndDispatch(types: EventType[], publisher?: RecordingPublisher) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { organizationId } = await seedService(prisma);
      const eventIds: string[] = [];
      for (const type of types) {
        eventIds.push(
          await prisma.$transaction((tx) =>
            emitDomainEvent(tx, { organizationId, type, subjectId: randomUUID(), facts: {} }),
          ),
        );
      }
      const result: DispatchResult = await dispatchDomainEvents(prisma, new NullQueue(), logger, {
        maxExecutionsPerRulePerHour: 60,
        organizationId,
        ...(publisher ? { realtime: publisher } : {}),
      });
      if (result.events === types.length) return { organizationId, eventIds, result };
    }
    throw new Error('another worker kept claiming the test events');
  }

  it('announces each kind of change once, to the organisation it happened in', async () => {
    const publisher = new RecordingPublisher();
    const { organizationId } = await emitAndDispatch(
      ['incident.created', 'incident.created', 'service.health_changed'],
      publisher,
    );

    expect(publisher.topics(organizationId).sort()).toEqual([
      'incidents',
      'monitoring',
      'services',
    ]);
    // Nothing was published for any other organisation.
    expect(publisher.sent.every((s) => s.organizationId === organizationId)).toBe(true);
  });

  it('announces nothing when there was nothing to dispatch', async () => {
    const { organizationId } = await seedService(prisma);
    const publisher = new RecordingPublisher();
    await dispatchDomainEvents(prisma, new NullQueue(), logger, {
      maxExecutionsPerRulePerHour: 60,
      organizationId,
      realtime: publisher,
    });
    expect(publisher.sent).toEqual([]);
  });

  it('never lets a broken Redis stop the event from being handled', async () => {
    const publisher = new RecordingPublisher();
    publisher.failing = true;

    const { eventIds } = await emitAndDispatch(['incident.created'], publisher);

    const row = await prisma.domainEvent.findUniqueOrThrow({
      where: { id: eventIds[0]! },
      select: { dispatchedAt: true },
    });
    expect(row.dispatchedAt).not.toBeNull();
  });

  it('works without a publisher at all', async () => {
    await expect(emitAndDispatch(['incident.created'])).resolves.toBeTruthy();
  });
});
