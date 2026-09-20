import { describe, expect, it, vi } from 'vitest';
import {
  decodeRealtimeMessage,
  organizationOfChannel,
  publishRealtime,
  realtimeChannel,
  REALTIME_TOPICS,
  TOPIC_PERMISSION,
  topicsForDomainEvent,
  topicsForMutation,
} from './realtime';

const ORG = '3f2b1c2e-8a53-4c4e-9f0f-5d4b6f0a1b2c';

describe('realtime contract', () => {
  it('requires a permission for every topic', () => {
    for (const topic of REALTIME_TOPICS) expect(TOPIC_PERMISSION[topic]).toBeTruthy();
  });

  it('round-trips channel names and rejects foreign ones', () => {
    expect(organizationOfChannel(realtimeChannel(ORG))).toBe(ORG);
    expect(organizationOfChannel('other:channel')).toBeNull();
    expect(organizationOfChannel('nexus:rt:not-a-uuid')).toBeNull();
  });

  it('decodes only well-formed messages', () => {
    expect(decodeRealtimeMessage('{"topic":"incidents"}')).toEqual({ topic: 'incidents' });
    expect(decodeRealtimeMessage('{"topic":"nope"}')).toBeNull();
    expect(decodeRealtimeMessage('{"topic":"notifications","userId":"x"}')).toBeNull();
    expect(decodeRealtimeMessage('not json')).toBeNull();
  });

  it('maps domain events and mutations to topics', () => {
    expect(topicsForDomainEvent('incident.created')).toEqual(['incidents']);
    expect(topicsForDomainEvent('service.health_changed')).toEqual(['services', 'monitoring']);
    expect(topicsForDomainEvent('deployment.failed')).toEqual(['deployments']);
    expect(topicsForDomainEvent('something.else')).toEqual([]);

    expect(topicsForMutation('incidents/abc/transitions')).toEqual(['incidents']);
    expect(topicsForMutation('incidents/abc/deployments')).toEqual(['incidents', 'deployments']);
    expect(topicsForMutation('services/abc/checks')).toEqual(['services', 'monitoring']);
    expect(topicsForMutation('checks/abc/run')).toEqual(['monitoring', 'services']);
    expect(topicsForMutation('automation/rules')).toEqual(['automation']);
    expect(topicsForMutation('knowledge/abc')).toEqual(['knowledge']);
    expect(topicsForMutation('incidents/abc/investigations')).toEqual(['incidents', 'ai']);
    expect(topicsForMutation('')).toEqual(['organization']);
    expect(topicsForMutation('unknown/thing')).toEqual([]);
  });

  it('never throws when the publisher fails', async () => {
    const failing = { publish: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(publishRealtime(failing, ORG, [{ topic: 'incidents' }])).resolves.toBe(false);
    const ok = { publish: vi.fn().mockResolvedValue(1) };
    await expect(publishRealtime(ok, ORG, [{ topic: 'incidents' }])).resolves.toBe(true);
    expect(ok.publish).toHaveBeenCalledWith(realtimeChannel(ORG), '{"topic":"incidents"}');
    await expect(publishRealtime(failing, ORG, [])).resolves.toBe(true);
  });
});
