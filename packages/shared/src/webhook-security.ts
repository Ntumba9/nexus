/**
 * Cryptography for the GitHub integration.
 *
 * Node-only: import from `@nexus/shared/webhook-security`, never from the package root, because the
 * web bundle imports the root and must not pull in `node:crypto`.
 *
 *  - `verifyGitHubSignature`: HMAC-SHA256 over the RAW request body, compared in constant time.
 *  - `encryptSecret` / `decryptSecret`: AES-256-GCM for webhook secrets at rest. The row id is bound
 *    as additional authenticated data, so a ciphertext copied onto another row fails to decrypt.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

export function computeGitHubSignature(secret: string, rawBody: Buffer): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * True only if `header` is the correct `sha256=<hex>` signature of `rawBody`. Any malformed or
 * missing header is simply "not valid"; the comparison never short-circuits on content.
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const expected = Buffer.from(computeGitHubSignature(secret, rawBody));
  const received = Buffer.from(header);
  // timingSafeEqual throws on unequal lengths, so compare lengths first (length is not secret).
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** A new random webhook secret (256 bits, hex), shown to the user exactly once. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, base64-encoded`);
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored: string, key: Buffer, aad: string): string {
  const [version, iv, tag, ciphertext] = stored.split(':');
  if (version !== FORMAT_VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Unrecognised encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
