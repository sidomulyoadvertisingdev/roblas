import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { WhatsAppGateway } from '../whatsapp/types.js';
import type { Environment } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { Repositories } from '../db/index.js';
import type { SettingsManager } from '../settings/manager.js';
import { logBuffer, sendHistory } from '../observability/buffers.js';
import { validateBody } from '../middleware/validate.js';
import { createApiRouter } from './api.js';

const REDACTED = '[REDACTED]';

export interface DashboardOptions {
  env: Environment;
  sendRateLimit: { windowMs: number; max: number };
  repositories?: Repositories;
  agentId?: number;
  logger?: Logger;
  settings?: SettingsManager;
}

const asyncHandler = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

export const createDashboardRouter = (whatsapp: WhatsAppGateway, options: DashboardOptions): Router => {
  const router = Router();
  const { repositories, agentId } = options;

  router.get('/config', (_request, response) => {
    const env = options.env;
    const runtime = options.settings?.getRuntimeSnapshot();
    response.json({
      data: {
        service: 'rorojongrang-wa-service',
        node: process.version,
        agentId: agentId ?? null,
        databaseConnected: Boolean(repositories),
        runtime: runtime ?? null,
        env: {
          NODE_ENV: env.NODE_ENV,
          HOST: env.HOST,
          PORT: env.PORT,
          CORS_ORIGIN: env.CORS_ORIGIN,
          LOG_LEVEL: env.LOG_LEVEL,
          WA_CLIENT_ID: env.WA_CLIENT_ID,
          WA_AUTH_PATH: env.WA_AUTH_PATH,
          WA_HEADLESS: env.WA_HEADLESS,
          WA_BOT_PHONE: env.WA_BOT_PHONE ?? null,
          TRUST_PROXY: env.TRUST_PROXY,
          RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
          RATE_LIMIT_MAX: env.RATE_LIMIT_MAX,
          SEND_RATE_LIMIT_MAX: env.SEND_RATE_LIMIT_MAX,
          WEBHOOK_URL: env.WEBHOOK_URL ?? null,
          WEBHOOK_SECRET: env.WEBHOOK_SECRET ? REDACTED : null,
          WEBHOOK_TIMEOUT_MS: env.WEBHOOK_TIMEOUT_MS,
          WEBHOOK_ALLOWED_SENDERS: env.WEBHOOK_ALLOWED_SENDERS,
          WEBHOOK_IGNORE_GROUPS: env.WEBHOOK_IGNORE_GROUPS,
          API_KEY: env.API_KEY ? REDACTED : null,
          DB_HOST: env.DB_HOST,
          DB_PORT: env.DB_PORT,
          DB_USER: env.DB_USER,
          DB_PASSWORD: env.DB_PASSWORD ? REDACTED : null,
          DB_NAME: env.DB_NAME,
        },
      },
    });
  });

  router.get('/send-history', (request, response) => {
    const raw = request.query.after;
    const after = Number.parseInt(typeof raw === 'string' ? raw : '0', 10) || 0;
    response.json({ data: sendHistory.list(after) });
  });

  router.get('/logs', (request, response) => {
    const raw = request.query.after;
    const after = Number.parseInt(typeof raw === 'string' ? raw : '0', 10) || 0;
    response.json({ data: logBuffer.list(after) });
  });

  router.get('/logs/stream', (_request, response) => {
    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('cache-control', 'no-cache');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders();

    for (const entry of logBuffer.list()) {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    const unsubscribe = logBuffer.subscribe((entry) => {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000);
    _request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (options.settings && repositories) {
    const manager = options.settings;

    router.get('/settings/webhook', (_request, response) => {
      const snapshot = manager.getRuntimeSnapshot();
      response.json({
        data: {
          webhook: {
            url: snapshot.webhook.url,
            authMode: snapshot.webhook.authMode,
            hasSecret: Boolean(snapshot.webhook.secret),
            hasBearerToken: Boolean(snapshot.webhook.bearerToken),
            timeoutMs: snapshot.webhook.timeoutMs,
            allowedSenders: snapshot.webhook.allowedSenders,
            ignoreGroups: snapshot.webhook.ignoreGroups,
          },
          overrides: snapshot.overrides,
        },
      });
    });

    const webhookSettingsSchema = z.object({
      url: z.union([z.string().url(), z.literal('')]).nullable().optional(),
      authMode: z.enum(['hmac', 'bearer', 'none']).optional(),
      secret: z.string().min(16).nullable().optional(),
      bearerToken: z.string().min(8).nullable().optional(),
      timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
      allowedSenders: z.array(z.string().trim().min(7).max(30)).optional(),
      ignoreGroups: z.boolean().optional(),
      clearSecret: z.boolean().optional(),
      clearBearerToken: z.boolean().optional(),
    }).strict();

    router.put('/settings/webhook', validateBody(webhookSettingsSchema), asyncHandler(async (_request, response) => {
      const body = response.locals.body as z.infer<typeof webhookSettingsSchema>;
      if (body.url !== undefined) {
        const normalized = body.url && body.url.trim() !== '' ? body.url.trim() : null;
        await manager.set('webhook_url', normalized);
      }
      if (body.authMode !== undefined) await manager.set('webhook_auth_mode', body.authMode);
      if (body.clearSecret) {
        await manager.set('webhook_secret', null, true);
      } else if (body.secret !== undefined && body.secret !== null) {
        await manager.set('webhook_secret', body.secret, true);
      }
      if (body.clearBearerToken) {
        await manager.set('webhook_bearer_token', null, true);
      } else if (body.bearerToken !== undefined && body.bearerToken !== null) {
        await manager.set('webhook_bearer_token', body.bearerToken, true);
      }
      if (body.timeoutMs !== undefined) await manager.set('webhook_timeout_ms', String(body.timeoutMs));
      if (body.allowedSenders !== undefined) {
        const joined = body.allowedSenders.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(',');
        await manager.set('webhook_allowed_senders', joined);
      }
      if (body.ignoreGroups !== undefined) await manager.set('webhook_ignore_groups', body.ignoreGroups ? 'true' : 'false');

      const snapshot = manager.getRuntimeSnapshot();
      options.logger?.info({ event: 'settings_webhook_updated' }, 'Webhook settings updated via dashboard');
      response.json({
        data: {
          webhook: {
            url: snapshot.webhook.url,
            authMode: snapshot.webhook.authMode,
            hasSecret: Boolean(snapshot.webhook.secret),
            hasBearerToken: Boolean(snapshot.webhook.bearerToken),
            timeoutMs: snapshot.webhook.timeoutMs,
            allowedSenders: snapshot.webhook.allowedSenders,
            ignoreGroups: snapshot.webhook.ignoreGroups,
          },
        },
      });
    }));

    router.post('/settings/webhook/generate-secret', (_request, response) => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      response.json({ data: { secret } });
    });
  }

  if (repositories && agentId) {
    router.get('/db/agents', asyncHandler(async (_request, response) => {
      response.json({ data: await repositories.agents.list() });
    }));

    router.get('/db/send-log', asyncHandler(async (request, response) => {
      const limit = Number.parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10) || 100;
      const offset = Number.parseInt(typeof request.query.offset === 'string' ? request.query.offset : '0', 10) || 0;
      const entries = await repositories.sendLog.list({ agentId, limit, offset });
      const counts = await repositories.sendLog.count(agentId);
      response.json({ data: entries, meta: counts });
    }));

    router.get('/db/incoming', asyncHandler(async (request, response) => {
      const limit = Number.parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10) || 100;
      const offset = Number.parseInt(typeof request.query.offset === 'string' ? request.query.offset : '0', 10) || 0;
      const entries = await repositories.incomingLog.list({ agentId, limit, offset });
      response.json({ data: entries });
    }));

    router.get('/db/contacts', asyncHandler(async (_request, response) => {
      response.json({ data: await repositories.contacts.list(agentId) });
    }));

    const contactSchema = z.object({
      phone: z.string().trim().min(7).max(30),
      name: z.string().trim().max(100).nullable().optional(),
      role: z.string().trim().max(50).nullable().optional(),
      isEnabled: z.boolean().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
    }).strict();

    router.post('/db/contacts', validateBody(contactSchema), asyncHandler(async (_request, response) => {
      const body = response.locals.body as z.infer<typeof contactSchema>;
      const created = await repositories.contacts.create({
        phone: body.phone,
        agentId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      });
      response.status(201).json({ data: created });
    }));

    router.patch('/db/contacts/:id', validateBody(contactSchema.partial()), asyncHandler(async (request, response) => {
      const id = Number.parseInt(String(request.params.id ?? ''), 10);
      if (!Number.isFinite(id)) {
        response.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid contact id' } });
        return;
      }
      const body = response.locals.body as Partial<z.infer<typeof contactSchema>>;
      const patch: Record<string, unknown> = {};
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.name !== undefined) patch.name = body.name;
      if (body.role !== undefined) patch.role = body.role;
      if (body.isEnabled !== undefined) patch.isEnabled = body.isEnabled;
      if (body.notes !== undefined) patch.notes = body.notes;
      const updated = await repositories.contacts.update(id, patch);
      if (!updated) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
        return;
      }
      response.json({ data: updated });
    }));

    router.delete('/db/contacts/:id', asyncHandler(async (request, response) => {
      const id = Number.parseInt(String(request.params.id ?? ''), 10);
      if (!Number.isFinite(id)) {
        response.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid contact id' } });
        return;
      }
      const deleted = await repositories.contacts.delete(id);
      if (!deleted) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
        return;
      }
      response.status(204).end();
    }));
  }

  router.use('/', createApiRouter({
    whatsapp,
    sendRateLimit: options.sendRateLimit,
    ...(repositories ? { repositories } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  }));

  return router;
};
