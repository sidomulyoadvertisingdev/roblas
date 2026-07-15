import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../errors/app-error.js';

export const validateBody = (schema: ZodType): RequestHandler => (request, response, next) => {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    next(new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', result.error.flatten()));
    return;
  }
  response.locals.body = result.data;
  next();
};
