import { EMBEDDING_DIMENSIONS } from '@nexus/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  EmbeddingError,
  createEmbeddingProvider,
  createLocalEmbeddingProvider,
  createOpenAiEmbeddingProvider,
} from './embeddings';
import { toVectorLiteral } from './write';

const vector = (fill: number) => new Array<number>(EMBEDDING_DIMENSIONS).fill(fill);

const respond = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const provider = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
  createOpenAiEmbeddingProvider({
    url: 'http://localhost:11434/v1/',
    model: 'all-minilm',
    apiKey: 'sk-secret-key',
    fetchFn,
    ...extra,
  });

describe('local provider', () => {
  it('embeds deterministically, one vector per text', async () => {
    const local = createLocalEmbeddingProvider();
    const [a, b] = await local.embed(['restart the service', 'restart the service']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(local.id).toBe('local-hash-v1');
  });
});

describe('OpenAI-compatible provider', () => {
  it('posts to {url}/embeddings with the model, input and bearer token', async () => {
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return respond({ data: [{ index: 0, embedding: vector(0.1) }] });
    });
    const result = await provider(fetchFn as unknown as typeof fetch).embed(['hello']);
    expect(result).toEqual([vector(0.1)]);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/embeddings');
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'all-minilm', input: ['hello'] });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret-key');
  });

  it('sends no Authorization header without a key', async () => {
    const fetchFn = vi.fn(() => respond({ data: [{ index: 0, embedding: vector(0.1) }] }));
    await createOpenAiEmbeddingProvider({
      url: 'http://x/v1',
      model: 'm',
      fetchFn: fetchFn as unknown as typeof fetch,
    }).embed(['a']);
    const init = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('puts vectors back in input order using `index`, and batches large inputs', async () => {
    const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => {
      const input = JSON.parse(init!.body as string).input as string[];
      // Answer in reverse order, as the spec permits.
      return respond({
        data: input.map((text, i) => ({ index: i, embedding: vector(Number(text)) })).reverse(),
      });
    });
    const texts = Array.from({ length: 5 }, (_, i) => String(i));
    const out = await provider(fetchFn as unknown as typeof fetch, { batchSize: 2 }).embed(texts);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(out.map((v) => v[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it('identifies itself by model, so its vectors never mix with another provider’s', () => {
    expect(provider(vi.fn() as unknown as typeof fetch).id).toBe('openai:all-minilm');
  });

  it('classifies HTTP failures as retryable or permanent, without leaking the key', async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [401, false],
      [404, false],
      [400, false],
    ] as const) {
      const error = await provider((() => respond({}, status)) as unknown as typeof fetch)
        .embed(['x'])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as EmbeddingError).retryable, String(status)).toBe(retryable);
      expect(String(error)).not.toContain('sk-secret-key');
    }
  });

  it('treats a network failure as retryable and does not echo the URL or the cause', async () => {
    const error = await provider((() =>
      Promise.reject(
        new Error('connect ECONNREFUSED http://localhost:11434 sk-secret-key'),
      )) as typeof fetch)
      .embed(['x'])
      .catch((e: unknown) => e);
    expect((error as EmbeddingError).retryable).toBe(true);
    expect(String(error)).not.toMatch(/localhost|sk-secret-key/);
  });

  it('rejects a model with the wrong dimensions, permanently, and says what to do', async () => {
    const error = await provider((() =>
      respond({ data: [{ index: 0, embedding: [0.1, 0.2] }] })) as unknown as typeof fetch)
      .embed(['x'])
      .catch((e: unknown) => e);
    expect((error as EmbeddingError).retryable).toBe(false);
    expect(String(error)).toMatch(/2 dimensions but 384/);
  });

  it('rejects malformed responses', async () => {
    for (const body of [
      {},
      { data: [] },
      { data: [{ index: 0, embedding: 'nope' }] },
      { data: [{ index: 0, embedding: [...vector(0.1).slice(1), 'x'] }] },
      { data: [{ index: 0, embedding: [...vector(0.1).slice(1), Number.NaN] }] },
    ]) {
      const error = await provider((() => respond(body)) as unknown as typeof fetch)
        .embed(['x'])
        .catch((e: unknown) => e);
      expect(error, JSON.stringify(body).slice(0, 40)).toBeInstanceOf(EmbeddingError);
      expect((error as EmbeddingError).retryable).toBe(false);
    }
  });
});

describe('createEmbeddingProvider', () => {
  it('builds each kind and refuses an incomplete remote configuration', () => {
    expect(createEmbeddingProvider({ provider: 'local' }).id).toBe('local-hash-v1');
    expect(() => createEmbeddingProvider({ provider: 'openai', model: 'm' })).toThrow(
      /EMBEDDING_API_URL/,
    );
    expect(() => createEmbeddingProvider({ provider: 'openai', apiUrl: 'http://x/v1' })).toThrow(
      /EMBEDDING_MODEL/,
    );
    expect(
      createEmbeddingProvider({ provider: 'openai', apiUrl: 'http://x/v1', model: 'm' }).id,
    ).toBe('openai:m');
  });
});

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral(vector(0.5)).startsWith('[0.5,0.5')).toBe(true);
  });
  it('refuses the wrong length and non-finite numbers', () => {
    expect(() => toVectorLiteral([1, 2])).toThrow();
    expect(() => toVectorLiteral([...vector(0).slice(1), Number.NaN])).toThrow();
    expect(() => toVectorLiteral([...vector(0).slice(1), Infinity])).toThrow();
  });
});
