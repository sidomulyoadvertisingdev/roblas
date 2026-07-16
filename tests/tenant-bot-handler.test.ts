import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createGenericBotHandler } from '../src/tenant/bot-handler.js';
import type { Logger } from '../src/logger.js';
import type { IncomingMessage, WhatsAppGateway } from '../src/whatsapp/types.js';
import type { ResolvedTenant } from '../src/tenant/types.js';
import { DEFAULT_TENANT_CONFIG, DEFAULT_AI_CONFIG } from '../src/tenant/types.js';

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function createMockWhatsApp(): WhatsAppGateway {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStatus: vi.fn(),
    getQr: vi.fn(),
    sendMessage: vi.fn(),
    sendToWhatsAppId: vi.fn().mockResolvedValue({ messageId: 'msg-1', to: 'test', timestamp: Date.now() }),
    sendButtonsToWhatsAppId: vi.fn().mockResolvedValue({ messageId: 'btn-1', to: 'test', timestamp: Date.now() }),
    sendDocumentToWhatsAppId: vi.fn(),
    validateNumber: vi.fn(),
  };
}

function createMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-001',
    from: '6281234567890',
    fromWhatsappId: '6281234567890@c.us',
    body: 'hello',
    timestamp: Date.now(),
    isGroup: false,
    hasMedia: false,
    type: 'chat',
    ...overrides,
  };
}

function createResolvedTenant(overrides: Partial<ResolvedTenant> = {}): ResolvedTenant {
  return {
    tenant: { id: 't-1', name: 'Test Tenant', slug: 'test', isActive: true, plan: 'pro', createdAt: new Date(), updatedAt: new Date() },
    waAccount: { id: 'wa-1', tenantId: 't-1', clientId: 'test-bot', phone: '6281234567890', displayName: null, isActive: true, authSessionPath: './data', lastReadyAt: null },
    config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true },
    aiConfig: { ...DEFAULT_AI_CONFIG },
    ...overrides,
  };
}

describe('createGenericBotHandler', () => {
  let whatsapp: WhatsAppGateway;
  let logger: Logger;
  let fallbackHandler: ReturnType<typeof vi.fn>;
  let getTenant: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    whatsapp = createMockWhatsApp();
    logger = createMockLogger();
    fallbackHandler = vi.fn().mockResolvedValue(undefined);
    getTenant = vi.fn();
  });

  it('calls fallback for group messages', async () => {
    getTenant.mockResolvedValue(createResolvedTenant());
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    const msg = createMessage({ isGroup: true });
    await handler(msg);

    expect(fallbackHandler).toHaveBeenCalledOnce();
    expect(fallbackHandler).toHaveBeenCalledWith(msg);
    expect(whatsapp.sendToWhatsAppId).not.toHaveBeenCalled();
  });

  it('calls fallback when tenant not found', async () => {
    getTenant.mockResolvedValue(null);
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage());

    expect(fallbackHandler).toHaveBeenCalledOnce();
  });

  it('calls fallback when bot is disabled', async () => {
    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: false },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage());

    expect(fallbackHandler).toHaveBeenCalledOnce();
  });

  it('replies with greeting for "help" keyword', async () => {
    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botGreeting: 'Halo! Ada yang bisa dibantu?' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'help' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalledWith(
      '6281234567890@c.us',
      'Halo! Ada yang bisa dibantu?',
    );
  });

  it('replies with greeting for "menu" keyword', async () => {
    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botGreeting: 'Menu utama' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'menu' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalledWith('6281234567890@c.us', 'Menu utama');
  });

  it('replies with greeting for "bantuan" keyword', async () => {
    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botGreeting: 'Selamat datang!' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'bantuan' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalledWith('6281234567890@c.us', 'Selamat datang!');
  });

  it('calls fallback when message does not match trigger keywords', async () => {
    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botTriggerKeywords: ['pesan', 'order'] },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'hai apa kabar' }));

    expect(fallbackHandler).toHaveBeenCalledOnce();
  });

  it('processes message when trigger keyword matches', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ items: [{ name: 'Roti', status: 'ready' }] }),
    });

    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botTriggerKeywords: ['pesan', 'order'], webhookUrl: 'https://api.example.com' },
      aiConfig: { ...DEFAULT_AI_CONFIG, apiKey: 'test-key', systemPrompt: 'Parse intent as JSON' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'pesan roti' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it('replies with unknown reply when AI provider returns null (no api key and no global key)', async () => {
    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botTriggerKeywords: [] },
      aiConfig: { ...DEFAULT_AI_CONFIG, apiKey: null },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'pesan roti' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalledWith(
      '6281234567890@c.us',
      DEFAULT_TENANT_CONFIG.botUnknownReply,
    );
  });

  it('uses globalApiKey when tenant has no api key', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: '{"intent":"chat","params":{}}' } }] }),
    });

    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botTriggerKeywords: [], webhookUrl: 'https://api.example.com' },
      aiConfig: { ...DEFAULT_AI_CONFIG, apiKey: null },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler, globalApiKey: 'platform-groq-key' });

    await handler(createMessage({ body: 'pesan roti' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it('handles AI parse error gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'not json' } }] }),
    });

    getTenant.mockResolvedValue(createResolvedTenant({
      config: { ...DEFAULT_TENANT_CONFIG, botEnabled: true, botTriggerKeywords: [], webhookUrl: 'https://api.example.com' },
      aiConfig: { ...DEFAULT_AI_CONFIG, apiKey: 'test-key' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'pesan roti' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it('propagates error when getTenant throws (outside try-catch)', async () => {
    getTenant.mockRejectedValue(new Error('DB connection lost'));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await expect(handler(createMessage())).rejects.toThrow('DB connection lost');
  });

  it('replies with error message when backend call fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

    getTenant.mockResolvedValue(createResolvedTenant({
      config: {
        ...DEFAULT_TENANT_CONFIG,
        botEnabled: true,
        botTriggerKeywords: [],
        webhookUrl: 'https://api.example.com',
      },
      aiConfig: { ...DEFAULT_AI_CONFIG, apiKey: 'test-key' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'pesan roti' }));

    expect(whatsapp.sendToWhatsAppId).toHaveBeenCalledWith(
      '6281234567890@c.us',
      'Terjadi kesalahan. Silakan coba lagi nanti.',
    );
    globalThis.fetch = originalFetch;
  });

  it('sends buttons after successful backend response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ message: 'Order diterima' }),
    });

    getTenant.mockResolvedValue(createResolvedTenant({
      config: {
        ...DEFAULT_TENANT_CONFIG,
        botEnabled: true,
        botTriggerKeywords: [],
        webhookUrl: 'https://api.example.com',
        botButtons: [{ id: 'order', label: 'Pesan Lagi' }, { id: 'status', label: 'Cek Status' }],
      },
      aiConfig: { ...DEFAULT_AI_CONFIG, apiKey: 'test-key' },
    }));
    const handler = createGenericBotHandler(whatsapp, logger, { getTenant, fallbackHandler });

    await handler(createMessage({ body: 'pesan roti' }));

    expect(whatsapp.sendButtonsToWhatsAppId).toHaveBeenCalledWith(
      '6281234567890@c.us',
      'Pilih aksi:',
      expect.arrayContaining([
        { id: 'order', body: 'Pesan Lagi' },
        { id: 'status', body: 'Cek Status' },
      ]),
      undefined,
      'Test Tenant',
    );
    globalThis.fetch = originalFetch;
  });
});
