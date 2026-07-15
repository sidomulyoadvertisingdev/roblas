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
import { normalizePhoneNumber } from './whatsapp/phone.js';
import { createBotHandler } from './bot/handler.js';
import { TenantResolver, TenantConfigLoader } from './tenant/index.js';

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
    const phone = env.WA_BOT_PHONE ? normalizePhoneNumber(env.WA_BOT_PHONE) : env.WA_CLIENT_ID;
    const agent = await repositories.agents.ensure(env.WA_CLIENT_ID, phone);
    agentId = agent.id;
    logger.info({ agentId, clientId: agent.clientId, phone: agent.phone }, 'Default agent ready');
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

const whatsapp = new WhatsAppService({
  clientId: env.WA_CLIENT_ID,
  authPath: env.WA_AUTH_PATH,
  headless: env.WA_HEADLESS,
  ...(env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: env.PUPPETEER_EXECUTABLE_PATH } : {}),
  ...(env.WA_BOT_PHONE ? { expectedBotPhone: env.WA_BOT_PHONE } : {}),
  onIncomingMessage: webhookHandler,
}, logger);

// Multi-tenant or single-tenant bot handler
if (tenantResolver && tenantConfigLoader) {
  const botHandler = createBotHandler(whatsapp, logger, {
    groqApiKey: env.GROQ_API_KEY ?? '',
    groqModel: env.GROQ_MODEL,
    getWebhookConfig: () => settingsManager.getWebhookConfig(),
    getTenantConfig: async (fromWhatsappId) => {
      const phone = fromWhatsappId.replace(/@.*$/, '');
      const resolved = await tenantResolver!.resolveByPhone(phone);
      if (!resolved) return null;

      const config = await tenantConfigLoader!.getConfig(resolved.tenant.id);
      const aiConfig = await tenantConfigLoader!.getAiConfig(resolved.tenant.id);

      if (!aiConfig.apiKey) return null;

      return {
        groqApiKey: aiConfig.apiKey,
        groqModel: aiConfig.model || env.GROQ_MODEL,
        webhookConfig: {
          url: config.webhookUrl || settingsManager.getWebhookConfig().url,
          authMode: config.webhookAuthMode,
          secret: config.webhookSecret || settingsManager.getWebhookConfig().secret,
          bearerToken: config.webhookBearerToken || settingsManager.getWebhookConfig().bearerToken,
          timeoutMs: config.webhookTimeoutMs,
          allowedSenders: settingsManager.getWebhookConfig().allowedSenders,
          ignoreGroups: config.webhookIgnoreGroups,
        },
      };
    },
  }, webhookHandler);
  whatsapp.replaceMessageHandler(botHandler);
  logger.info({ event: 'multi_tenant_bot_enabled' }, 'Multi-tenant attendance bot enabled');
} else if (env.BOT_ENABLED && env.GROQ_API_KEY) {
  // Fallback to legacy single-tenant bot
  const botHandler = createBotHandler(whatsapp, logger, {
    groqApiKey: env.GROQ_API_KEY,
    groqModel: env.GROQ_MODEL,
    getWebhookConfig: () => settingsManager.getWebhookConfig(),
  }, webhookHandler);
  whatsapp.replaceMessageHandler(botHandler);
  logger.info({ event: 'legacy_bot_enabled', model: env.GROQ_MODEL }, 'Legacy single-tenant bot enabled');
} else if (env.BOT_ENABLED) {
  logger.warn('BOT_ENABLED but missing GROQ_API_KEY; bot disabled');
}

const app = createApp(whatsapp, logger, {
  apiKey: env.API_KEY,
  corsOrigin: env.CORS_ORIGIN,
  rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
  sendRateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.SEND_RATE_LIMIT_MAX },
  trustProxy: env.TRUST_PROXY,
  env,
  settings: settingsManager,
  ...(repositories ? { repositories } : {}),
  ...(agentId !== undefined ? { agentId } : {}),
  // Multi-tenant support
  ...(tenantResolver && tenantConfigLoader ? { tenantResolver, tenantConfigLoader } : {}),
});
const server = createServer(app);

server.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT }, 'HTTP server listening');
  void whatsapp.initialize().catch((error: unknown) => {
    logger.error({ err: error }, 'WhatsApp initialization failed; HTTP status endpoints remain available');
  });
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  server.close((serverError) => {
    void (async () => {
      try {
        await whatsapp.shutdown();
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
