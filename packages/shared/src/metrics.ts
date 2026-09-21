/**
 * A tiny, dependency-free metrics registry that renders the Prometheus text format (Phase 10,
 * ADR-017). Counters and histograms keep one number per label combination, so callers must only ever
 * use labels with a small, fixed set of values (a route TEMPLATE, never a URL with ids in it).
 */

type Labels = Readonly<Record<string, string>>;

const escapeValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}="${escapeValue(labels[name]!)}"`)
    .join(',');

/** A metric name or label name must match Prometheus's grammar; refuse anything else early. */
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid metric or label name: ${name}`);
}

/** Bounds how many label combinations one metric may hold, so a bug cannot grow memory without limit. */
const MAX_SERIES = 500;

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {
    assertName(name);
  }

  inc(labels: Labels = {}, by = 1): void {
    for (const label of Object.keys(labels)) assertName(label);
    const key = labelKey(labels);
    if (!this.values.has(key) && this.values.size >= MAX_SERIES) return;
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ''} ${value}`);
    }
    return lines;
  }
}

export class Histogram {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: readonly number[],
  ) {
    assertName(name);
  }

  observe(value: number, labels: Labels = {}): void {
    for (const label of Object.keys(labels)) assertName(label);
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES) return;
      entry = { buckets: new Array<number>(this.bounds.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.bounds.forEach((bound, i) => {
      if (value <= bound) entry.buckets[i]! += 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.series) {
      const prefix = key ? `${key},` : '';
      this.bounds.forEach((bound, i) => {
        lines.push(`${this.name}_bucket{${prefix}le="${bound}"} ${entry.buckets[i]}`);
      });
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${entry.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ''} ${entry.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ''} ${entry.count}`);
    }
    return lines;
  }
}

/** A value read at scrape time (open connections, queue depth, memory). */
export interface GaugeSource {
  name: string;
  help: string;
  read(): number | Promise<number>;
}

export class MetricsRegistry {
  private readonly counters: Counter[] = [];
  private readonly histograms: Histogram[] = [];
  private readonly gauges: GaugeSource[] = [];

  counter(name: string, help: string): Counter {
    const counter = new Counter(name, help);
    this.counters.push(counter);
    return counter;
  }

  histogram(name: string, help: string, bounds: readonly number[]): Histogram {
    const histogram = new Histogram(name, help, bounds);
    this.histograms.push(histogram);
    return histogram;
  }

  gauge(source: GaugeSource): void {
    assertName(source.name);
    this.gauges.push(source);
  }

  /** The Prometheus text exposition. A gauge that fails to read is left out, never fatal. */
  async render(): Promise<string> {
    const lines: string[] = [];
    for (const counter of this.counters) lines.push(...counter.render());
    for (const histogram of this.histograms) lines.push(...histogram.render());
    for (const gauge of this.gauges) {
      try {
        const value = await gauge.read();
        if (Number.isFinite(value)) {
          lines.push(
            `# HELP ${gauge.name} ${gauge.help}`,
            `# TYPE ${gauge.name} gauge`,
            `${gauge.name} ${value}`,
          );
        }
      } catch {
        // Skip it: a broken probe must not take the whole scrape down.
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Latency buckets in seconds, from 5 ms to 10 s. */
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** `2xx`, `4xx`… so status codes stay a small, fixed set of label values. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** Constant-time comparison of a presented bearer token against the configured one. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  // Compare fixed-length digests' worth of work regardless of where the strings differ.
  let diff = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (presented.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0 && expected.length > 0;
}
