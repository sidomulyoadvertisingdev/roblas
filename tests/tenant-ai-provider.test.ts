import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GroqProvider, OpenAiProvider, CustomProvider, createAiProvider } from '../src/tenant/ai-provider.js';
import type { Logger } from '../src/logger.js';
import type { TenantAiConfig } from '../src/tenant/types.js';

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const mockSuccessResponse = {
  ok: true,
  json: vi.fn().mockResolvedValue({
    choices: [{ message: { content: '{"intent":"help","params":{}}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }),
  text: vi.fn().mockResolvedValue(''),
};

const mockEmptyChoicesResponse = {
  ok: true,
  json: vi.fn().mockResolvedValue({ choices: [] }),
  text: vi.fn().mockResolvedValue(''),
};

const mockNoUsageResponse = {
  ok: true,
  json: vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'hello' } }],
  }),
  text: vi.fn().mockResolvedValue(''),
};

const mockErrorResponse = {
  ok: false,
  status: 429,
  text: vi.fn().mockResolvedValue('Rate limited'),
};

describe('GroqProvider', () => {
  let logger: Logger;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct request to Groq API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse);
    globalThis.fetch = fetchMock;

    const provider = new GroqProvider('test-key', 'llama-3.1-8b-instant', logger);
    const result = await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({
      'content-type': 'application/json',
      'authorization': 'Bearer test-key',
    });
    expect(result.content).toBe('{"intent":"help","params":{}}');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  });

  it('uses default temperature and maxTokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse);
    globalThis.fetch = fetchMock;

    const provider = new GroqProvider('key', 'model', logger);
    await provider.chat([{ role: 'user', content: 'test' }]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses custom options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse);
    globalThis.fetch = fetchMock;

    const provider = new GroqProvider('key', 'model', logger);
    await provider.chat([{ role: 'user', content: 'test' }], { temperature: 0.7, maxTokens: 512 });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(512);
  });

  it('returns empty content when choices is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockEmptyChoicesResponse);
    globalThis.fetch = fetchMock;

    const provider = new GroqProvider('key', 'model', logger);
    const result = await provider.chat([{ role: 'user', content: 'test' }]);
    expect(result.content).toBe('');
  });

  it('returns undefined usage when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockNoUsageResponse);
    globalThis.fetch = fetchMock;

    const provider = new GroqProvider('key', 'model', logger);
    const result = await provider.chat([{ role: 'user', content: 'test' }]);
    expect(result.usage).toBeUndefined();
  });

  it('throws on non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockErrorResponse);
    globalThis.fetch = fetchMock;

    const provider = new GroqProvider('key', 'model', logger);
    await expect(provider.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('Groq API error: 429');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('OpenAiProvider', () => {
  let logger: Logger;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct request to OpenAI API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse);
    globalThis.fetch = fetchMock;

    const provider = new OpenAiProvider('sk-test', 'gpt-4', logger);
    const result = await provider.chat([{ role: 'system', content: 'You are helpful' }, { role: 'user', content: 'hi' }]);

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.headers).toEqual({
      'content-type': 'application/json',
      'authorization': 'Bearer sk-test',
    });
    expect(result.content).toBe('{"intent":"help","params":{}}');
  });

  it('throws on non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ...mockErrorResponse, status: 401 });
    globalThis.fetch = fetchMock;

    const provider = new OpenAiProvider('bad-key', 'gpt-4', logger);
    await expect(provider.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('OpenAI API error: 401');
  });
});

describe('CustomProvider', () => {
  let logger: Logger;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses model field as URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse);
    globalThis.fetch = fetchMock;

    const provider = new CustomProvider('key', 'https://my-llm.com/v1/chat', logger);
    await provider.chat([{ role: 'user', content: 'test' }]);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://my-llm.com/v1/chat');
  });

  it('throws on non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ...mockErrorResponse, status: 500 });
    globalThis.fetch = fetchMock;

    const provider = new CustomProvider('key', 'https://my-llm.com/v1/chat', logger);
    await expect(provider.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('Custom API error: 500');
  });
});

describe('createAiProvider', () => {
  const logger = createMockLogger();

  it('returns GroqProvider for groq provider', () => {
    const config: TenantAiConfig = { provider: 'groq', apiKey: 'key', model: 'model', systemPrompt: null, responseTemplate: null, maxTokens: 256 };
    const provider = createAiProvider(config, logger);
    expect(provider).toBeInstanceOf(GroqProvider);
  });

  it('returns OpenAiProvider for openai provider', () => {
    const config: TenantAiConfig = { provider: 'openai', apiKey: 'key', model: 'model', systemPrompt: null, responseTemplate: null, maxTokens: 256 };
    const provider = createAiProvider(config, logger);
    expect(provider).toBeInstanceOf(OpenAiProvider);
  });

  it('returns CustomProvider for custom provider', () => {
    const config: TenantAiConfig = { provider: 'custom', apiKey: 'key', model: 'https://custom.api/llm', systemPrompt: null, responseTemplate: null, maxTokens: 256 };
    const provider = createAiProvider(config, logger);
    expect(provider).toBeInstanceOf(CustomProvider);
  });

  it('returns null when apiKey is missing and no globalApiKey', () => {
    const config: TenantAiConfig = { provider: 'groq', apiKey: null, model: 'model', systemPrompt: null, responseTemplate: null, maxTokens: 256 };
    expect(createAiProvider(config, logger)).toBeNull();
  });

  it('uses globalApiKey when tenant apiKey is missing', () => {
    const config: TenantAiConfig = { provider: 'groq', apiKey: null, model: 'model', systemPrompt: null, responseTemplate: null, maxTokens: 256 };
    const provider = createAiProvider(config, logger, 'global-key-123');
    expect(provider).toBeInstanceOf(GroqProvider);
  });

  it('prefers tenant apiKey over globalApiKey', () => {
    const config: TenantAiConfig = { provider: 'groq', apiKey: 'tenant-key', model: 'model', systemPrompt: null, responseTemplate: null, maxTokens: 256 };
    const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse);
    globalThis.fetch = fetchMock;

    const provider = createAiProvider(config, logger, 'global-key-123');
    expect(provider).toBeInstanceOf(GroqProvider);

    void provider!.chat([{ role: 'user', content: 'test' }]);
    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers).toMatchObject({ authorization: 'Bearer tenant-key' });
  });

  it('returns null for unknown provider', () => {
    const config = { provider: 'unknown', apiKey: 'key', model: 'model', systemPrompt: null, responseTemplate: null, maxTokens: 256 } as unknown as TenantAiConfig;
    expect(createAiProvider(config, logger)).toBeNull();
  });
});
