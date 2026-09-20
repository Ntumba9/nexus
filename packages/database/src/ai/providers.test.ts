import { investigationOutputSchema, type ContextSource, type IncidentHeader } from '@nexus/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisError,
  createAnalysisProvider,
  createOpenAiChatProvider,
  createRulesProvider,
} from './providers';

const incident: IncidentHeader = {
  number: 1,
  title: 'Checkout down',
  description: '',
  severity: 'SEV1',
  status: 'OPEN',
  createdAt: '2026-09-22T10:00:00.000Z',
  serviceName: 'Checkout',
  serviceEnvironment: 'PRODUCTION',
  serviceHealth: 'DOWN',
  tags: [],
};
const sources: ContextSource[] = [
  {
    label: 'DEP-1',
    kind: 'deployment',
    title: 'Deploy',
    text: 'deployed main',
    occurredAt: null,
    refId: null,
    facts: { status: 'SUCCESS', minutesBeforeOnset: 5, sha7: 'abc1234' },
  },
];

const reply = (content: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }),
  );

const make = (fetchFn: unknown, extra: Record<string, unknown> = {}) =>
  createOpenAiChatProvider({
    url: 'http://localhost:11434/v1/',
    model: 'llama3.1',
    apiKey: 'sk-secret-key',
    vendor: 'Ollama',
    fetchFn: fetchFn as typeof fetch,
    ...extra,
  });

const failure = (p: Promise<unknown>) => p.catch((e: unknown) => e) as Promise<AnalysisError>;

describe('rules provider', () => {
  it('needs no network and returns a valid, labelled answer', async () => {
    const provider = createRulesProvider();
    expect(provider.kind).toBe('rules');
    expect(provider.label).toMatch(/no AI model/);
    const out = await provider.analyze({ incident, sources });
    expect(investigationOutputSchema.safeParse(out).success).toBe(true);
  });
});

describe('OpenAI-compatible chat provider', () => {
  it('posts the prompt with the model, low temperature, JSON mode and the bearer token', async () => {
    const fetchFn = vi.fn((_u: unknown, _i?: RequestInit) => reply('{"a":1}'));
    const out = await make(fetchFn).analyze({ incident, sources, question: 'why?' });
    expect(out).toEqual({ a: 1 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: 'llama3.1',
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/UNTRUSTED DATA/);
    expect(body.messages[1].content).toContain('<source label="DEP-1"');
    expect(body.messages[1].content).toContain('<question>');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret-key');
  });

  it('labels itself with the model and vendor', () => {
    const provider = make(vi.fn());
    expect(provider.label).toBe('llama3.1 (Ollama)');
    expect(provider.id).toBe('openai:llama3.1');
    expect(provider.kind).toBe('model');
  });

  it('reads JSON wrapped in a code fence or prose', async () => {
    expect(
      await make(() => reply('```json\n{"ok":true}\n```')).analyze({ incident, sources }),
    ).toEqual({ ok: true });
    expect(
      await make(() => reply('Sure! {"ok":true} Done.')).analyze({ incident, sources }),
    ).toEqual({ ok: true });
  });

  it('retries once without response_format when the server rejects it', async () => {
    const fetchFn = vi.fn((_u: unknown, init?: RequestInit) =>
      JSON.parse(init!.body as string).response_format
        ? Promise.resolve(new Response('{}', { status: 400 }))
        : reply('{"ok":1}'),
    );
    expect(await make(fetchFn).analyze({ incident, sources })).toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('classifies HTTP failures as retryable or permanent, without leaking the key', async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [401, false],
      [403, false],
      [404, false],
    ] as const) {
      const error = await failure(
        make(() => Promise.resolve(new Response('{"secret":"sk-secret-key"}', { status }))).analyze(
          { incident, sources },
        ),
      );
      expect(error).toBeInstanceOf(AnalysisError);
      expect(error.retryable, String(status)).toBe(retryable);
      expect(String(error)).not.toMatch(/sk-secret-key|secret/);
    }
  });

  it('treats a network failure as retryable and hides the URL and cause', async () => {
    const error = await failure(
      make(() =>
        Promise.reject(new Error('ECONNREFUSED http://localhost:11434 sk-secret-key')),
      ).analyze({ incident, sources }),
    );
    expect(error.retryable).toBe(true);
    expect(String(error)).not.toMatch(/localhost|sk-secret-key/);
  });

  it('treats an empty or non-JSON reply as retryable and never echoes the reply', async () => {
    for (const content of ['', '   ', null, 42, 'I cannot help with that, sk-secret-key']) {
      const error = await failure(make(() => reply(content)).analyze({ incident, sources }));
      expect(error.retryable).toBe(true);
      expect(String(error)).not.toContain('I cannot help');
    }
    const noChoices = await failure(
      make(() => Promise.resolve(new Response('{}'))).analyze({ incident, sources }),
    );
    expect(noChoices).toBeInstanceOf(AnalysisError);
  });

  it('times out instead of hanging', async () => {
    const slow = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const error = await failure(make(slow, { timeoutMs: 50 }).analyze({ incident, sources }));
    expect(error.retryable).toBe(true);
  });
});

describe('createAnalysisProvider', () => {
  it('builds each kind, returns null when disabled and refuses an incomplete remote setup', () => {
    expect(createAnalysisProvider({ provider: 'none' })).toBeNull();
    expect(createAnalysisProvider({ provider: 'rules' })!.kind).toBe('rules');
    expect(() => createAnalysisProvider({ provider: 'openai', model: 'm' })).toThrow(/AI_API_URL/);
    expect(() => createAnalysisProvider({ provider: 'openai', apiUrl: 'http://x/v1' })).toThrow(
      /AI_MODEL/,
    );
    expect(
      createAnalysisProvider({
        provider: 'openai',
        apiUrl: 'http://x/v1',
        model: 'm',
        vendor: 'V',
      })!.label,
    ).toBe('m (V)');
  });
});
