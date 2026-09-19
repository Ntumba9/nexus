/**
 * Server-side request forgery (SSRF) protection for anything that makes HTTP requests to a
 * user-supplied URL (monitoring today; webhooks and integrations later).
 *
 * Node-only: import from `@nexus/shared/net-safety`, never from the package root, because the web
 * bundle imports the root and must not pull in `node:net`.
 *
 * Two layers, both required:
 *  1. `validateMonitoringUrl` rejects obviously unsafe URLs when they are saved.
 *  2. `createSafeLookup` resolves the hostname at REQUEST time, refuses if ANY resolved address is
 *     non-public, and hands the connection only those validated addresses. Checking at request time
 *     (not just at save time) defeats DNS rebinding, where a name resolves publicly when saved and to
 *     an internal address later.
 */
import dns from 'node:dns';
import net from 'node:net';

const blockList = new net.BlockList();
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];
for (const [address, prefix] of V4) blockList.addSubnet(address, prefix, 'ipv4');
const V6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (can reach IPv4 internals)
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [address, prefix] of V6) blockList.addSubnet(address, prefix, 'ipv6');

/** Extract the embedded IPv4 from an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:aabb:ccdd). */
function unmapV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

/** True for anything that is not a routable public unicast address, and for anything unparseable. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true; // fail closed on anything that is not an IP literal
  if (family === 6) {
    const mapped = unmapV4(address);
    if (mapped) return isBlockedAddress(mapped);
    return blockList.check(address, 'ipv6');
  }
  return blockList.check(address, 'ipv4');
}

const INTERNAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home.arpa',
];

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Static checks applied when a monitoring URL is saved. `allowPrivate` is an explicit operator
 * opt-in for monitoring internal services (self-hosted deployments, local development, tests).
 */
export function validateMonitoringUrl(
  raw: string,
  options: { allowPrivate: boolean },
): UrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Enter a valid URL, for example https://example.com/health' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http:// and https:// URLs can be monitored' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs must not contain a username or password' };
  }
  if (options.allowPrivate) return { ok: true, url };

  // A trailing dot is a valid fully-qualified form ("localhost." is localhost), so normalise it away.
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  const isLiteralIp = net.isIP(host) !== 0;
  if (isLiteralIp && isBlockedAddress(host)) {
    return { ok: false, reason: 'That address is private or internal and cannot be monitored' };
  }
  if (!isLiteralIp && (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s)))) {
    return { ok: false, reason: 'Internal hostnames cannot be monitored' };
  }
  if (!isLiteralIp && !host.includes('.')) {
    return { ok: false, reason: 'Use a fully qualified hostname (for example api.example.com)' };
  }
  return { ok: true, url };
}

export class BlockedAddressError extends Error {
  readonly code = 'BLOCKED_ADDRESS';
  constructor(hostname: string) {
    super(`Refusing to connect to a non-public address for ${hostname}`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` function for `http(s).request` that only ever returns validated addresses. Node's
 * happy-eyeballs connection logic calls it with `all: true` and expects an array; otherwise it
 * expects a single address, so both shapes are supported.
 */
export function createSafeLookup(options: { allowPrivate: boolean }) {
  return (hostname: string, lookupOptions: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!options.allowPrivate && addresses.some((entry) => isBlockedAddress(entry.address))) {
        return callback(new BlockedAddressError(hostname) as NodeJS.ErrnoException, '');
      }
      const wantedFamily =
        lookupOptions.family === 4 || lookupOptions.family === 6 ? lookupOptions.family : 0;
      const usable = wantedFamily
        ? addresses.filter((entry) => entry.family === wantedFamily)
        : addresses;
      if (usable.length === 0) {
        const notFound = new Error(`No address found for ${hostname}`) as NodeJS.ErrnoException;
        notFound.code = 'ENOTFOUND';
        return callback(notFound, '');
      }
      if (lookupOptions.all) return callback(null, usable);
      callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}
