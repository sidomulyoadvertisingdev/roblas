import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createRepositories, type Repositories } from './db/index.js';
import { SettingsManager } from './settings/manager.js';
import { createWebhookForwarder } from './webhook/forwarder.js';
import { WhatsAppService } from './whatsapp/service.js';
import { WhatsAppManager } from './whatsapp/manager.js';
import { normalizePhoneNumber } from './whatsapp/phone.js';
import { TenantResolver, TenantConfigLoader } from './tenant/index.js';
import { createSessionMiddleware } from './auth/session.js';
import type { WhatsAppGateway } from './whatsapp/types.js';

const pool = createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
});

let repositories: Repositories | undefined;
let agentId: number | undefined;
const settingsManager = new SettingsManager(env);
let tenantResolver: TenantResolver | undefined;
let tenantConfigLoader: TenantConfigLoader | undefined;

const bootstrapDatabase = async (): Promise<void> => {
  try {
    await pool.query('SELECT 1');
    await runMigrations(pool, logger);
    repositories = createRepositories(pool);
    settingsManager.attachRepository(repositories.settings);
    await settingsManager.load();

    // Initialize tenant modules
    tenantResolver = new TenantResolver({ pool, logger });
    tenantConfigLoader = new TenantConfigLoader({ pool, logger });

    logger.info({ db: env.DB_NAME, host: env.DB_HOST }, 'Database connected');
    // Single-tenant: ensure default agent exists
    if (env.WA_CLIENT_ID) {
      const phone = env.WA_BOT_PHONE ? normalizePhoneNumber(env.WA_BOT_PHONE) : env.WA_CLIENT_ID;
      const agent = await repositories.agents.ensure(env.WA_CLIENT_ID, phone);
      agentId = agent.id;
      logger.info({ agentId, clientId: agent.clientId, phone: agent.phone }, 'Default agent ready');
    } else {
      logger.info('Multi-tenant mode: skipping default agent (per-tenant from DB)');
    }
  } catch (error) {
    logger.error({ err: error, event: 'db_bootstrap_failed' }, 'Database bootstrap failed; service will run without persistence');
    repositories = undefined;
    agentId = undefined;
  }
};

await bootstrapDatabase();

const webhookHandler = createWebhookForwarder({
  getConfig: () => settingsManager.getWebhookConfig(),
  ...(repositories && agentId ? {
    onRecord: async (message, status) => {
      try {
        const id = await repositories!.incomingLog.record({
          agentId: agentId!,
          waMessageId: message.messageId,
          fromPhone: message.from,
          bodyLength: message.body?.length ?? 0,
          msgType: message.type ?? 'unknown',
          isGroup: message.isGroup,
          hasMedia: message.hasMedia,
          initialStatus: status,
        });
        return id > 0 ? id : null;
      } catch (error) {
        logger.error({ err: error, event: 'db_incoming_record_failed' }, 'Failed to persist incoming');
        return null;
      }
    },
    onDelivered: async (logId, status, error) => {
      try {
        await repositories!.incomingLog.updateWebhookStatus(logId, status, error);
      } catch (dbError) {
        logger.error({ err: dbError, event: 'db_incoming_status_failed' }, 'Failed to update incoming status');
      }
    },
  } : {}),
}, logger);

const initialWebhook = settingsManager.getWebhookConfig();
if (initialWebhook.url) {
  logger.info({ webhook: initialWebhook.url, hasSecret: Boolean(initialWebhook.secret) }, 'Incoming-message webhook enabled');
} else {
  logger.warn('Webhook URL not configured; incoming messages will not be forwarded. Configure via dashboard or WEBHOOK_URL env.');
}

// Determine mode: multi-tenant or single-tenant
let whatsapp: WhatsAppGateway;
let waManager: WhatsAppManager | undefined;

if (tenantResolver && tenantConfigLoader) {
  // Multi-tenant mode: manager handles all WA clients
  waManager = new WhatsAppManager({
    pool,
    logger,
    authPath: env.WA_AUTH_PATH,
    headless: env.WA_HEADLESS,
    executablePath: env.PUPPETEER_EXECUTABLE_PATH,
    tenantResolver,
    tenantConfigLoader,
    settingsManager,
    fallbackHandler: webhookHandler,
  });

  await waManager.loadAllClients();

  // Use first ready client (or first client) as default for API/dashboard
  const defaultClient = waManager.getDefaultClient();
  if (defaultClient) {
    whatsapp = defaultClient;
  } else {
    // No clients loaded — create a placeholder for API endpoints
    // This keeps /health and /api/status working even when no tenants exist
    whatsapp = new WhatsAppService({
      clientId: '__placeholder__',
      authPath: env.WA_AUTH_PATH,
      headless: env.WA_HEADLESS,
      ...(env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: env.PUPPETEER_EXECUTABLE_PATH } : {}),
      onIncomingMessage: webhookHandler,
    }, logger);
  }

  logger.info({ event: 'multi_tenant_enabled', clients: waManager.getAllStatus().length }, 'Multi-tenant mode active');
}

const app = await createApp(logger, {
  apiKey: env.API_KEY,
  corsOrigin: env.CORS_ORIGIN,
  rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
  sendRateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.SEND_RATE_LIMIT_MAX },
  trustProxy: env.TRUST_PROXY,
  env,
  settings: settingsManager,
  ...(repositories ? { repositories } : {}),
  ...(agentId !== undefined ? { agentId } : {}),
  ...(tenantResolver && tenantConfigLoader ? { tenantResolver, tenantConfigLoader } : {}),
  ...(waManager ? { whatsappManager: waManager } : {}),
  ...(pool && env.SESSION_SECRET ? {
    sessionMiddleware: createSessionMiddleware({
      secret: env.SESSION_SECRET,
      maxAgeMs: env.SESSION_MAX_AGE_MS,
      db: { host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME },
      logger,
    }),
    pool,
  } : {}),
});
const server = createServer(app);

server.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT }, 'HTTP server listening');

  if (waManager) {
    // Multi-tenant: clients already initialized by loadAllClients
    logger.info({ clients: waManager.getAllStatus().length }, 'All WA clients started');
  } else {
    // Single-tenant: initialize the one client
    void whatsapp.initialize().catch((error: unknown) => {
      logger.error({ err: error }, 'WhatsApp initialization failed; HTTP status endpoints remain available');
    });
  }
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  server.close((serverError) => {
    void (async () => {
      try {
        if (waManager) {
          await waManager.shutdownAll();
        } else {
          await whatsapp.shutdown();
        }
        await pool.end().catch(() => undefined);
        if (serverError) throw serverError;
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Graceful shutdown failed');
        process.exit(1);
      }
    })();
  });

  setTimeout(() => {
    logger.fatal('Graceful shutdown timed out');
    process.exit(1);
  }, 10_000).unref();
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
