import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TenantResolver } from '../src/tenant/resolver.js';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { Logger } from '../src/logger.js';

function createMockPool() {
  return {
    execute: vi.fn(),
  } as unknown as Pool;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const mockTenantRow = {
  id: 'tenant-1',
  name: 'Test Tenant',
  slug: 'test-tenant',
  is_active: 1,
  plan: 'free' as const,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const mockWaRow = {
  wa_id: 'wa-1',
  wa_tenant_id: 'tenant-1',
  client_id: 'test-client',
  phone: '628123456789',
  display_name: 'Test Bot',
  wa_is_active: 1,
  auth_session_path: './data/auth',
  last_ready_at: null,
};

describe('TenantResolver', () => {
  let pool: Pool;
  let logger: Logger;
  let resolver: TenantResolver;

  beforeEach(() => {
    pool = createMockPool();
    logger = createMockLogger();
    resolver = new TenantResolver({ pool, logger });
  });

  describe('resolveByPhone', () => {
    it('resolves tenant by phone number', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [{ ...mockTenantRow, ...mockWaRow }],
        [],
      ]);

      const result = await resolver.resolveByPhone('628123456789');
      expect(result).not.toBeNull();
      expect(result!.tenant.id).toBe('tenant-1');
      expect(result!.tenant.name).toBe('Test Tenant');
      expect(result!.waAccount.phone).toBe('628123456789');
      expect(result!.waAccount.clientId).toBe('test-client');
    });

    it('returns null for unknown phone', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      const result = await resolver.resolveByPhone('000000');
      expect(result).toBeNull();
    });

    it('uses cache on second call', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [{ ...mockTenantRow, ...mockWaRow }],
        [],
      ]);

      await resolver.resolveByPhone('628123456789');
      await resolver.resolveByPhone('628123456789');

      expect(pool.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveByClientId', () => {
    it('resolves tenant by client ID', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [{ ...mockTenantRow, ...mockWaRow }],
        [],
      ]);

      const result = await resolver.resolveByClientId('test-client');
      expect(result).not.toBeNull();
      expect(result!.tenant.id).toBe('tenant-1');
      expect(result!.waAccount.clientId).toBe('test-client');
    });

    it('returns null for unknown client ID', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      const result = await resolver.resolveByClientId('unknown');
      expect(result).toBeNull();
    });
  });

  describe('resolveBySlug', () => {
    it('resolves tenant by slug', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [mockTenantRow],
        [],
      ]);

      const result = await resolver.resolveBySlug('test-tenant');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('tenant-1');
      expect(result!.name).toBe('Test Tenant');
    });

    it('returns null for unknown slug', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      const result = await resolver.resolveBySlug('unknown');
      expect(result).toBeNull();
    });
  });

  describe('listTenants', () => {
    it('returns all active tenants', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [mockTenantRow],
        [],
      ]);

      const tenants = await resolver.listTenants();
      expect(tenants).toHaveLength(1);
      expect(tenants[0].id).toBe('tenant-1');
    });
  });

  describe('listWaAccounts', () => {
    it('returns WA accounts for tenant', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [mockWaRow],
        [],
      ]);

      const accounts = await resolver.listWaAccounts('tenant-1');
      expect(accounts).toHaveLength(1);
      expect(accounts[0].clientId).toBe('test-client');
    });
  });

  describe('createTenant', () => {
    it('creates a new tenant', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        { insertId: 1 } as ResultSetHeader,
        [],
      ]);

      const tenant = await resolver.createTenant({
        name: 'New Tenant',
        slug: 'new-tenant',
        plan: 'pro',
      });

      expect(tenant.name).toBe('New Tenant');
      expect(tenant.slug).toBe('new-tenant');
      expect(tenant.plan).toBe('pro');
      expect(tenant.id).toBeDefined();
    });
  });

  describe('createWaAccount', () => {
    it('creates a new WA account', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        { insertId: 1 } as ResultSetHeader,
        [],
      ]);

      const account = await resolver.createWaAccount({
        tenantId: 'tenant-1',
        clientId: 'new-client',
        phone: '628987654321',
        displayName: 'New Bot',
      });

      expect(account.clientId).toBe('new-client');
      expect(account.phone).toBe('628987654321');
      expect(account.displayName).toBe('New Bot');
      expect(account.authSessionPath).toBe('./data/auth/session-new-client');
    });
  });
});
