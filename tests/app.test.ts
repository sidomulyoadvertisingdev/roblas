import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import type { Environment } from '../src/config/env.js';
import type { WhatsAppGateway } from '../src/whatsapp/types.js';

const apiKey = 'test-api-key-with-enough-length';

const fakeEnv = {
  NODE_ENV: 'test',
  HOST: '0.0.0.0',
  PORT: 3001,
  API_KEY: apiKey,
  CORS_ORIGIN: 'http://localhost:5001',
  LOG_LEVEL: 'silent',
  WA_CLIENT_ID: 'test',
  WA_AUTH_PATH: './data/auth',
  WA_HEADLESS: true,
  WA_BOT_PHONE: undefined,
  PUPPETEER_EXECUTABLE_PATH: undefined,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 120,
  SEND_RATE_LIMIT_MAX: 20,
  TRUST_PROXY: 0,
  WEBHOOK_URL: undefined,
  WEBHOOK_SECRET: undefined,
  WEBHOOK_TIMEOUT_MS: 8_000,
  WEBHOOK_ALLOWED_SENDERS: '',
  WEBHOOK_IGNORE_GROUPS: true,
  DB_HOST: '127.0.0.1',
  DB_PORT: 3306,
  DB_USER: 'root',
  DB_PASSWORD: '',
  DB_NAME: 'test',
} as unknown as Environment;

const createFakeGateway = (): WhatsAppGateway => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockReturnValue({
    state: 'ready',
    ready: true,
    account: { id: '628123456789@c.us', name: 'Test' },
    expectedBotPhone: '6282325980067',
    botPhoneMatches: false,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
  }),
  getQr: vi.fn().mockReturnValue(null),
  sendMessage: vi.fn().mockResolvedValue({ messageId: 'message-1', to: '628123456789', timestamp: 1 }),
  validateNumber: vi.fn().mockResolvedValue({
    input: '08123456789',
    normalized: '628123456789',
    whatsappId: '628123456789@c.us',
    registered: true,
  }),
});

const makeApp = (gateway = createFakeGateway()) => ({
  app: createApp(gateway, createLogger('silent'), {
    apiKey,
    corsOrigin: 'http://localhost:5001',
    rateLimit: { windowMs: 60_000, max: 100 },
    sendRateLimit: { windowMs: 60_000, max: 20 },
    env: fakeEnv,
  }),
  gateway,
});

describe('HTTP API', () => {
  it('serves health without authentication', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.data.whatsappReady).toBe(true);
  });

  it('protects API endpoints with an API key', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/status');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns WhatsApp status with authentication', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/status').set('x-api-key', apiKey);
    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('ready');
  });

  it('validates send payloads', async () => {
    const { app, gateway } = makeApp();
    const response = await request(app)
      .post('/api/send')
      .set('x-api-key', apiKey)
      .send({ phone: '123' });
    expect(response.status).toBe(400);
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a validated message', async () => {
    const { app, gateway } = makeApp();
    const response = await request(app)
      .post('/api/send')
      .set('x-api-key', apiKey)
      .send({ phone: '08123456789', message: 'Halo' });
    expect(response.status).toBe(202);
    expect(gateway.sendMessage).toHaveBeenCalledWith('08123456789', 'Halo');
  });

  it('validates a WhatsApp number', async () => {
    const { app } = makeApp();
    const response = await request(app)
      .post('/api/validate-number')
      .set('x-api-key', apiKey)
      .send({ phone: '08123456789' });
    expect(response.status).toBe(200);
    expect(response.body.data.registered).toBe(true);
  });
});
