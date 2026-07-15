import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import type { TenantConfig, TenantAiConfig } from './types.js';
import { DEFAULT_TENANT_CONFIG, DEFAULT_AI_CONFIG } from './types.js';

interface ConfigRow extends RowDataPacket {
  config_key: string;
  config_value: string | null;
}

interface AiConfigRow extends RowDataPacket {
  provider: 'groq' | 'openai' | 'custom';
  api_key: string | null;
  model: string;
  system_prompt: string | null;
  response_template: string | null;
  max_tokens: number;
}

export interface TenantConfigLoaderOptions {
  pool: Pool;
  logger: Logger;
}

interface ConfigCacheEntry {
  config: TenantConfig;
  aiConfig: TenantAiConfig;
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
    if (cached && Date.now() - cached.ts < this.cacheTtl) {
      return cached.config;
    }

    const [rows] = await this.pool.execute<ConfigRow[]>(
      `SELECT config_key, config_value FROM tenant_config WHERE tenant_id = ?`,
      [tenantId],
    );

    const configMap = new Map<string, string>();
    for (const row of rows) {
      if (row.config_value !== null) {
        configMap.set(row.config_key, row.config_value);
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
      botEnabled: configMap.get('bot_enabled') === 'true',
      botTriggerKeywords: this.parseJsonArray<string>(configMap.get('bot_trigger_keywords')),
      botGreeting: configMap.get('bot_greeting') || DEFAULT_TENANT_CONFIG.botGreeting,
      botUnknownReply: configMap.get('bot_unknown_reply') || DEFAULT_TENANT_CONFIG.botUnknownReply,
      botGroupBehavior: (configMap.get('bot_group_behavior') as TenantConfig['botGroupBehavior']) || DEFAULT_TENANT_CONFIG.botGroupBehavior,
      botButtons: this.parseJsonArray<{ id: string; label: string }>(configMap.get('bot_buttons')),
      excelColumns: this.parseJsonArray<{ field: string; header: string; width: number }>(configMap.get('excel_columns')),
    };

    const entry = this.cache.get(tenantId) || { config, aiConfig: DEFAULT_AI_CONFIG, ts: Date.now() };
    entry.config = config;
    entry.ts = Date.now();
    this.cache.set(tenantId, entry);

    return config;
  }

  async getAiConfig(tenantId: string): Promise<TenantAiConfig> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.ts < this.cacheTtl) {
      return cached.aiConfig;
    }

    const [rows] = await this.pool.execute<AiConfigRow[]>(
      `SELECT * FROM tenant_ai_config WHERE tenant_id = ? LIMIT 1`,
      [tenantId],
    );

    const row = rows[0];
    if (!row) return DEFAULT_AI_CONFIG;

    const aiConfig: TenantAiConfig = {
      provider: row.provider || DEFAULT_AI_CONFIG.provider,
      apiKey: row.api_key || DEFAULT_AI_CONFIG.apiKey,
      model: row.model || DEFAULT_AI_CONFIG.model,
      systemPrompt: row.system_prompt || DEFAULT_AI_CONFIG.systemPrompt,
      responseTemplate: row.response_template || DEFAULT_AI_CONFIG.responseTemplate,
      maxTokens: row.max_tokens || DEFAULT_AI_CONFIG.maxTokens,
    };

    const entry = this.cache.get(tenantId) || { config: DEFAULT_TENANT_CONFIG, aiConfig, ts: Date.now() };
    entry.aiConfig = aiConfig;
    entry.ts = Date.now();
    this.cache.set(tenantId, entry);

    return aiConfig;
  }

  async setConfig(tenantId: string, key: string, value: string, isSecret = false): Promise<void> {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO tenant_config (id, tenant_id, config_key, config_value, is_secret) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), is_secret = VALUES(is_secret)`,
      [id, tenantId, key, value, isSecret ? 1 : 0],
    );

    this.cache.delete(tenantId);
    this.logger.info({ event: 'tenant_config_updated', tenantId, key }, 'Tenant config updated');
  }

  async setAiConfig(tenantId: string, data: Partial<TenantAiConfig>): Promise<void> {
    const id = crypto.randomUUID();
    const fields: string[] = [];
    const values: string[] = [];

    if (data.provider !== undefined) { fields.push('provider = ?'); values.push(data.provider); }
    if (data.apiKey !== undefined) { fields.push('api_key = ?'); values.push(data.apiKey ?? ''); }
    if (data.model !== undefined) { fields.push('model = ?'); values.push(data.model); }
    if (data.systemPrompt !== undefined) { fields.push('system_prompt = ?'); values.push(data.systemPrompt ?? ''); }
    if (data.responseTemplate !== undefined) { fields.push('response_template = ?'); values.push(data.responseTemplate ?? ''); }
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

  invalidateCache(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
