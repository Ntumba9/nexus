import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import {
  decodeRealtimeMessage,
  organizationOfChannel,
  REALTIME_CHANNEL_PATTERN,
  type RealtimeMessage,
} from '@nexus/shared';
import { Redis } from 'ioredis';
import { ENV } from '../infrastructure/tokens';

export type RealtimeListener = (message: RealtimeMessage) => void;

/**
 * Receives every organisation's real-time signals from Redis over ONE subscriber connection and
 * hands them to the streams open on this API instance. Redis pub/sub is what lets several API
 * instances (and the worker) all reach the same browsers (ADR-004).
 */
@Injectable()
export class RealtimeHub implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly listeners = new Map<string, Set<RealtimeListener>>();
  private subscriber: Redis | null = null;

  constructor(@Inject(ENV) private readonly env: ApiEnv) {}

  onModuleInit(): void {
    // A subscriber connection cannot run other commands, so it is separate from the shared client.
    // ioredis resubscribes by itself after a reconnect.
    const subscriber = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    subscriber.on('error', (error: Error) =>
      this.logger.warn(`Realtime Redis error: ${error.message}`),
    );
    subscriber.on('pmessage', (_pattern: string, channel: string, raw: string) =>
      this.dispatch(channel, raw),
    );
    subscriber.psubscribe(REALTIME_CHANNEL_PATTERN).catch((error: unknown) => {
      this.logger.warn(
        `Realtime subscribe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.subscriber = subscriber;
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }

  /** Register a stream for one organisation; returns the function that removes it. */
  subscribe(organizationId: string, listener: RealtimeListener): () => void {
    let set = this.listeners.get(organizationId);
    if (!set) {
      set = new Set();
      this.listeners.set(organizationId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(organizationId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(organizationId);
    };
  }

  /** Number of open streams on this instance (used by tests and diagnostics). */
  get connectionCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  private dispatch(channel: string, raw: string): void {
    const organizationId = organizationOfChannel(channel);
    if (!organizationId) return;
    const message = decodeRealtimeMessage(raw);
    if (!message) return;
    for (const listener of this.listeners.get(organizationId) ?? []) {
      try {
        listener(message);
      } catch (error) {
        this.logger.warn(
          `Realtime listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
