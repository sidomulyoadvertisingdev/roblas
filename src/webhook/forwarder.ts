import { createHmac } from 'node:crypto';
import type { Logger } from '../logger.js';
import { normalizePhoneNumber } from '../whatsapp/phone.js';
import type { IncomingMessage, IncomingMessageHandler } from '../whatsapp/types.js';
import type { WebhookRuntimeConfig } from './types.js';

export type { WebhookRuntimeConfig as WebhookRuntimeSnapshot };

export interface WebhookForwarderOptions {
  getConfig: () => WebhookRuntimeConfig;
  onRecord?: (message: IncomingMessage, status: 'pending' | 'skipped') => Promise<number | null>;
  onDelivered?: (logId: number, status: 'delivered' | 'failed', error?: string | null) => Promise<void>;
}

export const createWebhookForwarder = (
  options: WebhookForwarderOptions,
  logger: Logger,
): IncomingMessageHandler => {
  return async (message: IncomingMessage): Promise<void> => {
    const config = options.getConfig();

    if (!config.url) {
      logger.debug({ event: 'webhook_disabled', from: message.from }, 'Webhook URL not set; skipping');
      await options.onRecord?.(message, 'skipped');
      return;
    }
    if (config.ignoreGroups && message.isGroup) {
      logger.debug({ event: 'webhook_skip_group', from: message.from }, 'Ignoring group message');
      await options.onRecord?.(message, 'skipped');
      return;
    }
    const allowSet = config.allowedSenders.length > 0
      ? new Set(config.allowedSenders.map((entry) => normalizePhoneNumber(entry)))
      : null;
    if (allowSet && !allowSet.has(message.from)) {
      logger.warn(
        { event: 'webhook_sender_not_allowed', from: message.from },
        'Incoming message from non-whitelisted sender was dropped',
      );
      await options.onRecord?.(message, 'skipped');
      return;
    }

    const logId = await options.onRecord?.(message, 'pending') ?? null;
    const payload = JSON.stringify(message);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'rorojongrang-wa-service',
    };

    if (config.authMode === 'hmac' && config.secret) {
      const signature = createHmac('sha256', config.secret).update(payload).digest('hex');
      headers['x-wa-signature'] = `sha256=${signature}`;
    } else if (config.authMode === 'bearer' && config.bearerToken) {
      headers['authorization'] = `Bearer ${config.bearerToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(
          { event: 'webhook_bad_status', status: response.status, from: message.from },
          'Webhook responded with non-2xx',
        );
        if (logId !== null) await options.onDelivered?.(logId, 'failed', `HTTP ${response.status}`);
      } else if (logId !== null) {
        await options.onDelivered?.(logId, 'delivered');
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ event: 'webhook_delivery_failed', err: error }, 'Webhook delivery failed');
      if (logId !== null) await options.onDelivered?.(logId, 'failed', errMsg);
    } finally {
      clearTimeout(timer);
    }
  };
};
