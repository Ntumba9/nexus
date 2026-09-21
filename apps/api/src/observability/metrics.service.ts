import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  HTTP_BUCKETS,
  MetricsRegistry,
  statusClass,
  type Counter,
  type Histogram,
} from '@nexus/shared';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from '../common/request-context';
import { requestStore } from '../common/request-store';
import { RealtimeHub } from '../realtime/realtime.hub';

/** Requests for these are not logged (probes and scrapes would drown everything else). */
const QUIET = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * What the API exposes about itself: request counts and latency by ROUTE TEMPLATE (never a URL with
 * ids, which would make the number of series unbounded), plus a few process gauges. It also writes
 * one structured log line per request, with the id that ties it to audit entries and worker logs.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger('http');
  readonly registry = new MetricsRegistry();
  private readonly requests: Counter;
  private readonly latency: Histogram;

  constructor(@Inject(RealtimeHub) hub: RealtimeHub) {
    this.requests = this.registry.counter(
      'nexus_http_requests_total',
      'HTTP requests handled, by method, route template and status class.',
    );
    this.latency = this.registry.histogram(
      'nexus_http_request_duration_seconds',
      'HTTP request duration in seconds, by method and route template.',
      HTTP_BUCKETS,
    );
    this.registry.gauge({
      name: 'nexus_realtime_connections',
      help: 'Open real-time (SSE) streams on this instance.',
      read: () => hub.connectionCount,
    });
    this.registry.gauge({
      name: 'nexus_process_uptime_seconds',
      help: 'Seconds since this process started.',
      read: () => process.uptime(),
    });
    this.registry.gauge({
      name: 'nexus_process_heap_used_bytes',
      help: 'V8 heap in use.',
      read: () => process.memoryUsage().heapUsed,
    });
    this.registry.gauge({
      name: 'nexus_process_resident_memory_bytes',
      help: 'Resident set size.',
      read: () => process.memoryUsage().rss,
    });
  }

  /** Express middleware: time the request, then count it and log it once it has finished. */
  middleware() {
    return (request: AppRequest, response: Response, next: NextFunction): void => {
      const started = process.hrtime.bigint();
      response.on('finish', () => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const route = request.route?.path
          ? `${request.baseUrl}${request.route.path as string}`
          : 'unmatched';
        if (route === '/metrics' || QUIET.has(request.path)) return;
        this.requests.inc({
          method: request.method,
          route,
          status: statusClass(response.statusCode),
        });
        this.latency.observe(seconds, { method: request.method, route });
        const scope = requestStore.getStore();
        const line = {
          method: request.method,
          route,
          status: response.statusCode,
          durationMs: Math.round(seconds * 1000),
          requestId: scope?.requestId,
        };
        // 5xx are errors; the rest are routine. (The request id, person and organization are added by
        // the logger from the request scope.)
        if (response.statusCode >= 500) this.logger.error(JSON.stringify(line));
        else this.logger.log(JSON.stringify(line));
      });
      next();
    };
  }
}
