import type { Logger } from '../logger.js';
import type { TenantConfig } from './types.js';

export interface BackendResponse {
  success: boolean;
  data: any;
  error?: string;
}

export interface BackendClientOptions {
  config: TenantConfig;
  logger: Logger;
}

export class BackendClient {
  private config: TenantConfig;
  private logger: Logger;

  constructor(options: BackendClientOptions) {
    this.config = options.config;
    this.logger = options.logger;
  }

  async fetch(path: string, options?: {
    method?: string;
    body?: any;
    queryParams?: Record<string, string>;
  }): Promise<BackendResponse> {
    if (!this.config.webhookUrl) {
      return { success: false, data: null, error: 'No webhook URL configured' };
    }

    const url = new URL(path, this.config.webhookUrl);
    if (options?.queryParams) {
      for (const [key, value] of Object.entries(options.queryParams)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'wa-gateway-saas',
    };

    // Add auth headers
    if (this.config.webhookAuthMode === 'bearer' && this.config.webhookBearerToken) {
      headers['authorization'] = `Bearer ${this.config.webhookBearerToken}`;
    } else if (this.config.webhookAuthMode === 'hmac' && this.config.webhookSecret) {
      const crypto = await import('node:crypto');
      const bodyStr = options?.body ? JSON.stringify(options.body) : '';
      const signature = crypto.createHmac('sha256', this.config.webhookSecret).update(bodyStr).digest('hex');
      headers['x-wa-signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.webhookTimeoutMs);

    try {
    const response = await fetch(url.toString(), {
      method: options?.method || 'GET',
      headers,
      body: options?.body ? JSON.stringify(options.body) : null,
      signal: controller.signal,
    });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        this.logger.error({ event: 'backend_error', status: response.status, body: text.slice(0, 200) }, 'Backend request failed');
        return { success: false, data: null, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      clearTimeout(timeout);
      this.logger.error({ err: error, event: 'backend_error' }, 'Backend request failed');
      return { success: false, data: null, error: String(error) };
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.config.webhookUrl) return false;

    try {
      const url = new URL('/health', this.config.webhookUrl);
      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
