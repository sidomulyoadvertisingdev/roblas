import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import type { Tenant, TenantWaAccount } from './types.js';

export interface TenantResolverOptions {
  pool: Pool;
  logger: Logger;
}

export class TenantResolver {
  private pool: Pool;
  private logger: Logger;
  private phoneCache = new Map<string, { tenant: Tenant; waAccount: TenantWaAccount }>();
  private apiKeyCache = new Map<string, { tenant: Tenant; waAccount: TenantWaAccount }>();
  private cacheTtl = 5 * 60 * 1000; // 5 minutes

  constructor(options: TenantResolverOptions) {
    this.pool = options.pool;
    this.logger = options.logger;
  }

  async resolveByPhone(phone: string): Promise<{ tenant: Tenant; waAccount: TenantWaAccount } | null> {
    const cached = this.phoneCache.get(phone);
    if (cached) return cached;

    const [rows] = await this.pool.execute(
      `SELECT t.*, twa.*
       FROM tenants t
       JOIN tenant_wa_accounts twa ON t.id = twa.tenant_id
       WHERE twa.phone = ? AND t.is_active = 1 AND twa.is_active = 1
       LIMIT 1`,
      [phone],
    );

    const row = (rows as any[])[0];
    if (!row) return null;

    const tenant: Tenant = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active === 1,
      plan: row.plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const waAccount: TenantWaAccount = {
      id: row.wa_id,
      tenantId: row.wa_tenant_id || row.id,
      clientId: row.client_id,
      phone: row.phone,
      displayName: row.display_name,
      isActive: row.wa_is_active === 1,
      authSessionPath: row.auth_session_path,
      lastReadyAt: row.last_ready_at,
    };

    this.phoneCache.set(phone, { tenant, waAccount });
    setTimeout(() => this.phoneCache.delete(phone), this.cacheTtl);

    this.logger.info({ event: 'tenant_resolved', phone, tenantId: tenant.id, slug: tenant.slug }, 'Tenant resolved by phone');
    return { tenant, waAccount };
  }

  async resolveByClientId(clientId: string): Promise<{ tenant: Tenant; waAccount: TenantWaAccount } | null> {
    const [rows] = await this.pool.execute(
      `SELECT t.*, twa.*
       FROM tenants t
       JOIN tenant_wa_accounts twa ON t.id = twa.tenant_id
       WHERE twa.client_id = ? AND t.is_active = 1 AND twa.is_active = 1
       LIMIT 1`,
      [clientId],
    );

    const row = (rows as any[])[0];
    if (!row) return null;

    const tenant: Tenant = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active === 1,
      plan: row.plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const waAccount: TenantWaAccount = {
      id: row.wa_id,
      tenantId: row.wa_tenant_id || row.id,
      clientId: row.client_id,
      phone: row.phone,
      displayName: row.display_name,
      isActive: row.wa_is_active === 1,
      authSessionPath: row.auth_session_path,
      lastReadyAt: row.last_ready_at,
    };

    return { tenant, waAccount };
  }

  async resolveByApiKey(keyHash: string): Promise<{ tenant: Tenant; waAccount: TenantWaAccount } | null> {
    const cached = this.apiKeyCache.get(keyHash);
    if (cached) return cached;

    const [rows] = await this.pool.execute(
      `SELECT t.*, twa.*, tak.tenant_id as key_tenant_id
       FROM tenant_api_keys tak
       JOIN tenants t ON tak.tenant_id = t.id
       JOIN tenant_wa_accounts twa ON t.id = twa.tenant_id
       WHERE tak.key_hash = ? AND tak.is_active = 1 AND t.is_active = 1 AND twa.is_active = 1
         AND (tak.expires_at IS NULL OR tak.expires_at > NOW())
       LIMIT 1`,
      [keyHash],
    );

    const row = (rows as any[])[0];
    if (!row) return null;

    const tenant: Tenant = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active === 1,
      plan: row.plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const waAccount: TenantWaAccount = {
      id: row.wa_id,
      tenantId: row.wa_tenant_id || row.id,
      clientId: row.client_id,
      phone: row.phone,
      displayName: row.display_name,
      isActive: row.wa_is_active === 1,
      authSessionPath: row.auth_session_path,
      lastReadyAt: row.last_ready_at,
    };

    this.apiKeyCache.set(keyHash, { tenant, waAccount });
    setTimeout(() => this.apiKeyCache.delete(keyHash), this.cacheTtl);

    this.logger.info({ event: 'tenant_resolved_by_api_key', tenantId: tenant.id, slug: tenant.slug }, 'Tenant resolved by API key');
    return { tenant, waAccount };
  }

  async resolveBySlug(slug: string): Promise<Tenant | null> {
    const [rows] = await this.pool.execute(
      `SELECT * FROM tenants WHERE slug = ? AND is_active = 1 LIMIT 1`,
      [slug],
    );

    const row = (rows as any[])[0];
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active === 1,
      plan: row.plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listTenants(): Promise<Tenant[]> {
    const [rows] = await this.pool.execute(
      `SELECT * FROM tenants WHERE is_active = 1 ORDER BY name`,
    );

    return (rows as any[]).map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active === 1,
      plan: row.plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listWaAccounts(tenantId: string): Promise<TenantWaAccount[]> {
    const [rows] = await this.pool.execute(
      `SELECT * FROM tenant_wa_accounts WHERE tenant_id = ? AND is_active = 1`,
      [tenantId],
    );

    return (rows as any[]).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      clientId: row.client_id,
      phone: row.phone,
      displayName: row.display_name,
      isActive: row.is_active === 1,
      authSessionPath: row.auth_session_path,
      lastReadyAt: row.last_ready_at,
    }));
  }

  async createTenant(data: { name: string; slug: string; plan?: 'free' | 'pro' | 'enterprise' }): Promise<Tenant> {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO tenants (id, name, slug, plan) VALUES (?, ?, ?, ?)`,
      [id, data.name, data.slug, data.plan || 'free'],
    );

    return {
      id,
      name: data.name,
      slug: data.slug,
      isActive: true,
      plan: data.plan || 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async createWaAccount(data: {
    tenantId: string;
    clientId: string;
    phone: string;
    displayName?: string;
  }): Promise<TenantWaAccount> {
    const id = crypto.randomUUID();
    const authSessionPath = `./data/auth/session-${data.clientId}`;
    await this.pool.execute(
      `INSERT INTO tenant_wa_accounts (id, tenant_id, client_id, phone, display_name, auth_session_path) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.tenantId, data.clientId, data.phone, data.displayName || null, authSessionPath],
    );

    return {
      id,
      tenantId: data.tenantId,
      clientId: data.clientId,
      phone: data.phone,
      displayName: data.displayName || null,
      isActive: true,
      authSessionPath,
      lastReadyAt: null,
    };
  }
}
