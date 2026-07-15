import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import type { Tenant, TenantWaAccount } from './types.js';

interface TenantRow extends RowDataPacket {
  id: string;
  name: string;
  slug: string;
  is_active: number;
  plan: 'free' | 'pro' | 'enterprise' | undefined;
  created_at: Date;
  updated_at: Date;
}

interface WaAccountRow extends RowDataPacket {
  wa_id: string;
  wa_tenant_id: string;
  client_id: string;
  phone: string;
  display_name: string | null;
  wa_is_active: number;
  auth_session_path: string;
  last_ready_at: Date | null;
}

interface TenantWithWaRow extends TenantRow, WaAccountRow {}

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

  private mapTenantRow(row: TenantRow): Tenant {
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

  private mapWaAccountRow(row: WaAccountRow, fallbackTenantId: string): TenantWaAccount {
    return {
      id: row.wa_id,
      tenantId: row.wa_tenant_id || fallbackTenantId,
      clientId: row.client_id,
      phone: row.phone,
      displayName: row.display_name,
      isActive: row.wa_is_active === 1,
      authSessionPath: row.auth_session_path,
      lastReadyAt: row.last_ready_at,
    };
  }

  async resolveByPhone(phone: string): Promise<{ tenant: Tenant; waAccount: TenantWaAccount } | null> {
    const cached = this.phoneCache.get(phone);
    if (cached) return cached;

    const [rows] = await this.pool.execute<TenantWithWaRow[]>(
      `SELECT t.*, twa.id as wa_id, twa.tenant_id as wa_tenant_id, twa.client_id, twa.phone, twa.display_name, twa.is_active as wa_is_active, twa.auth_session_path, twa.last_ready_at
       FROM tenants t
       JOIN tenant_wa_accounts twa ON t.id = twa.tenant_id
       WHERE twa.phone = ? AND t.is_active = 1 AND twa.is_active = 1
       LIMIT 1`,
      [phone],
    );

    const row = rows[0];
    if (!row) return null;

    const tenant = this.mapTenantRow(row);
    const waAccount = this.mapWaAccountRow(row, tenant.id);

    this.phoneCache.set(phone, { tenant, waAccount });
    setTimeout(() => this.phoneCache.delete(phone), this.cacheTtl);

    this.logger.info({ event: 'tenant_resolved', phone, tenantId: tenant.id, slug: tenant.slug }, 'Tenant resolved by phone');
    return { tenant, waAccount };
  }

  async resolveByClientId(clientId: string): Promise<{ tenant: Tenant; waAccount: TenantWaAccount } | null> {
    const [rows] = await this.pool.execute<TenantWithWaRow[]>(
      `SELECT t.*, twa.id as wa_id, twa.tenant_id as wa_tenant_id, twa.client_id, twa.phone, twa.display_name, twa.is_active as wa_is_active, twa.auth_session_path, twa.last_ready_at
       FROM tenants t
       JOIN tenant_wa_accounts twa ON t.id = twa.tenant_id
       WHERE twa.client_id = ? AND t.is_active = 1 AND twa.is_active = 1
       LIMIT 1`,
      [clientId],
    );

    const row = rows[0];
    if (!row) return null;

    const tenant = this.mapTenantRow(row);
    const waAccount = this.mapWaAccountRow(row, tenant.id);

    return { tenant, waAccount };
  }

  async resolveByApiKey(keyHash: string): Promise<{ tenant: Tenant; waAccount: TenantWaAccount } | null> {
    const cached = this.apiKeyCache.get(keyHash);
    if (cached) return cached;

    const [rows] = await this.pool.execute<TenantWithWaRow[]>(
      `SELECT t.*, twa.id as wa_id, twa.tenant_id as wa_tenant_id, twa.client_id, twa.phone, twa.display_name, twa.is_active as wa_is_active, twa.auth_session_path, twa.last_ready_at
       FROM tenant_api_keys tak
       JOIN tenants t ON tak.tenant_id = t.id
       JOIN tenant_wa_accounts twa ON t.id = twa.tenant_id
       WHERE tak.key_hash = ? AND tak.is_active = 1 AND t.is_active = 1 AND twa.is_active = 1
         AND (tak.expires_at IS NULL OR tak.expires_at > NOW())
       LIMIT 1`,
      [keyHash],
    );

    const row = rows[0];
    if (!row) return null;

    const tenant = this.mapTenantRow(row);
    const waAccount = this.mapWaAccountRow(row, tenant.id);

    this.apiKeyCache.set(keyHash, { tenant, waAccount });
    setTimeout(() => this.apiKeyCache.delete(keyHash), this.cacheTtl);

    this.logger.info({ event: 'tenant_resolved_by_api_key', tenantId: tenant.id, slug: tenant.slug }, 'Tenant resolved by API key');
    return { tenant, waAccount };
  }

  async resolveBySlug(slug: string): Promise<Tenant | null> {
    const [rows] = await this.pool.execute<TenantRow[]>(
      `SELECT * FROM tenants WHERE slug = ? AND is_active = 1 LIMIT 1`,
      [slug],
    );

    const row = rows[0];
    if (!row) return null;

    return this.mapTenantRow(row);
  }

  async listTenants(): Promise<Tenant[]> {
    const [rows] = await this.pool.execute<TenantRow[]>(
      `SELECT * FROM tenants WHERE is_active = 1 ORDER BY name`,
    );

    return rows.map((row) => this.mapTenantRow(row));
  }

  async listWaAccounts(tenantId: string): Promise<TenantWaAccount[]> {
    const [rows] = await this.pool.execute<WaAccountRow[]>(
      `SELECT id as wa_id, tenant_id as wa_tenant_id, client_id, phone, display_name, is_active as wa_is_active, auth_session_path, last_ready_at
       FROM tenant_wa_accounts WHERE tenant_id = ? AND is_active = 1`,
      [tenantId],
    );

    return rows.map((row) => this.mapWaAccountRow(row, tenantId));
  }

  async createTenant(data: { name: string; slug: string; plan: 'free' | 'pro' | 'enterprise' | undefined }): Promise<Tenant> {
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
      plan: data.plan,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async createWaAccount(data: {
    tenantId: string;
    clientId: string;
    phone: string;
    displayName?: string | undefined;
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
