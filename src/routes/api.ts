import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { sendHistory } from '../observability/buffers.js';
import type { Logger } from '../logger.js';
import type { Repositories } from '../db/index.js';
import type { WhatsAppGateway } from '../whatsapp/types.js';

const phoneSchema = z.string().trim().min(7).max(30);
const sendSchema = z.object({
  phone: phoneSchema,
  message: z.string().trim().min(1).max(4096),
}).strict();
const validateNumberSchema = z.object({ phone: phoneSchema }).strict();

const asyncHandler = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

export interface ApiRouterDeps {
  whatsapp: WhatsAppGateway;
  sendRateLimit: { windowMs: number; max: number };
  repositories?: Repositories;
  agentId?: number;
  logger?: Logger;
}

export const createApiRouter = (deps: ApiRouterDeps): Router => {
  const { whatsapp, sendRateLimit, repositories, agentId, logger } = deps;
  const router = Router();

  router.get('/status', (_request, response) => {
    response.json({ data: whatsapp.getStatus() });
  });

  router.get('/qr', (_request, response) => {
    const status = whatsapp.getStatus();
    response.json({ data: { qr: whatsapp.getQr(), state: status.state, ready: status.ready } });
  });

  router.post(
    '/validate-number',
    validateBody(validateNumberSchema),
    asyncHandler(async (_request, response) => {
      const body = response.locals.body as z.infer<typeof validateNumberSchema>;
      const result = await whatsapp.validateNumber(body.phone);
      response.json({ data: result });
    }),
  );

  router.post(
    '/send',
    rateLimit({
      windowMs: sendRateLimit.windowMs,
      limit: sendRateLimit.max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'SEND_RATE_LIMITED', message: 'Too many send requests' } },
    }),
    validateBody(sendSchema),
    asyncHandler(async (_request, response) => {
      const body = response.locals.body as z.infer<typeof sendSchema>;
      const time = new Date().toISOString();
      try {
        const result = await whatsapp.sendMessage(body.phone, body.message);
        sendHistory.push({
          time,
          phone: body.phone,
          message: body.message,
          ok: true,
          messageId: result.messageId,
        });
        if (repositories && agentId) {
          repositories.sendLog
            .record({ agentId, phoneTo: result.to, messageLength: body.message.length, status: 'sent', messageId: result.messageId })
            .catch((error: unknown) => logger?.error({ err: error, event: 'db_send_log_failed' }, 'Failed to persist send log'));
        }
        response.status(202).json({ data: result });
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error);
        sendHistory.push({
          time,
          phone: body.phone,
          message: body.message,
          ok: false,
          error: errMessage,
        });
        if (repositories && agentId) {
          repositories.sendLog
            .record({ agentId, phoneTo: body.phone, messageLength: body.message.length, status: 'failed', error: errMessage })
            .catch((dbError: unknown) => logger?.error({ err: dbError, event: 'db_send_log_failed' }, 'Failed to persist send log'));
        }
        throw error;
      }
    }),
  );

  router.post(
    '/typing',
    validateBody(z.object({ phone: phoneSchema, state: z.boolean() }).strict()),
    asyncHandler(async (_request, response) => {
      const body = response.locals.body as { phone: string; state: boolean };
      if (!whatsapp.setTyping) {
        response.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Typing indicator not supported' } });
        return;
      }
      await whatsapp.setTyping(body.phone, body.state);
      response.status(204).end();
    }),
  );

  return router;
};
