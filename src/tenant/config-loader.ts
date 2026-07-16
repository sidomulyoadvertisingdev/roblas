import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import type { TenantConfig, TenantAiConfig } from './types.js';
import { DEFAULT_TENANT_CONFIG, DEFAULT_AI_CONFIG } from './types.js';
import { encrypt, decrypt, isEncrypted } from './encryption.js';

interface ConfigRow extends RowDataPacket {
  config_key: string;
  config_value: string | null;
  is_secret: number;
}

interface AiConfigRow extends RowDataPacket {
  provider: 'groq' | 'openai' | 'custom';
  api_key: string | null;
  model: string;
  system_prompt: string | null;
  business_knowledge: string | null;
  webhook_schema: string | null;
  response_template: string | null;
  response_instructions: string | null;
  max_tokens: number;
}

export interface TenantConfigLoaderOptions {
  pool: Pool;
  logger: Logger;
}

interface ConfigCacheEntry {
  config?: TenantConfig;
  aiConfig?: TenantAiConfig;
  ts: number;
}

export class TenantConfigLoader {
  private pool: Pool;
  private logger: Logger;
  private cache = new Map<string, ConfigCacheEntry>();
  private cacheTtl = 5 * 60 * 1000; // 5 minutes

  constructor(options: TenantConfigLoaderOptions) {
    this.pool = options.pool;
    this.logger = options.logger;
  }

  async getConfig(tenantId: string): Promise<TenantConfig> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.config && Date.now() - cached.ts < this.cacheTtl) {
      return cached.config;
    }

    const [rows] = await this.pool.execute<ConfigRow[]>(
      `SELECT config_key, config_value, is_secret FROM tenant_config WHERE tenant_id = ?`,
      [tenantId],
    );

    const configMap = new Map<string, string>();
    for (const row of rows) {
      if (row.config_value !== null) {
        let value = row.config_value;
        if (row.is_secret === 1 && isEncrypted(value)) {
          try {
            value = decrypt(value);
          } catch {
            this.logger.error({ event: 'tenant_secret_decrypt_failed', tenantId, key: row.config_key }, 'Failed to decrypt tenant secret');
            value = '';
          }
        }
        configMap.set(row.config_key, value);
      }
    }

    const config: TenantConfig = {
      ...DEFAULT_TENANT_CONFIG,
      webhookUrl: configMap.get('webhook_url') || DEFAULT_TENANT_CONFIG.webhookUrl,
      webhookAuthMode: (configMap.get('webhook_auth_mode') as TenantConfig['webhookAuthMode']) || DEFAULT_TENANT_CONFIG.webhookAuthMode,
      webhookSecret: configMap.get('webhook_secret') || DEFAULT_TENANT_CONFIG.webhookSecret,
      webhookBearerToken: configMap.get('webhook_bearer_token') || DEFAULT_TENANT_CONFIG.webhookBearerToken,
      webhookTimeoutMs: parseInt(configMap.get('webhook_timeout_ms') || String(DEFAULT_TENANT_CONFIG.webhookTimeoutMs), 10),
      webhookIgnoreGroups: configMap.get('webhook_ignore_groups') !== 'false',
      webhookAllowedSenders: this.parseJsonArray<string>(configMap.get('webhook_allowed_senders')),
      webhookDiscoveredProfile: this.parseJsonObject(configMap.get('webhook_discovered_profile') ?? null),
      botEnabled: configMap.get('bot_enabled') === 'true',
      botTriggerKeywords: this.parseJsonArray<string>(configMap.get('bot_trigger_keywords')),
      botGreeting: configMap.get('bot_greeting') || DEFAULT_TENANT_CONFIG.botGreeting,
      botUnknownReply: configMap.get('bot_unknown_reply') || DEFAULT_TENANT_CONFIG.botUnknownReply,
      botGroupBehavior: (configMap.get('bot_group_behavior') as TenantConfig['botGroupBehavior']) || DEFAULT_TENANT_CONFIG.botGroupBehavior,
      botButtons: this.parseJsonArray<{ id: string; label: string }>(configMap.get('bot_buttons')),
      excelColumns: this.parseJsonArray<{ field: string; header: string; width: number }>(configMap.get('excel_columns')),
    };

    const entry = this.cache.get(tenantId) || { ts: Date.now() };
    entry.config = config;
    entry.ts = Date.now();
    this.cache.set(tenantId, entry);

    return config;
  }

  async getAiConfig(tenantId: string): Promise<TenantAiConfig> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.aiConfig && Date.now() - cached.ts < this.cacheTtl) {
      return cached.aiConfig;
    }

    const [rows] = await this.pool.execute<AiConfigRow[]>(
      `SELECT * FROM tenant_ai_config WHERE tenant_id = ? LIMIT 1`,
      [tenantId],
    );

    const row = rows[0];
    if (!row) return DEFAULT_AI_CONFIG;

    let apiKey = row.api_key || DEFAULT_AI_CONFIG.apiKey;
    if (apiKey && isEncrypted(apiKey)) {
      try { apiKey = decrypt(apiKey); } catch { this.logger.warn({ event: 'ai_key_decrypt_failed', tenantId }, 'Failed to decrypt AI API key'); }
    }

    const aiConfig: TenantAiConfig = {
      provider: row.provider || DEFAULT_AI_CONFIG.provider,
      apiKey,
      model: row.model || DEFAULT_AI_CONFIG.model,
      systemPrompt: row.system_prompt || DEFAULT_AI_CONFIG.systemPrompt,
      businessKnowledge: row.business_knowledge || DEFAULT_AI_CONFIG.businessKnowledge,
      webhookSchema: this.parseJsonObject(row.webhook_schema),
      responseTemplate: row.response_template || DEFAULT_AI_CONFIG.responseTemplate,
      responseInstructions: row.response_instructions || DEFAULT_AI_CONFIG.responseInstructions,
      maxTokens: row.max_tokens || DEFAULT_AI_CONFIG.maxTokens,
    };

    const entry = this.cache.get(tenantId) || { ts: Date.now() };
    entry.aiConfig = aiConfig;
    entry.ts = Date.now();
    this.cache.set(tenantId, entry);

    return aiConfig;
  }

  async setConfig(tenantId: string, key: string, value: string, isSecret = false): Promise<void> {
    const id = crypto.randomUUID();
    const storedValue = isSecret && value ? encrypt(value) : value;
    await this.pool.execute(
      `INSERT INTO tenant_config (id, tenant_id, config_key, config_value, is_secret) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), is_secret = VALUES(is_secret)`,
      [id, tenantId, key, storedValue, isSecret ? 1 : 0],
    );

    this.cache.delete(tenantId);
    this.logger.info({ event: 'tenant_config_updated', tenantId, key }, 'Tenant config updated');
  }

  async setAiConfig(tenantId: string, data: Partial<TenantAiConfig>): Promise<void> {
    const id = crypto.randomUUID();
    const fields: string[] = [];
    const values: string[] = [];

    if (data.provider !== undefined) { fields.push('provider = ?'); values.push(data.provider); }
    if (data.apiKey !== undefined) {
      const encrypted = data.apiKey ? encrypt(data.apiKey) : '';
      fields.push('api_key = ?'); values.push(encrypted);
    }
    if (data.model !== undefined) { fields.push('model = ?'); values.push(data.model); }
    if (data.systemPrompt !== undefined) { fields.push('system_prompt = ?'); values.push(data.systemPrompt ?? ''); }
    if (data.businessKnowledge !== undefined) { fields.push('business_knowledge = ?'); values.push((data.businessKnowledge ?? '').slice(0, 20_000)); }
    if (data.webhookSchema !== undefined) { fields.push('webhook_schema = ?'); values.push(data.webhookSchema ? JSON.stringify(data.webhookSchema).slice(0, 20_000) : ''); }
    if (data.responseTemplate !== undefined) { fields.push('response_template = ?'); values.push(data.responseTemplate ?? ''); }
    if (data.responseInstructions !== undefined) { fields.push('response_instructions = ?'); values.push((data.responseInstructions ?? '').slice(0, 10_000)); }
    if (data.maxTokens !== undefined) { fields.push('max_tokens = ?'); values.push(String(data.maxTokens)); }

    if (fields.length === 0) return;

    const columns = fields.map((f) => f.split(' = ')[0]);
    const allValues = [...values, tenantId, id];
    await this.pool.execute(
      `INSERT INTO tenant_ai_config (id, tenant_id, ${columns.join(', ')})
       VALUES (?, ?, ${fields.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${fields.join(', ')}`,
      allValues,
    );

    this.cache.delete(tenantId);
    this.logger.info({ event: 'tenant_ai_config_updated', tenantId }, 'Tenant AI config updated');
  }

  private parseJsonArray<T>(value: string | undefined): T[] {
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  private parseJsonObject(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  invalidateCache(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
