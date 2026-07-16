import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { WhatsAppGateway } from '../whatsapp/types.js';
import type { Environment } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { Repositories } from '../db/index.js';
import type { SettingsManager } from '../settings/manager.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';
import type { TenantConfigLoader } from '../tenant/config-loader.js';
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
  whatsappManager?: WhatsAppManager;
  tenantConfigLoader?: TenantConfigLoader;
  pool?: Pool;
}

const asyncHandler = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

export const createDashboardRouter = (whatsapp: WhatsAppGateway, options: DashboardOptions): Router => {
  const router = Router();
  const { repositories, agentId, whatsappManager, pool } = options;

  // ── Tenant endpoints ──────────────────────────────────
  router.get('/tenants', asyncHandler(async (request, response) => {
    const userId = (request.user as { id?: string; tenantId?: string })?.id;
    const userTenantId = (request.user as { id?: string; tenantId?: string })?.tenantId;
    if (!pool || !userId) {
      response.json({ data: [] });
      return;
    }
    interface TenantRow extends RowDataPacket { id: string; name: string; slug: string; plan: string; }
    const [rows] = await pool.execute<TenantRow[]>(
      `SELECT t.id, t.name, t.slug, t.plan
       FROM tenants t
       INNER JOIN users u ON u.tenant_id = t.id
       WHERE u.id = ? AND t.is_active = 1
       ORDER BY t.name`,
      [userId],
    );
    if (userTenantId && !rows.some((r) => r.id === userTenantId)) {
      const [ownRows] = await pool.execute<TenantRow[]>(
        `SELECT id, name, slug, plan FROM tenants WHERE id = ? AND is_active = 1`,
        [userTenantId],
      );
      if (ownRows[0]) rows.push(ownRows[0]);
    }
    response.json({ data: rows });
  }));

  router.get('/tenant/:slug/qr', asyncHandler(async (request, response) => {
    if (!whatsappManager || !pool) {
      response.json({ data: { qr: null } });
      return;
    }
    const slug = request.params.slug as string;
    interface IdRow extends RowDataPacket { id: string; }
    const [tenantRows] = await pool.execute<IdRow[]>(
      'SELECT id FROM tenants WHERE slug = ? LIMIT 1',
      [slug],
    );
    const tenantRow = tenantRows[0];
    if (!tenantRow) {
      response.json({ data: { qr: null } });
      return;
    }
    const waClient = whatsappManager.getTenantClient(tenantRow.id);
    if (!waClient) {
      response.json({ data: { qr: null } });
      return;
    }
    response.json({ data: { qr: waClient.getQr() } });
  }));

  router.get('/tenant/:slug/status', asyncHandler(async (request, response) => {
    if (!whatsappManager || !pool) {
      response.json({ data: null });
      return;
    }
    const slug = request.params.slug as string;
    interface IdRow extends RowDataPacket { id: string; }
    const [tenantRows] = await pool.execute<IdRow[]>(
      'SELECT id FROM tenants WHERE slug = ? LIMIT 1',
      [slug],
    );
    const tenantRow = tenantRows[0];
    if (!tenantRow) {
      response.json({ data: null });
      return;
    }
    const waClient = whatsappManager.getTenantClient(tenantRow.id);
    if (!waClient) {
      response.json({ data: null });
      return;
    }
    response.json({ data: waClient.getStatus() });
  }));

  // ── Disconnect / Reconnect WA ─────────────────────────
  router.post('/disconnect', asyncHandler(async (request, response) => {
    if (!whatsappManager || !pool) {
      response.status(400).json({ error: { code: 'NO_MANAGER', message: 'WhatsApp manager not available' } });
      return;
    }
    const tenantId = (request.user as { tenantId?: string })?.tenantId;
    if (!tenantId) {
      response.status(400).json({ error: { code: 'NO_TENANT', message: 'No tenant in session' } });
      return;
    }
    const waClient = whatsappManager.getTenantClient(tenantId);
    if (!waClient) {
      response.status(404).json({ error: { code: 'NO_WA_CLIENT', message: 'No WhatsApp client for this tenant' } });
      return;
    }
    // Find client ID from the manager's internal map
    interface ManagerClient { clientId: string; service: { cleanupSession: () => Promise<void> } }
    const manager = whatsappManager as unknown as { clients: Map<string, ManagerClient> };
    let clientId: string | null = null;
    for (const [id, entry] of manager.clients) {
      if (entry.service === waClient) { clientId = id; break; }
    }
    if (!clientId) {
      response.status(404).json({ error: { code: 'CLIENT_NOT_FOUND', message: 'Client not found in manager' } });
      return;
    }
    const ok = await whatsappManager.disconnectClient(clientId);
    response.json({ data: { disconnected: ok } });
  }));

  router.post('/reconnect', asyncHandler(async (request, response) => {
    if (!whatsappManager || !pool) {
      response.status(400).json({ error: { code: 'NO_MANAGER', message: 'WhatsApp manager not available' } });
      return;
    }
    const tenantId = (request.user as { tenantId?: string })?.tenantId;
    if (!tenantId) {
      response.status(400).json({ error: { code: 'NO_TENANT', message: 'No tenant in session' } });
      return;
    }
    const waClient = whatsappManager.getTenantClient(tenantId);
    if (!waClient) {
      response.status(404).json({ error: { code: 'NO_WA_CLIENT', message: 'No WhatsApp client for this tenant' } });
      return;
    }
    interface ManagerClient2 { clientId: string; service: unknown }
    const manager2 = whatsappManager as unknown as { clients: Map<string, ManagerClient2> };
    let clientId2: string | null = null;
    for (const [id, entry] of manager2.clients) {
      if (entry.service === waClient) { clientId2 = id; break; }
    }
    if (!clientId2) {
      response.status(404).json({ error: { code: 'CLIENT_NOT_FOUND', message: 'Client not found in manager' } });
      return;
    }
    const ok = await whatsappManager.reconnectClient(clientId2);
    response.json({ data: { reconnected: ok } });
  }));

  // ── Analytics ─────────────────────────────────────────
  router.get('/analytics', asyncHandler(async (request, response) => {
    const tenantId = (request.user as { tenantId?: string })?.tenantId;
    if (!pool || !tenantId) {
      response.json({ data: { today: { total: 0, success: 0, failed: 0 }, last7days: [], allTime: 0 } });
      return;
    }

    interface CountRow extends RowDataPacket { cnt: number; }
    interface DayRow extends RowDataPacket { day: string; success: number; failed: number; }

    const [todayRows] = await pool.execute<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM send_log WHERE tenant_id = ? AND DATE(created_at) = CURDATE()`,
      [tenantId],
    );
    const [todaySuccess] = await pool.execute<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM send_log WHERE tenant_id = ? AND DATE(created_at) = CURDATE() AND status = 'sent'`,
      [tenantId],
    );
    const [todayFailed] = await pool.execute<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM send_log WHERE tenant_id = ? AND DATE(created_at) = CURDATE() AND status = 'failed'`,
      [tenantId],
    );
    const [allTimeRows] = await pool.execute<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM send_log WHERE tenant_id = ?`,
      [tenantId],
    );

    const [last7] = await pool.execute<DayRow[]>(
      `SELECT DATE(created_at) as day,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as success,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM send_log
       WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day`,
      [tenantId],
    );

    // Fill missing days
    const days: Array<{ day: string; success: number; failed: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = last7.find((r) => r.day === key);
      days.push({ day: key, success: found?.success ?? 0, failed: found?.failed ?? 0 });
    }

    response.json({
      data: {
        today: {
          total: todayRows[0]?.cnt ?? 0,
          success: todaySuccess[0]?.cnt ?? 0,
          failed: todayFailed[0]?.cnt ?? 0,
        },
        last7days: days,
        allTime: allTimeRows[0]?.cnt ?? 0,
      },
    });
  }));

  // ── Existing endpoints ─────────────────────────────────

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

  // ── Tenant-scoped webhook settings ────────────────────
  if (options.tenantConfigLoader) {
    const configLoader = options.tenantConfigLoader;

    router.get('/settings/webhook', asyncHandler(async (request, response) => {
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      if (!tenantId) {
        response.json({ data: { webhook: { url: null, authMode: 'none', hasSecret: false, hasBearerToken: false, timeoutMs: 8000, allowedSenders: [], ignoreGroups: true } } });
        return;
      }
      const config = await configLoader.getConfig(tenantId);
      response.json({
        data: {
          webhook: {
            url: config.webhookUrl,
            authMode: config.webhookAuthMode,
            hasSecret: Boolean(config.webhookSecret),
            hasBearerToken: Boolean(config.webhookBearerToken),
            bearerToken: config.webhookBearerToken,
            timeoutMs: config.webhookTimeoutMs,
            allowedSenders: config.webhookAllowedSenders,
            ignoreGroups: config.webhookIgnoreGroups,
          },
        },
      });
    }));

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

    router.put('/settings/webhook', validateBody(webhookSettingsSchema), asyncHandler(async (request, response) => {
      const body = response.locals.body as z.infer<typeof webhookSettingsSchema>;
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      if (!tenantId) {
        response.status(400).json({ error: { code: 'NO_TENANT', message: 'No tenant in session' } });
        return;
      }
      if (body.url !== undefined) {
        const normalized = body.url && body.url.trim() !== '' ? body.url.trim() : null;
        await configLoader.setConfig(tenantId, 'webhook_url', normalized ?? '');
      }
      if (body.authMode !== undefined) await configLoader.setConfig(tenantId, 'webhook_auth_mode', body.authMode);
      if (body.clearSecret) {
        await configLoader.setConfig(tenantId, 'webhook_secret', '');
      } else if (body.secret !== undefined && body.secret !== null) {
        await configLoader.setConfig(tenantId, 'webhook_secret', body.secret, true);
      }
      if (body.clearBearerToken) {
        await configLoader.setConfig(tenantId, 'webhook_bearer_token', '');
      } else if (body.bearerToken !== undefined && body.bearerToken !== null) {
        await configLoader.setConfig(tenantId, 'webhook_bearer_token', body.bearerToken, true);
      }
      if (body.timeoutMs !== undefined) await configLoader.setConfig(tenantId, 'webhook_timeout_ms', String(body.timeoutMs));
      if (body.allowedSenders !== undefined) {
        const arr = body.allowedSenders.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
        await configLoader.setConfig(tenantId, 'webhook_allowed_senders', JSON.stringify(arr));
      }
      if (body.ignoreGroups !== undefined) await configLoader.setConfig(tenantId, 'webhook_ignore_groups', body.ignoreGroups ? 'true' : 'false');

      const config = await configLoader.getConfig(tenantId);
      options.logger?.info({ event: 'settings_webhook_updated', tenantId }, 'Webhook settings updated via dashboard');
      response.json({
        data: {
          webhook: {
            url: config.webhookUrl,
            authMode: config.webhookAuthMode,
            hasSecret: Boolean(config.webhookSecret),
            hasBearerToken: Boolean(config.webhookBearerToken),
            bearerToken: config.webhookBearerToken,
            timeoutMs: config.webhookTimeoutMs,
            allowedSenders: config.webhookAllowedSenders,
            ignoreGroups: config.webhookIgnoreGroups,
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
    router.get('/db/agents', asyncHandler(async (request, response) => {
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      response.json({ data: await repositories.agents.list(tenantId ? { tenantId } : {}) });
    }));

    router.get('/db/send-log', asyncHandler(async (request, response) => {
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      const limit = Number.parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10) || 100;
      const offset = Number.parseInt(typeof request.query.offset === 'string' ? request.query.offset : '0', 10) || 0;
      const entries = await repositories.sendLog.list({ ...(tenantId ? { tenantId } : {}), agentId, limit, offset });
      const counts = await repositories.sendLog.count({ ...(tenantId ? { tenantId } : {}), agentId });
      response.json({ data: entries, meta: counts });
    }));

    router.get('/db/incoming', asyncHandler(async (request, response) => {
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      const limit = Number.parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10) || 100;
      const offset = Number.parseInt(typeof request.query.offset === 'string' ? request.query.offset : '0', 10) || 0;
      const entries = await repositories.incomingLog.list({ ...(tenantId ? { tenantId } : {}), agentId, limit, offset });
      response.json({ data: entries });
    }));

    router.get('/db/contacts', asyncHandler(async (request, response) => {
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      response.json({ data: await repositories.contacts.list({ ...(tenantId ? { tenantId } : {}), agentId }) });
    }));

    const contactSchema = z.object({
      phone: z.string().trim().min(7).max(30),
      name: z.string().trim().max(100).nullable().optional(),
      role: z.string().trim().max(50).nullable().optional(),
      isEnabled: z.boolean().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
    }).strict();

    router.post('/db/contacts', validateBody(contactSchema), asyncHandler(async (request, response) => {
      const tenantId = (request.user as { tenantId?: string })?.tenantId ?? null;
      const body = response.locals.body as z.infer<typeof contactSchema>;
      const created = await repositories.contacts.create({
        tenantId,
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

  // ── Tenant-scoped core endpoints ──────────────────────
  // These override the catch-all API router for dashboard users.
  // Each reads tenantId from session and uses tenant's WA client.

  const phoneSchema = z.string().trim().min(7).max(30);

  router.get('/status', (request, response) => {
    const tenantId = (request.user as { tenantId?: string })?.tenantId;
    if (whatsappManager && tenantId) {
      const client = whatsappManager.getTenantClient(tenantId);
      if (client) {
        response.json({ data: client.getStatus() });
        return;
      }
    }
    response.json({ data: whatsapp.getStatus() });
  });

  router.get('/qr', (request, response) => {
    const tenantId = (request.user as { tenantId?: string })?.tenantId;
    if (whatsappManager && tenantId) {
      const client = whatsappManager.getTenantClient(tenantId);
      if (client) {
        const status = client.getStatus();
        response.json({ data: { qr: client.getQr(), state: status.state, ready: status.ready } });
        return;
      }
    }
    const status = whatsapp.getStatus();
    response.json({ data: { qr: whatsapp.getQr(), state: status.state, ready: status.ready } });
  });

  router.post(
    '/validate-number',
    validateBody(z.object({ phone: phoneSchema }).strict()),
    asyncHandler(async (request, response) => {
      const body = response.locals.body as { phone: string };
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      if (whatsappManager && tenantId) {
        const client = whatsappManager.getTenantClient(tenantId);
        if (client) {
          const result = await client.validateNumber(body.phone);
          response.json({ data: result });
          return;
        }
      }
      const result = await whatsapp.validateNumber(body.phone);
      response.json({ data: result });
    }),
  );

  router.post(
    '/send',
    rateLimit({
      windowMs: options.sendRateLimit.windowMs,
      limit: options.sendRateLimit.max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'SEND_RATE_LIMITED', message: 'Too many send requests' } },
    }),
    validateBody(z.object({ phone: phoneSchema, message: z.string().trim().min(1).max(4096) }).strict()),
    asyncHandler(async (request, response) => {
      const body = response.locals.body as { phone: string; message: string };
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      const time = new Date().toISOString();
      let client: WhatsAppGateway | null = null;
      if (whatsappManager && tenantId) {
        client = whatsappManager.getTenantClient(tenantId);
      }
      const wa = client ?? whatsapp;
      try {
        const result = await wa.sendMessage(body.phone, body.message);
        sendHistory.push({ time, phone: body.phone, message: body.message, ok: true, messageId: result.messageId });
        if (repositories && agentId) {
          repositories.sendLog
            .record({ agentId, ...(tenantId ? { tenantId } : {}), phoneTo: result.to, messageLength: body.message.length, status: 'sent', messageId: result.messageId })
            .catch((error: unknown) => options.logger?.error({ err: error, event: 'db_send_log_failed' }, 'Failed to persist send log'));
        }
        response.status(202).json({ data: result });
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error);
        sendHistory.push({ time, phone: body.phone, message: body.message, ok: false, error: errMessage });
        if (repositories && agentId) {
          repositories.sendLog
            .record({ agentId, ...(tenantId ? { tenantId } : {}), phoneTo: body.phone, messageLength: body.message.length, status: 'failed', error: errMessage })
            .catch((dbError: unknown) => options.logger?.error({ err: dbError, event: 'db_send_log_failed' }, 'Failed to persist send log'));
        }
        throw error;
      }
    }),
  );

  router.post(
    '/typing',
    validateBody(z.object({ phone: phoneSchema, state: z.boolean() }).strict()),
    asyncHandler(async (request, response) => {
      const body = response.locals.body as { phone: string; state: boolean };
      const tenantId = (request.user as { tenantId?: string })?.tenantId;
      if (whatsappManager && tenantId) {
        const client = whatsappManager.getTenantClient(tenantId);
        if (client) {
          if (!client.setTyping) {
            response.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Typing indicator not supported' } });
            return;
          }
          await client.setTyping(body.phone, body.state);
          response.status(204).end();
          return;
        }
      }
      if (!whatsapp.setTyping) {
        response.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Typing indicator not supported' } });
        return;
      }
      await whatsapp.setTyping(body.phone, body.state);
      response.status(204).end();
    }),
  );

  router.use('/', createApiRouter({
    whatsapp,
    sendRateLimit: options.sendRateLimit,
    ...(repositories ? { repositories } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  }));

  return router;
};
