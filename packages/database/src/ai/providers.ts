import {
  RULES_ANALYSIS_LABEL,
  analyzeWithRules,
  buildInvestigationPrompt,
  extractJsonObject,
  type ContextSource,
  type IncidentHeader,
} from '@nexus/shared';

/** What every analysis provider is given. Sources are already redacted and length-limited. */
export interface AnalysisInput {
  incident: IncidentHeader;
  sources: readonly ContextSource[];
  question?: string | null;
}

/**
 * Produces an answer for an incident. The result is UNTRUSTED until the worker has validated it
 * against the answer schema and verified its citations, whatever provider made it.
 */
export interface AnalysisProvider {
  /** Stored with each investigation. */
  readonly id: string;
  /** Shown to people: "llama3.1 (Ollama)", "Built-in rule-based analysis (no AI model)". */
  readonly label: string;
  readonly kind: 'model' | 'rules';
  analyze(input: AnalysisInput): Promise<unknown>;
}

/** A failure that says whether trying again could help. The message never contains a credential. */
export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/** The free, offline default: deterministic rules over the assembled facts. No model, no network. */
export function createRulesProvider(): AnalysisProvider {
  return {
    id: 'rules-v1',
    label: RULES_ANALYSIS_LABEL,
    kind: 'rules',
    analyze: (input) => Promise.resolve(analyzeWithRules(input)),
  };
}

export interface OpenAiChatConfig {
  /** Base URL up to and including `/v1`, for example `http://localhost:11434/v1`. */
  url: string;
  model: string;
  apiKey?: string;
  /** Shown in the UI next to the model name, for example "Ollama" or "Groq". */
  vendor?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
}

const isTransient = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * An OpenAI-compatible `POST {url}/chat/completions` client. It works with a local Ollama, and with
 * free hosted tiers that speak the same protocol (Groq, Google Gemini's OpenAI endpoint, OpenRouter).
 * It asks for a JSON object, retries once without `response_format` for servers that reject it, and
 * never puts the URL, the key or the model's reply into an error.
 */
export function createOpenAiChatProvider(config: OpenAiChatConfig): AnalysisProvider {
  const endpoint = `${config.url.replace(/\/+$/, '')}/chat/completions`;
  const fetchFn = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? 90_000;

  async function call(system: string, user: string, jsonMode: boolean): Promise<Response> {
    try {
      return await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          max_tokens: config.maxTokens ?? 1800,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Deliberately vague: the underlying error can contain the URL.
      throw new AnalysisError('the AI service could not be reached', true);
    }
  }

  return {
    id: `openai:${config.model}`,
    label: config.vendor ? `${config.model} (${config.vendor})` : config.model,
    kind: 'model',
    async analyze(input) {
      const { system, user } = buildInvestigationPrompt(input);
      let response = await call(system, user, true);
      if (response.status === 400) response = await call(system, user, false);
      if (!response.ok) {
        throw new AnalysisError(
          `the AI service answered ${response.status}`,
          isTransient(response.status),
        );
      }
      const body = (await response.json().catch(() => null)) as ChatResponse | null;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new AnalysisError('the AI service returned an empty answer', true);
      }
      try {
        return extractJsonObject(content);
      } catch {
        // The model did not return JSON. Trying again often works, so it is retryable.
        throw new AnalysisError('the AI service did not return a usable answer', true);
      }
    },
  };
}

export interface AnalysisSettings {
  provider: 'rules' | 'openai' | 'none';
  apiUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  vendor?: string | undefined;
}

/** `null` means AI investigation is switched off. Throws at startup if the settings are incomplete. */
export function createAnalysisProvider(settings: AnalysisSettings): AnalysisProvider | null {
  if (settings.provider === 'none') return null;
  if (settings.provider === 'rules') return createRulesProvider();
  if (!settings.apiUrl || !settings.model) {
    throw new Error('AI_PROVIDER=openai requires AI_API_URL and AI_MODEL');
  }
  return createOpenAiChatProvider({
    url: settings.apiUrl,
    model: settings.model,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    ...(settings.vendor ? { vendor: settings.vendor } : {}),
  });
}
