import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import { TenantResolver } from './resolver.js';
import { TenantConfigLoader } from './config-loader.js';
import { tenantMiddleware, requireTenant, requireAdmin } from './middleware.js';

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
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Admin routes (require admin key)
  router.get('/admin/tenants', requireAdmin, async (req, res) => {
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
      const { name, slug, plan } = req.body;
      if (!name || !slug) {
        res.status(400).json({ error: 'Name and slug are required' });
        return;
      }

      const tenant = await resolver.createTenant({ name, slug, plan });
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

      const { key, value, isSecret } = req.body;
      if (!key || value === undefined) {
        res.status(400).json({ error: 'Key and value are required' });
        return;
      }

      await configLoader.setConfig(tenant.id, key, value, isSecret);
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

      await configLoader.setAiConfig(tenant.id, req.body);
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

      const { clientId, phone, displayName } = req.body;
      if (!clientId || !phone) {
        res.status(400).json({ error: 'ClientId and phone are required' });
        return;
      }

      const waAccount = await resolver.createWaAccount({
        tenantId: tenant.id,
        clientId,
        phone,
        displayName,
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
