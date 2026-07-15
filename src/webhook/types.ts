export type WebhookAuthMode = 'hmac' | 'bearer' | 'none';

export interface WebhookRuntimeConfig {
  url: string | null;
  authMode: WebhookAuthMode;
  secret: string | null;
  bearerToken: string | null;
  timeoutMs: number;
  allowedSenders: string[];
  ignoreGroups: boolean;
}
