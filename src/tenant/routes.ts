import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import { TenantResolver } from './resolver.js';
import { TenantConfigLoader } from './config-loader.js';
import { tenantMiddleware, requireTenant, requireAdmin } from './middleware.js';
import type { TenantAiConfig } from './types.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';

interface CreateTenantBody {
  name: string;
  slug: string;
  plan?: 'free' | 'pro' | 'enterprise';
}

interface UpdateTenantBody {
  name?: string;
  slug?: string;
  plan?: 'free' | 'pro' | 'enterprise';
  isActive?: boolean;
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

interface CreateApiKeyBody {
  permissions?: string[];
  expiresInDays?: number;
}

interface SendBody {
  to: string;
  message: string;
}

interface ValidateNumberBody {
  phone: string;
}

export interface TenantRoutesOptions {
  pool: Pool;
  logger: Logger;
  whatsappManager?: WhatsAppManager;
}

export function createTenantRoutes(options: TenantRoutesOptions): Router {
  const { pool, logger, whatsappManager } = options;
  const router = Router();

  const resolver = new TenantResolver({ pool, logger });
  const configLoader = new TenantConfigLoader({ pool, logger });

  // Apply tenant middleware to all routes
  router.use(tenantMiddleware(resolver, configLoader));

  // Public routes (no auth required)
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ──────────────────────────────────────
  // Admin: Tenant CRUD
  // ──────────────────────────────────────

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

  router.patch('/admin/tenants/:slug', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const body = req.body as UpdateTenantBody;
      const updated = await resolver.updateTenant(tenant.id, body);
      if (!updated) {
        res.status(500).json({ error: 'Failed to update tenant' });
        return;
      }

      res.json({ tenant: updated });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/admin/tenants/:slug', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const deleted = await resolver.deleteTenant(tenant.id);
      res.json({ deleted });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ──────────────────────────────────────
  // Admin: Tenant Config
  // ──────────────────────────────────────

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

  // ──────────────────────────────────────
  // Admin: WA Accounts
  // ──────────────────────────────────────

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

  // ──────────────────────────────────────
  // Admin: API Key Management
  // ──────────────────────────────────────

  router.get('/admin/tenants/:slug/api-keys', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const apiKeys = await resolver.listApiKeys(tenant.id);
      res.json({ apiKeys });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list API keys');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/admin/tenants/:slug/api-keys', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const tenant = await resolver.resolveBySlug(slug);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const body = req.body as CreateApiKeyBody;
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86400000)
        : null;

      const { apiKey, plainKey } = await resolver.createApiKey(
        tenant.id,
        body.permissions || ['send', 'read'],
        expiresAt,
      );

      res.status(201).json({ apiKey, plainKey });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create API key');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/admin/tenants/:slug/api-keys/:keyId/revoke', requireAdmin, async (req, res) => {
    try {
      const revoked = await resolver.revokeApiKey(req.params.keyId as string);
      if (!revoked) {
        res.status(404).json({ error: 'API key not found' });
        return;
      }
      res.json({ revoked: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to revoke API key');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/admin/tenants/:slug/api-keys/:keyId/rotate', requireAdmin, async (req, res) => {
    try {
      const result = await resolver.rotateApiKey(req.params.keyId as string);
      if (!result) {
        res.status(404).json({ error: 'API key not found' });
        return;
      }
      res.json({ apiKey: result.apiKey, plainKey: result.plainKey });
    } catch (error) {
      logger.error({ err: error }, 'Failed to rotate API key');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ──────────────────────────────────────
  // Tenant-scoped API routes (require tenant API key)
  // ──────────────────────────────────────

  router.get('/:tenantSlug/status', requireTenant, (req, res) => {
    res.json({
      tenant: req.tenant?.tenant,
      waAccount: req.tenant?.waAccount,
      config: req.tenant?.config,
    });
  });

  router.post('/:tenantSlug/send', requireTenant, async (req, res) => {
    if (!whatsappManager) {
      res.status(503).json({ error: 'WhatsApp manager not available' });
      return;
    }

    try {
      const body = req.body as SendBody;
      if (!body.to || !body.message) {
        res.status(400).json({ error: 'To and message are required' });
        return;
      }

      const service = whatsappManager.getTenantClient(req.tenant!.tenant.id);
      if (!service) {
        res.status(503).json({ error: 'WhatsApp client not connected for this tenant' });
        return;
      }

      const result = await service.sendMessage(body.to, body.message);
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error }, 'Failed to send message');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/:tenantSlug/validate-number', requireTenant, async (req, res) => {
    if (!whatsappManager) {
      res.status(503).json({ error: 'WhatsApp manager not available' });
      return;
    }

    try {
      const body = req.body as ValidateNumberBody;
      if (!body.phone) {
        res.status(400).json({ error: 'Phone is required' });
        return;
      }

      const service = whatsappManager.getTenantClient(req.tenant!.tenant.id);
      if (!service) {
        res.status(503).json({ error: 'WhatsApp client not connected for this tenant' });
        return;
      }

      const result = await service.validateNumber(body.phone);
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Failed to validate number');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
