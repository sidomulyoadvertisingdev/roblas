import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { apiKeyMiddleware } from './middleware/api-key.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createTenantRoutes } from './tenant/routes.js';
import { createAuthRoutes } from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import type { Pool } from 'mysql2/promise';
import type { Environment } from './config/env.js';
import type { Logger } from './logger.js';
import type { Repositories } from './db/index.js';
import type { SettingsManager } from './settings/manager.js';
import type { WhatsAppGateway } from './whatsapp/types.js';
import type { TenantResolver, TenantConfigLoader } from './tenant/index.js';
import type { WhatsAppManager } from './whatsapp/manager.js';

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
  pool?: Pool;
  sessionMiddleware?: RequestHandler;
  whatsappManager?: WhatsAppManager;
}

export const createApp = async (logger: Logger, options: AppOptions): Promise<Express> => {
  const app = express();
  const allowedOrigins = (options.corsOrigin ?? '*').split(',').map((origin) => origin.trim());

  app.disable('x-powered-by');
  if (options.trustProxy !== undefined && options.trustProxy !== false) {
    app.set('trust proxy', options.trustProxy);
  }
  app.use(pinoHttp({ logger }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://api.qrserver.com', 'https://lh3.googleusercontent.com', 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
      },
    },
  }));
  app.use(cors({
    origin: options.corsOrigin === '*' ? true : allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-api-key'],
    credentials: true,
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use(rateLimit({
    windowMs: options.rateLimit.windowMs,
    limit: options.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  }));

  // Session + Passport (before routes that need auth)
  if (options.sessionMiddleware) {
    app.use(options.sessionMiddleware);
    const passport = await import('passport').then(m => m.default);
    app.use(passport.initialize());
    app.use(passport.session());
  }

  app.get('/health', (_request, response) => {
    const status = options.whatsappManager
      ? (options.whatsappManager.getDefaultClient()?.getStatus() ?? { ready: false, state: 'not_configured' })
      : { ready: false, state: 'no_manager' };

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

  // Auth routes (public)
  if (options.pool && options.env.GOOGLE_CLIENT_ID && options.env.GOOGLE_CLIENT_SECRET) {
    app.use('/auth', createAuthRoutes({
      pool: options.pool,
      logger,
      googleClientId: options.env.GOOGLE_CLIENT_ID,
      googleClientSecret: options.env.GOOGLE_CLIENT_SECRET,
      googleCallbackUrl: options.env.GOOGLE_CALLBACK_URL,
      sessionSecret: options.env.SESSION_SECRET,
      sessionMaxAgeMs: options.env.SESSION_MAX_AGE_MS,
      authBasePath: options.env.WA_AUTH_PATH,
      ...(options.whatsappManager ? { whatsappManager: options.whatsappManager } : {}),
    }));
    logger.info({ event: 'auth_routes_enabled' }, 'Google OAuth auth routes enabled');
  }

  const unavailableError = () => Promise.reject(new Error('WhatsApp client is not configured'));
  const dummyWhatsapp: WhatsAppGateway = {
    initialize: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    cleanupSession: () => Promise.resolve(),
    getStatus: () => ({
      state: 'stopped',
      ready: false,
      account: null,
      expectedBotPhone: null,
      botPhoneMatches: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    }),
    getQr: () => null,
    sendMessage: unavailableError,
    sendToWhatsAppId: unavailableError,
    sendButtonsToWhatsAppId: unavailableError,
    sendDocumentToWhatsAppId: unavailableError,
    validateNumber: unavailableError,
  };
  const whatsapp = options.whatsappManager?.getDefaultClient() ?? dummyWhatsapp;

  app.use('/api', apiKeyMiddleware(options.apiKey), createApiRouter({
    whatsapp,
    sendRateLimit: options.sendRateLimit,
    ...(options.repositories ? { repositories: options.repositories } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    logger,
  }));

  // Dashboard — protected by auth if Google OAuth is configured, otherwise open
  const dashboardOpts = {
    env: options.env,
    sendRateLimit: options.sendRateLimit,
    ...(options.repositories ? { repositories: options.repositories } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.whatsappManager ? { whatsappManager: options.whatsappManager } : {}),
    ...(options.tenantConfigLoader ? { tenantConfigLoader: options.tenantConfigLoader } : {}),
    ...(options.pool ? { pool: options.pool } : {}),
    logger,
  };
  if (options.env.GOOGLE_CLIENT_ID && options.env.GOOGLE_CLIENT_SECRET) {
    app.use('/dashboard', requireAuth, createDashboardRouter(whatsapp, dashboardOpts));
  } else {
    app.use('/dashboard', createDashboardRouter(whatsapp, dashboardOpts));
  }

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
  app.get('/favicon.ico', (_request, response) => {
    response.sendFile(path.join(publicDir, 'assets', 'logo.png'));
  });
  app.get('/login', (_request, response) => {
    response.sendFile(path.join(publicDir, 'login.html'));
  });

  // SPA catch-all: serve index.html for dashboard routes
  app.get(['/', '/send', '/history', '/contacts', '/webhook', '/logs', '/settings', '/api'], (_request, response) => {
    response.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
};
