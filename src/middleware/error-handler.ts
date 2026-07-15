import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import type { Logger } from '../logger.js';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(404, `Route ${request.method} ${request.path} not found`, 'NOT_FOUND'));
};

export const errorHandler = (logger: Logger): ErrorRequestHandler => (error: unknown, request, response, _next) => {
  const normalized = error instanceof AppError
    ? error
    : error instanceof ZodError
      ? new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', error.flatten())
      : new AppError(500, 'Internal server error', 'INTERNAL_ERROR');

  const log = normalized.statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log({ err: error, method: request.method, path: request.path, code: normalized.code }, normalized.message);

  response.status(normalized.statusCode).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  });
};
