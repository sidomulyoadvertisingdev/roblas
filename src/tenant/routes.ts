import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import { TenantResolver } from './resolver.js';
import { TenantConfigLoader } from './config-loader.js';
import { tenantMiddleware, requireTenant, requireAdmin } from './middleware.js';
import type { TenantAiConfig } from './types.js';

interface CreateTenantBody {
  name: string;
  slug: string;
  plan?: 'free' | 'pro' | 'enterprise';
}

interface UpdateConfigBody {
  key: string;
  value: string;
  isSecret?: boolean;
}

interface CreateWaAccountBody {
  clientId: string;
  phone: string;
  displayName?: string;
}

export interface TenantRoutesOptions {
  pool: Pool;
  logger: Logger;
}

export function createTenantRoutes(options: TenantRoutesOptions): Router {
  const { pool, logger } = options;
  const router = Router();

  const resolver = new TenantResolver({ pool, logger });
  const configLoader = new TenantConfigLoader({ pool, logger });

  // Apply tenant middleware to all routes
  router.use(tenantMiddleware(resolver, configLoader));

  // Public routes (no auth required)
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Admin routes (require admin key)
  router.get('/admin/tenants', requireAdmin, async (_req, res) => {
    try {
      const tenants = await resolver.listTenants();
      res.json({ tenants });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list tenants');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/admin/tenants', requireAdmin, async (req, res) => {
    try {
      const body = req.body as CreateTenantBody;
      if (!body.name || !body.slug) {
        res.status(400).json({ error: 'Name and slug are required' });
        return;
      }

      const tenant = await resolver.createTenant({ name: body.name, slug: body.slug, plan: body.plan });
      res.status(201).json({ tenant });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/admin/tenants/:slug', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const config = await configLoader.getConfig(tenant.id);
      const aiConfig = await configLoader.getAiConfig(tenant.id);
      const waAccounts = await resolver.listWaAccounts(tenant.id);

      res.json({ tenant, config, aiConfig, waAccounts });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/admin/tenants/:slug/config', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const body = req.body as UpdateConfigBody;
      if (!body.key || body.value === undefined) {
        res.status(400).json({ error: 'Key and value are required' });
        return;
      }

      await configLoader.setConfig(tenant.id, body.key, body.value, body.isSecret);
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update tenant config');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/admin/tenants/:slug/ai-config', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const body = req.body as Partial<TenantAiConfig>;
      await configLoader.setAiConfig(tenant.id, body);
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update tenant AI config');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/admin/tenants/:slug/wa-accounts', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const body = req.body as CreateWaAccountBody;
      if (!body.clientId || !body.phone) {
        res.status(400).json({ error: 'ClientId and phone are required' });
        return;
      }

      const waAccount = await resolver.createWaAccount({
        tenantId: tenant.id,
        clientId: body.clientId,
        phone: body.phone,
        displayName: body.displayName,
      });

      res.status(201).json({ waAccount });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create WA account');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Tenant-scoped API routes (require tenant API key)
  router.get('/:tenantSlug/status', requireTenant, (req, res) => {
    res.json({
      tenant: req.tenant?.tenant,
      waAccount: req.tenant?.waAccount,
      config: req.tenant?.config,
    });
  });

  return router;
}
