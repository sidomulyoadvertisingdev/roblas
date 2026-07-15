import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';

const matches = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
};

export const apiKeyMiddleware = (apiKey: string): RequestHandler => (request, _response, next) => {
  const provided = request.header('x-api-key');
  if (!provided || !matches(provided, apiKey)) {
    next(new AppError(401, 'A valid x-api-key header is required', 'UNAUTHORIZED'));
    return;
  }
  next();
};
