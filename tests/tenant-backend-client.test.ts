import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BackendClient } from '../src/tenant/backend-client.js';
import type { Logger } from '../src/logger.js';
import type { TenantConfig } from '../src/tenant/types.js';
import { DEFAULT_TENANT_CONFIG } from '../src/tenant/types.js';

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return { ...DEFAULT_TENANT_CONFIG, ...overrides };
}

describe('BackendClient', () => {
  let logger: Logger;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns error when no webhook URL configured', async () => {
    const client = new BackendClient({ config: makeConfig({ webhookUrl: null }), logger });
    const result = await client.fetch('/webhook');
    expect(result.success).toBe(false);
    expect(result.error).toBe('No webhook URL configured');
  });

  it('makes GET request with correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: 'ok' }),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
    const result = await client.fetch('/health');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/health');
    expect(opts.method).toBe('GET');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ status: 'ok' });
  });

  it('makes POST request with body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ received: true }),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
    const result = await client.fetch('/webhook', {
      method: 'POST',
      body: { intent: 'order', params: { item: 'roti' } },
    });

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/webhook');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"intent":"order","params":{"item":"roti"}}');
    expect(result.success).toBe(true);
  });

  it('posts to the exact configured webhook URL when path is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ received: true }),
    });
    globalThis.fetch = fetchMock;

    const webhookUrl = 'https://api.example.com/api/integrations/attendance/report';
    const client = new BackendClient({ config: makeConfig({ webhookUrl }), logger });
    await client.fetch('', { method: 'POST', body: { intent: 'attendance' } });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(webhookUrl);
  });

  it('appends query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
    await client.fetch('/search', { queryParams: { q: 'test', page: '1' } });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/search?q=test&page=1');
  });

  it('adds bearer token auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({
      config: makeConfig({
        webhookUrl: 'https://api.example.com',
        webhookAuthMode: 'bearer',
        webhookBearerToken: 'my-token-123',
      }),
      logger,
    });
    await client.fetch('/webhook');

    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers['authorization']).toBe('Bearer my-token-123');
  });

  it('adds HMAC signature header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({
      config: makeConfig({
        webhookUrl: 'https://api.example.com',
        webhookAuthMode: 'hmac',
        webhookSecret: 'secret-key',
      }),
      logger,
    });
    await client.fetch('/webhook', {
      method: 'POST',
      body: { data: 'test' },
    });

    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers['x-wa-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('returns error on non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
    const result = await client.fetch('/webhook');

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns error on network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock;

    const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
    const result = await client.fetch('/webhook');

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('sets user-agent header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    globalThis.fetch = fetchMock;

    const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
    await client.fetch('/test');

    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers['user-agent']).toBe('wa-gateway-saas');
  });

  describe('healthCheck', () => {
    it('returns false when no webhook URL', async () => {
      const client = new BackendClient({ config: makeConfig({ webhookUrl: null }), logger });
      expect(await client.healthCheck()).toBe(false);
    });

    it('returns true when /health returns OK', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
      expect(await client.healthCheck()).toBe(true);
    });

    it('returns false when /health returns error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });
      const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
      expect(await client.healthCheck()).toBe(false);
    });

    it('returns false on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
      const client = new BackendClient({ config: makeConfig({ webhookUrl: 'https://api.example.com' }), logger });
      expect(await client.healthCheck()).toBe(false);
    });
  });
});
