import type { Request, Response, NextFunction } from 'express';
import type { TenantResolver } from './resolver.js';
import type { TenantConfigLoader } from './config-loader.js';
import type { ResolvedTenant } from './types.js';

// Extend Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: ResolvedTenant;
    }
  }
}

export function tenantMiddleware(resolver: TenantResolver, configLoader: TenantConfigLoader) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Try to resolve tenant from API key first
      const apiKey = req.headers['x-api-key'];
      const apiKeyStr = Array.isArray(apiKey) ? apiKey[0] : apiKey;
      if (apiKeyStr) {
        const crypto = await import('node:crypto');
        const keyHash = crypto.createHash('sha256').update(apiKeyStr).digest('hex');
        const resolved = await resolver.resolveByApiKey(keyHash);
        if (resolved) {
          const config = await configLoader.getConfig(resolved.tenant.id);
          const aiConfig = await configLoader.getAiConfig(resolved.tenant.id);
          req.tenant = { ...resolved, config, aiConfig };
          return next();
        }
      }

      // Try to resolve from tenant slug in URL
      const slugParam = req.params.tenantSlug;
      const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam;
      if (slug) {
        const tenant = await resolver.resolveBySlug(slug);
        if (tenant) {
          const config = await configLoader.getConfig(tenant.id);
          const aiConfig = await configLoader.getAiConfig(tenant.id);
          const waAccounts = await resolver.listWaAccounts(tenant.id);
          const waAccount = waAccounts[0];
          if (waAccount) {
            req.tenant = { tenant, waAccount, config, aiConfig };
            return next();
          }
        }
      }

      // No tenant resolved — continue without tenant (will be handled by route)
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminKey = req.headers['x-admin-key'];
  const adminKeyStr = Array.isArray(adminKey) ? adminKey[0] : adminKey;
  if (!adminKeyStr || adminKeyStr !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
