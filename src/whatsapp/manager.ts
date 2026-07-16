import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import { WhatsAppService } from '../whatsapp/service.js';
import type { IncomingMessage, IncomingMessageHandler, WhatsAppGateway } from '../whatsapp/types.js';
import type { TenantWaAccount } from '../tenant/types.js';
import { ProductionGateway } from '../tenant/gateway.js';
import type { TenantResolver, TenantConfigLoader } from '../tenant/index.js';
import type { SettingsManager } from '../settings/manager.js';
import { createWebhookForwarder } from '../webhook/forwarder.js';
import type { WebhookRuntimeConfig } from '../webhook/types.js';
import type { Repositories } from '../db/index.js';

interface WaAccountRow extends RowDataPacket {
  id: string;
  tenant_id: string;
  client_id: string;
  phone: string;
  display_name: string | null;
  is_active: number;
  auth_session_path: string;
}

export interface WhatsAppManagerOptions {
  pool: Pool;
  logger: Logger;
  authPath: string;
  headless: boolean;
  executablePath: string | undefined;
  tenantResolver: TenantResolver;
  tenantConfigLoader: TenantConfigLoader;
  settingsManager: SettingsManager;
  fallbackHandler: IncomingMessageHandler;
  globalApiKey?: string | undefined;
  repositories?: Repositories | undefined;
}

export interface ClientEntry {
  clientId: string;
  tenantId: string;
  phone: string;
  service: WhatsAppService;
}

export class WhatsAppManager {
  private clients = new Map<string, ClientEntry>();
  private tenantClients = new Map<string, string>();
  private pool: Pool;
  private logger: Logger;
  private authPath: string;
  private headless: boolean;
  private executablePath: string | undefined;
  private tenantResolver: TenantResolver;
  private tenantConfigLoader: TenantConfigLoader;
  private settingsManager: SettingsManager;
  private fallbackHandler: IncomingMessageHandler;
  private globalApiKey: string | undefined;
  private repositories: Repositories | undefined;
  private gateway: ProductionGateway;

  constructor(options: WhatsAppManagerOptions) {
    this.pool = options.pool;
    this.logger = options.logger;
    this.authPath = options.authPath;
    this.headless = options.headless;
    this.executablePath = options.executablePath;
    this.tenantResolver = options.tenantResolver;
    this.tenantConfigLoader = options.tenantConfigLoader;
    this.settingsManager = options.settingsManager;
    this.fallbackHandler = options.fallbackHandler;
    this.globalApiKey = options.globalApiKey;
    this.repositories = options.repositories;
    this.gateway = new ProductionGateway({ pool: options.pool, logger: options.logger, globalApiKey: options.globalApiKey });
  }

  async loadAllClients(): Promise<void> {
    const [rows] = await this.pool.execute<WaAccountRow[]>(
      `SELECT id, tenant_id, client_id, phone, display_name, is_active, auth_session_path
       FROM tenant_wa_accounts WHERE is_active = 1`,
    );

    this.logger.info({ event: 'wa_manager_loading', count: rows.length }, 'Loading WA accounts from DB');

    for (const row of rows) {
      if (this.clients.has(row.client_id)) continue;

      try {
        await this.addClient({
          id: row.id,
          tenantId: row.tenant_id,
          clientId: row.client_id,
          phone: row.phone,
          displayName: row.display_name,
          isActive: row.is_active === 1,
          authSessionPath: row.auth_session_path,
          lastReadyAt: null,
        });
      } catch (error) {
        this.logger.error({ err: error, clientId: row.client_id }, 'Failed to load WA client');
      }
    }
  }

  async addClient(waAccount: TenantWaAccount): Promise<WhatsAppGateway> {
    if (this.clients.has(waAccount.clientId)) {
      this.logger.warn({ clientId: waAccount.clientId }, 'Client already exists, skipping');
      return this.clients.get(waAccount.clientId)!.service;
    }

    this.logger.info({ event: 'wa_manager_adding', clientId: waAccount.clientId, tenantId: waAccount.tenantId }, 'Adding WA client');

    const service = new WhatsAppService({
      clientId: waAccount.clientId,
      authPath: waAccount.authSessionPath,
      headless: this.headless,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    }, this.logger);

    // Create bot handler specific to this client using production gateway
    const botHandler = this.createProductionBotHandler(service, waAccount.clientId);

    service.replaceMessageHandler(botHandler);

    const entry: ClientEntry = {
      clientId: waAccount.clientId,
      tenantId: waAccount.tenantId,
      phone: waAccount.phone,
      service,
    };

    this.clients.set(waAccount.clientId, entry);
    this.tenantClients.set(waAccount.tenantId, waAccount.clientId);

    try {
      await service.initialize();
      this.logger.info({ event: 'wa_manager_initialized', clientId: waAccount.clientId }, 'WA client initialized');
    } catch (error) {
      this.logger.error({ err: error, clientId: waAccount.clientId }, 'WA client init failed');
    }

    return service;
  }

  async removeClient(clientId: string): Promise<void> {
    const entry = this.clients.get(clientId);
    if (!entry) return;

    this.logger.info({ event: 'wa_manager_removing', clientId }, 'Removing WA client');

    try {
      await entry.service.shutdown();
    } catch {
      // ignore shutdown errors
    }

    this.clients.delete(clientId);
    this.tenantClients.delete(entry.tenantId);
  }

  async disconnectClient(clientId: string): Promise<boolean> {
    const entry = this.clients.get(clientId);
    if (!entry) return false;

    this.logger.info({ event: 'wa_manager_disconnecting', clientId }, 'Disconnecting WA client');
    await entry.service.cleanupSession();
    return true;
  }

  async reconnectClient(clientId: string): Promise<boolean> {
    const entry = this.clients.get(clientId);
    if (!entry) return false;

    this.logger.info({ event: 'wa_manager_reconnecting', clientId }, 'Reconnecting WA client');
    try {
      await entry.service.initialize();
      return true;
    } catch (error) {
      this.logger.error({ err: error, clientId }, 'Failed to reconnect WA client');
      return false;
    }
  }

  getClient(clientId: string): WhatsAppGateway | null {
    return this.clients.get(clientId)?.service ?? null;
  }

  getTenantClient(tenantId: string): WhatsAppGateway | null {
    const clientId = this.tenantClients.get(tenantId);
    if (!clientId) return null;
    return this.clients.get(clientId)?.service ?? null;
  }

  getDefaultClient(): WhatsAppGateway | null {
    for (const entry of this.clients.values()) {
      const status = entry.service.getStatus();
      if (status.ready) return entry.service;
    }
    // Return first client even if not ready
    const first = this.clients.values().next();
    return first.done ? null : first.value.service;
  }

  getAllStatus(): Array<{ clientId: string; tenantId: string; phone: string; status: ReturnType<WhatsAppService['getStatus']> }> {
    const result: Array<{ clientId: string; tenantId: string; phone: string; status: ReturnType<WhatsAppService['getStatus']> }> = [];
    for (const entry of this.clients.values()) {
      result.push({
        clientId: entry.clientId,
        tenantId: entry.tenantId,
        phone: entry.phone,
        status: entry.service.getStatus(),
      });
    }
    return result;
  }

  async shutdownAll(): Promise<void> {
    this.logger.info({ event: 'wa_manager_shutdown', count: this.clients.size }, 'Shutting down all WA clients');
    this.gateway.destroy();
    const shutdowns = Array.from(this.clients.values()).map((entry) =>
      entry.service.shutdown().catch(() => undefined),
    );
    await Promise.all(shutdowns);
    this.clients.clear();
    this.tenantClients.clear();
  }

  getGateway(): ProductionGateway {
    return this.gateway;
  }

  private createProductionBotHandler(whatsapp: WhatsAppGateway, clientId: string): IncomingMessageHandler {
    return async (message: IncomingMessage): Promise<void> => {
      const resolved = await this.tenantResolver.resolveByClientId(clientId);
      if (!resolved) {
        this.logger.debug({ event: 'bot_skip_no_tenant', from: message.from, clientId }, 'No tenant found for client');
        return;
      }

      const tenantId = resolved.tenant.id;
      const config = await this.tenantConfigLoader.getConfig(tenantId);
      const aiConfig = await this.tenantConfigLoader.getAiConfig(tenantId);

      if (message.isGroup) {
        const groupBehavior = config.botGroupBehavior ?? 'skip';
        if (groupBehavior === 'skip' || groupBehavior === 'forward') {
          return this.createTenantFallback(tenantId)(message);
        }
      }

      if (!config.botEnabled) {
        return this.createTenantFallback(tenantId)(message);
      }

      await this.gateway.processMessage({
        tenantId: resolved.tenant.id,
        tenantName: resolved.tenant.name,
        plan: resolved.tenant.plan ?? 'free',
        message,
        config,
        aiConfig,
        whatsapp,
        onRecordIncoming: this.repositories ? async (msg, tid) => {
          try {
            const clientId = this.tenantClients.get(tid);
            if (clientId) {
              const agent = await this.repositories!.agents.findByClientId(clientId);
              if (agent) {
                await this.repositories!.incomingLog.record({
                  tenantId: tid,
                  agentId: agent.id,
                  waMessageId: msg.messageId,
                  fromPhone: msg.from,
                  bodyLength: msg.body?.length ?? 0,
                  msgType: msg.type ?? 'unknown',
                  isGroup: msg.isGroup,
                  hasMedia: msg.hasMedia,
                  initialStatus: 'pending',
                });
              }
            }
          } catch (error) {
            this.logger.error({ err: error, event: 'db_incoming_record_failed', tenantId: tid }, 'Failed to record incoming message');
          }
        } : undefined,
      });
    };
  }

  private createTenantFallback(tenantId: string): IncomingMessageHandler {
    return async (message) => {
      // In fallback, we don't have the clientId handy, but we have tenantId
      const resolved = await this.tenantResolver.resolveById(tenantId);
      if (!resolved) {
        this.logger.debug({ event: 'webhook_skip_no_tenant', from: message.from, tenantId }, 'No tenant webhook configured');
        return;
      }

      const config = await this.tenantConfigLoader.getConfig(resolved.id);
      if (!config.webhookUrl) {
        this.logger.debug({ event: 'webhook_skip_no_url', from: message.from, tenantId }, 'Tenant has no webhook URL');
        return;
      }

      const forwarder = createWebhookForwarder({
        getConfig: (): WebhookRuntimeConfig => ({
          url: config.webhookUrl,
          authMode: config.webhookAuthMode,
          secret: config.webhookSecret,
          bearerToken: config.webhookBearerToken,
          timeoutMs: config.webhookTimeoutMs,
          allowedSenders: [],
          ignoreGroups: config.webhookIgnoreGroups,
        }),
      }, this.logger);
      await forwarder(message);
    };
  }
}
