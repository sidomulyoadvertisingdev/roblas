import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TenantConfigLoader } from '../src/tenant/config-loader.js';
import { DEFAULT_TENANT_CONFIG, DEFAULT_AI_CONFIG } from '../src/tenant/types.js';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../src/logger.js';

function createMockPool() {
  return {
    execute: vi.fn(),
  } as unknown as Pool;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('TenantConfigLoader', () => {
  let pool: Pool;
  let logger: Logger;
  let loader: TenantConfigLoader;

  beforeEach(() => {
    pool = createMockPool();
    logger = createMockLogger();
    loader = new TenantConfigLoader({ pool, logger });
  });

  describe('getConfig', () => {
    it('returns defaults when no config rows', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);

      const config = await loader.getConfig('tenant-1');
      expect(config).toEqual(DEFAULT_TENANT_CONFIG);
    });

    it('merges DB config with defaults', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [
          { config_key: 'bot_enabled', config_value: 'true' },
          { config_key: 'webhook_url', config_value: 'https://example.com/webhook' },
        ],
        [],
      ]);

      const config = await loader.getConfig('tenant-1');
      expect(config.botEnabled).toBe(true);
      expect(config.webhookUrl).toBe('https://example.com/webhook');
      expect(config.webhookTimeoutMs).toBe(DEFAULT_TENANT_CONFIG.webhookTimeoutMs);
    });

    it('parses JSON arrays from config', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [
          { config_key: 'bot_trigger_keywords', config_value: '["hai","halo"]' },
          { config_key: 'bot_buttons', config_value: '[{"id":"dl","label":"Download"}]' },
        ],
        [],
      ]);

      const config = await loader.getConfig('tenant-1');
      expect(config.botTriggerKeywords).toEqual(['hai', 'halo']);
      expect(config.botButtons).toEqual([{ id: 'dl', label: 'Download' }]);
    });

    it('uses cache on second call', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);

      await loader.getConfig('tenant-1');
      await loader.getConfig('tenant-1');

      expect(pool.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAiConfig', () => {
    it('returns defaults when no AI config', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);

      const config = await loader.getAiConfig('tenant-1');
      expect(config).toEqual(DEFAULT_AI_CONFIG);
    });

    it('returns DB AI config', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [
          {
            provider: 'openai',
            api_key: 'sk-test',
            model: 'gpt-4',
            system_prompt: 'You are helpful',
            response_template: null,
            max_tokens: 512,
          },
        ],
        [],
      ]);

      const config = await loader.getAiConfig('tenant-1');
      expect(config.provider).toBe('openai');
      expect(config.apiKey).toBe('sk-test');
      expect(config.model).toBe('gpt-4');
      expect(config.maxTokens).toBe(512);
    });
  });

  describe('setConfig', () => {
    it('inserts config via UPSERT', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{}, []]);

      await loader.setConfig('tenant-1', 'webhook_url', 'https://new.url');

      expect(pool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tenant_config'),
        expect.arrayContaining(['tenant-1', 'webhook_url', 'https://new.url']),
      );
    });

    it('invalidates cache after set', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      await loader.getConfig('tenant-1');

      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{}, []]);
      await loader.setConfig('tenant-1', 'key', 'value');

      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      await loader.getConfig('tenant-1');

      expect(pool.execute).toHaveBeenCalledTimes(3);
    });
  });

  describe('setAiConfig', () => {
    it('inserts AI config via UPSERT', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{}, []]);

      await loader.setAiConfig('tenant-1', { provider: 'openai', model: 'gpt-4' });

      expect(pool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tenant_ai_config'),
        expect.arrayContaining(['tenant-1', 'openai', 'gpt-4']),
      );
    });

    it('does nothing when no fields provided', async () => {
      await loader.setAiConfig('tenant-1', {});
      expect(pool.execute).not.toHaveBeenCalled();
    });
  });

  describe('invalidateCache', () => {
    it('clears cache for tenant', async () => {
      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      await loader.getConfig('tenant-1');

      loader.invalidateCache('tenant-1');

      (pool.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);
      await loader.getConfig('tenant-1');

      expect(pool.execute).toHaveBeenCalledTimes(2);
    });
  });
});
