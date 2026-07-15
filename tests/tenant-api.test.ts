import request from 'supertest';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createTenantRoutes } from '../src/tenant/routes.js';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../src/logger.js';

// Mock pool for integration tests
function createMockPool() {
  const tenants = new Map<string, { id: string; name: string; slug: string; is_active: number; plan: string; created_at: Date; updated_at: Date }>();
  const waAccounts = new Map<string, { id: string; tenant_id: string; client_id: string; phone: string; display_name: string | null; is_active: number; auth_session_path: string; last_ready_at: null }>();
  const configs = new Map<string, { config_key: string; config_value: string | null }>();
  const aiConfigs = new Map<string, { provider: string; api_key: string | null; model: string; system_prompt: string | null; response_template: string | null; max_tokens: number }>();

  // Seed default tenant
  tenants.set('default-tenant-id', {
    id: 'default-tenant-id',
    name: 'Default Tenant',
    slug: 'default',
    is_active: 1,
    plan: 'pro',
    created_at: new Date(),
    updated_at: new Date(),
  });

  let idCounter = 0;

  return {
    execute: vi.fn((sql: string, params?: unknown[]) => {
      // List tenants
      if (sql.includes('SELECT * FROM tenants WHERE is_active = 1')) {
        return [Array.from(tenants.values()), []];
      }
      // Resolve by slug
      if (sql.includes('WHERE slug = ?')) {
        const slug = params?.[0] as string;
        const tenant = Array.from(tenants.values()).find((t) => t.slug === slug);
        return [tenant ? [tenant] : [], []];
      }
      // Create tenant
      if (sql.includes('INSERT INTO tenants')) {
        const id = `tenant-${++idCounter}`;
        const [name, slug, plan] = params as [string, string, string];
        tenants.set(id, { id, name, slug, is_active: 1, plan, created_at: new Date(), updated_at: new Date() });
        return [{ insertId: 1, affectedRows: 1 }, []];
      }
      // List WA accounts
      if (sql.includes('FROM tenant_wa_accounts WHERE tenant_id')) {
        const tenantId = params?.[0] as string;
        const accounts = Array.from(waAccounts.values()).filter((a) => a.tenant_id === tenantId);
        return [accounts, []];
      }
      // Resolve by phone
      if (sql.includes('WHERE twa.phone = ?')) {
        const phone = params?.[0] as string;
        const account = Array.from(waAccounts.values()).find((a) => a.phone === phone);
        if (!account) return [[], []];
        const tenant = tenants.get(account.tenant_id);
        if (!tenant) return [[], []];
        return [[{ ...tenant, wa_id: account.id, wa_tenant_id: account.tenant_id, client_id: account.client_id, phone: account.phone, display_name: account.display_name, wa_is_active: account.is_active, auth_session_path: account.auth_session_path, last_ready_at: account.last_ready_at }], []];
      }
      // Resolve by clientId
      if (sql.includes('WHERE twa.client_id = ?')) {
        const clientId = params?.[0] as string;
        const account = Array.from(waAccounts.values()).find((a) => a.client_id === clientId);
        if (!account) return [[], []];
        const tenant = tenants.get(account.tenant_id);
        if (!tenant) return [[], []];
        return [[{ ...tenant, wa_id: account.id, wa_tenant_id: account.tenant_id, client_id: account.client_id, phone: account.phone, display_name: account.display_name, wa_is_active: account.is_active, auth_session_path: account.auth_session_path, last_ready_at: account.last_ready_at }], []];
      }
      // Create WA account
      if (sql.includes('INSERT INTO tenant_wa_accounts')) {
        const id = `wa-${++idCounter}`;
        const [tenantId, clientId, phone, displayName, authSessionPath] = params as [string, string, string, string | null, string];
        waAccounts.set(id, { id, tenant_id: tenantId, client_id: clientId, phone, display_name: displayName || null, is_active: 1, auth_session_path: authSessionPath, last_ready_at: null });
        return [{ insertId: 1, affectedRows: 1 }, []];
      }
      // Config operations
      if (sql.includes('INSERT INTO tenant_config') || sql.includes('ON DUPLICATE KEY UPDATE config_value')) {
        const [, tenantId, key, value] = params as [string, string, string, string];
        configs.set(`${tenantId}:${key}`, { config_key: key, config_value: value });
        return [{ insertId: 1, affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT config_key, config_value FROM tenant_config')) {
        const tenantId = params?.[0] as string;
        const entries = Array.from(configs.entries()).filter(([k]) => k.startsWith(`${tenantId}:`)).map(([, v]) => v);
        return [entries, []];
      }
      // AI config operations
      if (sql.includes('INSERT INTO tenant_ai_config') || sql.includes('ON DUPLICATE KEY UPDATE provider')) {
        const [tenantId, provider] = params as [string, string];
        aiConfigs.set(tenantId, { provider, api_key: null, model: 'llama-3.1-8b-instant', system_prompt: null, response_template: null, max_tokens: 256 });
        return [{ insertId: 1, affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM tenant_ai_config')) {
        const tenantId = params?.[0] as string;
        const cfg = aiConfigs.get(tenantId);
        return [cfg ? [cfg] : [], []];
      }
      return [[], []];
    }),
  } as unknown as Pool;
}

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const adminKey = 'test-admin-key-12345678';

describe('Tenant CRUD API', () => {
  let app: express.Express;
  let pool: Pool;
  let logger: Logger;

  beforeAll(() => {
    process.env.ADMIN_KEY = adminKey;
    pool = createMockPool();
    logger = createMockLogger();

    app = express();
    app.use(express.json());
    app.use('/tenant', createTenantRoutes({ pool, logger }));
  });

  afterAll(() => {
    delete process.env.ADMIN_KEY;
  });

  it('GET /tenant/health returns ok', async () => {
    const res = await request(app).get('/tenant/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /tenant/admin/tenants requires admin key', async () => {
    const res = await request(app).get('/tenant/admin/tenants');
    expect(res.status).toBe(401);
  });

  it('GET /tenant/admin/tenants returns tenants', async () => {
    const res = await request(app)
      .get('/tenant/admin/tenants')
      .set('x-admin-key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.tenants).toBeDefined();
  });

  it('POST /tenant/admin/tenants creates tenant', async () => {
    const res = await request(app)
      .post('/tenant/admin/tenants')
      .set('x-admin-key', adminKey)
      .send({ name: 'New Tenant', slug: 'new-tenant', plan: 'free' });
    expect(res.status).toBe(201);
    expect(res.body.tenant.name).toBe('New Tenant');
  });

  it('POST /tenant/admin/tenants validates required fields', async () => {
    const res = await request(app)
      .post('/tenant/admin/tenants')
      .set('x-admin-key', adminKey)
      .send({ name: 'Missing Slug' });
    expect(res.status).toBe(400);
  });

  it('GET /tenant/admin/tenants/:slug returns tenant details', async () => {
    const res = await request(app)
      .get('/tenant/admin/tenants/default')
      .set('x-admin-key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.tenant.slug).toBe('default');
  });

  it('PUT /tenant/admin/tenants/:slug/config updates config', async () => {
    const res = await request(app)
      .put('/tenant/admin/tenants/default/config')
      .set('x-admin-key', adminKey)
      .send({ key: 'webhook_url', value: 'https://example.com/webhook' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PUT /tenant/admin/tenants/:slug/ai-config updates AI config', async () => {
    const res = await request(app)
      .put('/tenant/admin/tenants/default/ai-config')
      .set('x-admin-key', adminKey)
      .send({ provider: 'openai', model: 'gpt-4' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /tenant/admin/tenants/:slug/wa-accounts creates WA account', async () => {
    const res = await request(app)
      .post('/tenant/admin/tenants/default/wa-accounts')
      .set('x-admin-key', adminKey)
      .send({ clientId: 'new-bot', phone: '628999999999', displayName: 'New Bot' });
    expect(res.status).toBe(201);
    expect(res.body.waAccount.clientId).toBe('new-bot');
  });
});
