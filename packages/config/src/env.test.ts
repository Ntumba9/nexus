import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, loadEnv, workerEnvSchema } from './index';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('applies defaults and coerces types', () => {
    const env = loadEnv(apiEnvSchema, { ...valid, API_PORT: '4000' });
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('rejects missing required variables', () => {
    expect(() => loadEnv(apiEnvSchema, {})).toThrow(EnvValidationError);
  });

  it('rejects wrong protocols', () => {
    expect(() => loadEnv(apiEnvSchema, { ...valid, DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('does not leak secret values in error messages', () => {
    const attempt = () =>
      loadEnv(apiEnvSchema, { ...valid, DATABASE_URL: 'mysql://user:supersecret@h/db' });
    expect(attempt).toThrow(EnvValidationError);
    expect(attempt).not.toThrow(/supersecret/);
  });

  it('validates worker settings', () => {
    expect(() =>
      loadEnv(workerEnvSchema, { REDIS_URL: valid.REDIS_URL, WORKER_CONCURRENCY: '0' }),
    ).toThrow(/WORKER_CONCURRENCY/);
  });

  it('treats a missing or blank ANTHROPIC_API_KEY as "AI disabled", not an error', () => {
    expect(loadEnv(apiEnvSchema, valid).ANTHROPIC_API_KEY).toBeUndefined();
    expect(
      loadEnv(apiEnvSchema, { ...valid, ANTHROPIC_API_KEY: '  ' }).ANTHROPIC_API_KEY,
    ).toBeUndefined();
    expect(loadEnv(apiEnvSchema, { ...valid, ANTHROPIC_API_KEY: 'k' }).ANTHROPIC_API_KEY).toBe('k');
  });
});

describe('session and rate-limit settings', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('has safe defaults', () => {
    const env = loadEnv(apiEnvSchema, base);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.SESSION_IDLE_TTL_HOURS).toBe(168);
    expect(env.SESSION_ABSOLUTE_TTL_DAYS).toBe(30);
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(10);
    expect(env.COOKIE_SECURE).toBeUndefined();
  });

  it('rejects nonsensical values', () => {
    expect(() => loadEnv(apiEnvSchema, { ...base, AUTH_RATE_LIMIT_MAX: '0' })).toThrow(
      /AUTH_RATE_LIMIT_MAX/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...base, COOKIE_SECURE: 'yes' })).toThrow(/COOKIE_SECURE/);
  });
});

describe('embedding configuration', () => {
  it('defaults to the built-in local provider, for the api and the worker', () => {
    for (const schema of [apiEnvSchema, workerEnvSchema]) {
      const env = loadEnv(schema, valid);
      expect(env.EMBEDDING_PROVIDER).toBe('local');
      expect(env.EMBEDDING_API_URL).toBeUndefined();
      expect(env.EMBEDDING_API_KEY).toBeUndefined();
    }
  });

  it('accepts an OpenAI-compatible endpoint and trims the secret', () => {
    const env = loadEnv(workerEnvSchema, {
      ...valid,
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_API_URL: 'http://localhost:11434/v1',
      EMBEDDING_MODEL: ' all-minilm ',
      EMBEDDING_API_KEY: '  sk-test  ',
    });
    expect(env.EMBEDDING_MODEL).toBe('all-minilm');
    expect(env.EMBEDDING_API_KEY).toBe('sk-test');
  });

  it('rejects an unknown provider and a non-http URL, without echoing the key', () => {
    expect(() => loadEnv(apiEnvSchema, { ...valid, EMBEDDING_PROVIDER: 'magic' })).toThrow(
      /EMBEDDING_PROVIDER/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...valid, EMBEDDING_API_URL: 'ftp://x' })).toThrow(
      /EMBEDDING_API_URL/,
    );
    try {
      loadEnv(apiEnvSchema, {
        ...valid,
        EMBEDDING_PROVIDER: 'nope',
        EMBEDDING_API_KEY: 'sk-super-secret',
      });
    } catch (error) {
      expect(String(error)).not.toContain('sk-super-secret');
    }
  });
});
