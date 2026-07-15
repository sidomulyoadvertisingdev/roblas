import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import { WhatsAppService } from '../whatsapp/service.js';
import type { IncomingMessageHandler, WhatsAppGateway } from '../whatsapp/types.js';
import type { TenantWaAccount } from '../tenant/types.js';
import { createBotHandler } from '../bot/handler.js';
import type { TenantResolver, TenantConfigLoader } from '../tenant/index.js';
import type { SettingsManager } from '../settings/manager.js';

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
      authPath: this.authPath,
      headless: this.headless,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    }, this.logger);

    // Create bot handler specific to this client
    const botHandler = createBotHandler(service, this.logger, {
      groqApiKey: '',
      groqModel: '',
      getWebhookConfig: () => this.settingsManager.getWebhookConfig(),
      getTenantConfig: async (fromWhatsappId) => {
        const phone = fromWhatsappId.replace(/@.*$/, '');
        const resolved = await this.tenantResolver.resolveByPhone(phone);
        if (!resolved) return null;

        const config = await this.tenantConfigLoader.getConfig(resolved.tenant.id);
        const aiConfig = await this.tenantConfigLoader.getAiConfig(resolved.tenant.id);

        if (!aiConfig.apiKey) return null;

        return {
          groqApiKey: aiConfig.apiKey,
          groqModel: aiConfig.model || 'llama-3.1-8b-instant',
          webhookConfig: {
            url: config.webhookUrl || this.settingsManager.getWebhookConfig().url,
            authMode: config.webhookAuthMode,
            secret: config.webhookSecret || this.settingsManager.getWebhookConfig().secret,
            bearerToken: config.webhookBearerToken || this.settingsManager.getWebhookConfig().bearerToken,
            timeoutMs: config.webhookTimeoutMs,
            allowedSenders: this.settingsManager.getWebhookConfig().allowedSenders,
            ignoreGroups: config.webhookIgnoreGroups,
          },
        };
      },
    }, this.fallbackHandler);

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
    const shutdowns = Array.from(this.clients.values()).map((entry) =>
      entry.service.shutdown().catch(() => undefined),
    );
    await Promise.all(shutdowns);
    this.clients.clear();
    this.tenantClients.clear();
  }
}
