import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { apiKeyMiddleware } from './middleware/api-key.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createTenantRoutes } from './tenant/routes.js';
import type { Environment } from './config/env.js';
import type { Logger } from './logger.js';
import type { Repositories } from './db/index.js';
import type { SettingsManager } from './settings/manager.js';
import type { WhatsAppGateway } from './whatsapp/types.js';
import type { TenantResolver, TenantConfigLoader } from './tenant/index.js';

export interface AppOptions {
  apiKey: string;
  corsOrigin: string;
  rateLimit: { windowMs: number; max: number };
  sendRateLimit: { windowMs: number; max: number };
  trustProxy?: boolean | number | string;
  env: Environment;
  publicDir?: string;
  repositories?: Repositories;
  agentId?: number;
  settings?: SettingsManager;
  tenantResolver?: TenantResolver;
  tenantConfigLoader?: TenantConfigLoader;
}

export const createApp = (whatsapp: WhatsAppGateway, logger: Logger, options: AppOptions): Express => {
  const app = express();
  const allowedOrigins = options.corsOrigin.split(',').map((origin) => origin.trim());

  app.disable('x-powered-by');
  if (options.trustProxy !== undefined && options.trustProxy !== false) {
    app.set('trust proxy', options.trustProxy);
  }
  app.use(pinoHttp({ logger }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://api.qrserver.com'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  }));
  app.use(cors({
    origin: options.corsOrigin === '*' ? true : allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-api-key'],
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use(rateLimit({
    windowMs: options.rateLimit.windowMs,
    limit: options.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  }));

  app.get('/health', (_request, response) => {
    const status = whatsapp.getStatus();
    response.status(200).json({
      data: {
        service: 'rorojongrang-wa-service',
        healthy: true,
        whatsappReady: status.ready,
        whatsappState: status.state,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    });
  });

  app.use('/api', apiKeyMiddleware(options.apiKey), createApiRouter({
    whatsapp,
    sendRateLimit: options.sendRateLimit,
    ...(options.repositories ? { repositories: options.repositories } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    logger,
  }));
  app.use('/dashboard', createDashboardRouter(whatsapp, {
    env: options.env,
    sendRateLimit: options.sendRateLimit,
    ...(options.repositories ? { repositories: options.repositories } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    logger,
  }));

  // Multi-tenant routes
  if (options.tenantResolver && options.tenantConfigLoader) {
    app.use('/tenant', createTenantRoutes({
      pool: options.tenantResolver['pool'],
      logger,
    }));
    logger.info({ event: 'tenant_routes_enabled' }, 'Tenant routes enabled');
  }

  const publicDir = options.publicDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const staticMaxAge = options.env.NODE_ENV === 'production' ? '1h' : 0;
  app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: staticMaxAge, etag: false, lastModified: false }));
  app.get('/', (_request, response) => {
    response.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
};
