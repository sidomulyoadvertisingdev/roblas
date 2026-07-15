import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createWebhookForwarder, type WebhookRuntimeSnapshot } from '../src/webhook/forwarder.js';
import type { IncomingMessage } from '../src/whatsapp/types.js';

const baseMessage: IncomingMessage = {
  messageId: 'msg-1',
  from: '628123456789',
  fromWhatsappId: '628123456789@c.us',
  body: 'laporan keuangan bulan ini',
  timestamp: 1,
  isGroup: false,
  hasMedia: false,
  type: 'chat',
};

const originalFetch = globalThis.fetch;

const makeConfig = (overrides: Partial<WebhookRuntimeSnapshot> = {}): WebhookRuntimeSnapshot => ({
  url: 'https://erp.example/wa/incoming',
  authMode: 'hmac',
  secret: null,
  bearerToken: null,
  timeoutMs: 8_000,
  allowedSenders: [],
  ignoreGroups: true,
  ...overrides,
});

describe('webhook forwarder', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('forwards allowed senders and signs the payload', async () => {
    const secret = 'super-secret-of-erp-app';
    const config = makeConfig({ secret, authMode: 'hmac', allowedSenders: ['08123456789'] });
    const handler = createWebhookForwarder({ getConfig: () => config }, createLogger('silent'));
    await handler(baseMessage);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://erp.example/wa/incoming');
    const init = call[1] as RequestInit;
    const body = init.body as string;
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-wa-signature']).toBe(`sha256=${expected}`);
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends bearer token when auth mode is bearer', async () => {
    const config = makeConfig({ authMode: 'bearer', bearerToken: 'abc123xyz' });
    const handler = createWebhookForwarder({ getConfig: () => config }, createLogger('silent'));
    await handler(baseMessage);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer abc123xyz');
    expect(headers['x-wa-signature']).toBeUndefined();
  });

  it('drops senders not on the whitelist', async () => {
    const config = makeConfig({ allowedSenders: ['08123999999'] });
    const handler = createWebhookForwarder({ getConfig: () => config }, createLogger('silent'));
    await handler(baseMessage);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('ignores group messages by default', async () => {
    const handler = createWebhookForwarder({ getConfig: () => makeConfig() }, createLogger('silent'));
    await handler({ ...baseMessage, isGroup: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('skips when webhook URL is not configured', async () => {
    const handler = createWebhookForwarder({ getConfig: () => makeConfig({ url: null }) }, createLogger('silent'));
    await handler(baseMessage);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
