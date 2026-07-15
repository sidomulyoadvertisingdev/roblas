import type { Environment } from '../config/env.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import type { WebhookAuthMode, WebhookRuntimeConfig } from '../webhook/types.js';

export type { WebhookAuthMode, WebhookRuntimeConfig };

const KEYS = [
  'webhook_url',
  'webhook_auth_mode',
  'webhook_secret',
  'webhook_bearer_token',
  'webhook_timeout_ms',
  'webhook_allowed_senders',
  'webhook_ignore_groups',
] as const;

export type SettingKey = (typeof KEYS)[number];

const parseSenders = (raw: string | null | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parseBool = (raw: string | null | undefined, fallback: boolean): boolean => {
  if (raw === null || raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
};

const parseInt10 = (raw: string | null | undefined, fallback: number): number => {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const parseAuthMode = (raw: string | null | undefined, fallback: WebhookAuthMode): WebhookAuthMode => {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'hmac' || normalized === 'bearer' || normalized === 'none') return normalized;
  return fallback;
};

export class SettingsManager {
  private cache: Record<string, string | null> = {};
  private loaded = false;
  private repo: SettingsRepository | undefined;

  constructor(private readonly env: Environment, repo?: SettingsRepository) {
    this.repo = repo;
  }

  attachRepository(repo: SettingsRepository): void {
    this.repo = repo;
  }

  hasRepository(): boolean {
    return Boolean(this.repo);
  }

  async load(): Promise<void> {
    if (!this.repo) return;
    this.cache = await this.repo.getMap();
    this.loaded = true;
  }

  private get(key: SettingKey): string | null | undefined {
    if (this.loaded && key in this.cache) return this.cache[key];
    return undefined;
  }

  async set(key: SettingKey, value: string | null, isSecret = false): Promise<void> {
    if (!this.repo) throw new Error('Settings repository is not available');
    await this.repo.upsert(key, value, isSecret);
    this.cache[key] = value;
    this.loaded = true;
  }

  getWebhookConfig(): WebhookRuntimeConfig {
    const url = this.get('webhook_url') ?? this.env.WEBHOOK_URL ?? null;
    const secret = this.get('webhook_secret') ?? this.env.WEBHOOK_SECRET ?? null;
    const bearerToken = this.get('webhook_bearer_token') ?? null;
    const timeoutRaw = this.get('webhook_timeout_ms');
    const timeoutMs = parseInt10(timeoutRaw, this.env.WEBHOOK_TIMEOUT_MS);
    const sendersRaw = this.get('webhook_allowed_senders');
    const allowedSenders = parseSenders(sendersRaw ?? this.env.WEBHOOK_ALLOWED_SENDERS);
    const ignoreRaw = this.get('webhook_ignore_groups');
    const ignoreGroups = parseBool(ignoreRaw, this.env.WEBHOOK_IGNORE_GROUPS);
    const modeRaw = this.get('webhook_auth_mode');
    const defaultMode: WebhookAuthMode = bearerToken ? 'bearer' : secret ? 'hmac' : 'none';
    const authMode = parseAuthMode(modeRaw, defaultMode);
    return {
      url: url || null,
      authMode,
      secret: secret || null,
      bearerToken: bearerToken || null,
      timeoutMs,
      allowedSenders,
      ignoreGroups,
    };
  }

  getRuntimeSnapshot(): { webhook: WebhookRuntimeConfig; overrides: Record<string, boolean> } {
    const webhook = this.getWebhookConfig();
    const overrides: Record<string, boolean> = {};
    for (const key of KEYS) overrides[key] = this.loaded && key in this.cache && this.cache[key] !== null;
    return { webhook, overrides };
  }
}
