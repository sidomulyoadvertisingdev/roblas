import type { Logger } from '../logger.js';
import type { TenantConfig } from './types.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface BackendResponse {
  success: boolean;
  data: unknown;
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

  async fetch(path = '', options?: {
    method?: string;
    body?: Record<string, unknown>;
    queryParams?: Record<string, string>;
  }): Promise<BackendResponse> {
    if (!this.config.webhookUrl) {
      return { success: false, data: null, error: 'No webhook URL configured' };
    }

    // An empty path means "call the tenant webhook exactly as configured".
    // Explicit paths remain available for auxiliary endpoints such as /health.
    const url = path ? new URL(path, this.config.webhookUrl) : new URL(this.config.webhookUrl);
    const urlError = await validateWebhookUrl(url);
    if (urlError) return { success: false, data: null, error: urlError };
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
        this.logger.error({ event: 'backend_error', status: response.status, responseBytes: Buffer.byteLength(text) }, 'Backend request failed');
        return { success: false, data: null, error: `HTTP ${response.status}` };
      }

      const contentLength = Number(response.headers?.get?.('content-length') ?? 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        return { success: false, data: null, error: 'Webhook response is too large' };
      }

      const text = typeof response.text === 'function' ? await response.text() : null;
      if (text !== null && Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        return { success: false, data: null, error: 'Webhook response is too large' };
      }
      const data = text !== null ? parseResponseBody(text) : await response.json() as unknown;
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
      if (await validateWebhookUrl(url)) return false;
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

async function validateWebhookUrl(url: URL): Promise<string | null> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Webhook URL must use HTTP or HTTPS';
  if (process.env.NODE_ENV !== 'production') return null;
  if (url.protocol !== 'https:') return 'Webhook URL must use HTTPS in production';

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    return 'Webhook URL points to a restricted host';
  }

  try {
    const { lookup } = await import('node:dns/promises');
    const addresses = await lookup(hostname, { all: true });
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      return 'Webhook URL resolves to a private or restricted address';
    }
  } catch {
    return 'Webhook hostname could not be resolved safely';
  }
  return null;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 0 || first === 10 || first === 127 || first >= 224 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

function parseResponseBody(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
