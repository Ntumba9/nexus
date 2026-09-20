import { HTTP_BUCKETS, MetricsRegistry } from '@nexus/shared';

/** What a worker process exposes about itself (see the health server's `/metrics`). */
export const registry = new MetricsRegistry();

export const jobsTotal = registry.counter(
  'nexus_worker_jobs_total',
  'Jobs finished by this worker, by queue and outcome (completed or failed attempt).',
);

export const jobDuration = registry.histogram(
  'nexus_worker_job_duration_seconds',
  'How long jobs took to run, by queue.',
  HTTP_BUCKETS,
);

registry.gauge({
  name: 'nexus_process_uptime_seconds',
  help: 'Seconds since this process started.',
  read: () => process.uptime(),
});
registry.gauge({
  name: 'nexus_process_heap_used_bytes',
  help: 'V8 heap in use.',
  read: () => process.memoryUsage().heapUsed,
});
registry.gauge({
  name: 'nexus_process_resident_memory_bytes',
  help: 'Resident set size.',
  read: () => process.memoryUsage().rss,
});
