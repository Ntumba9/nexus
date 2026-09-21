import { EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, embedLocally } from '@nexus/shared';

/**
 * Turns text into vectors. Behind an interface because Anthropic offers no embeddings endpoint and
 * because the right choice differs by deployment: the built-in local embedder needs nothing and is
 * the default; any OpenAI-compatible endpoint (a local Ollama, or a free hosted tier) gives real
 * semantic search when configured.
 */
export interface EmbeddingProvider {
  /** Stored with every vector. Vectors from different providers are never compared. */
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** A failure that says whether trying again could help. The message never contains a credential. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export function createLocalEmbeddingProvider(): EmbeddingProvider {
  return {
    id: LOCAL_EMBEDDING_MODEL,
    embed: (texts) => Promise.resolve(texts.map((text) => embedLocally(text))),
  };
}

export interface OpenAiEmbeddingConfig {
  /** Base URL up to and including `/v1`, for example `http://localhost:11434/v1`. */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** How many texts go in one request. */
  batchSize?: number;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
}

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: unknown }[];
}

/** An OpenAI-compatible `POST {url}/embeddings` client. The model must return 384 dimensions. */
export function createOpenAiEmbeddingProvider(config: OpenAiEmbeddingConfig): EmbeddingProvider {
  const endpoint = `${config.url.replace(/\/+$/, '')}/embeddings`;
  const fetchFn = config.fetchFn ?? fetch;
  const batchSize = config.batchSize ?? 16;
  const timeoutMs = config.timeoutMs ?? 30_000;

  async function embedBatch(texts: readonly string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Deliberately vague: the underlying error can contain the URL.
      throw new EmbeddingError('the embedding service could not be reached', true);
    }
    if (!response.ok) {
      const transient =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      throw new EmbeddingError(`the embedding service answered ${response.status}`, transient);
    }
    const body = (await response.json().catch(() => null)) as EmbeddingsResponse | null;
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbeddingError('the embedding service returned an unexpected response', false);
    }
    // The spec allows any order; `index` says which input each vector belongs to.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((item) => {
      const vector = item.embedding;
      if (
        !Array.isArray(vector) ||
        !vector.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        throw new EmbeddingError('the embedding service returned an invalid vector', false);
      }
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingError(
          `the model returned ${vector.length} dimensions but ${EMBEDDING_DIMENSIONS} are required; choose a ${EMBEDDING_DIMENSIONS}-dimension model`,
          false,
        );
      }
      return vector as number[];
    });
  }

  return {
    id: `openai:${config.model}`,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await embedBatch(texts.slice(i, i + batchSize))));
      }
      return out;
    },
  };
}

export interface EmbeddingSettings {
  provider: 'local' | 'openai';
  apiUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
}

/** Builds the configured provider. Throws at startup, not at the first search, if it is incomplete. */
export function createEmbeddingProvider(settings: EmbeddingSettings): EmbeddingProvider {
  if (settings.provider === 'local') return createLocalEmbeddingProvider();
  if (!settings.apiUrl || !settings.model) {
    throw new Error('EMBEDDING_PROVIDER=openai requires EMBEDDING_API_URL and EMBEDDING_MODEL');
  }
  return createOpenAiEmbeddingProvider({
    url: settings.apiUrl,
    model: settings.model,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  });
}
