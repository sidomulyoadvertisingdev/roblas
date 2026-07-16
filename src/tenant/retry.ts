import type { Logger } from '../logger.js';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export async function withRetry<T>(
  fn: () => Promise<T>,
  logger: Logger,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const status = extractStatus(error);
      const isRetryable = status === null || RETRYABLE_STATUS_CODES.has(status);

      if (!isRetryable || attempt >= cfg.maxRetries) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }

      const delay = Math.min(cfg.baseDelayMs * Math.pow(2, attempt) + Math.random() * 100, cfg.maxDelayMs);
      logger.warn({ event: 'retry_attempt', attempt: attempt + 1, maxRetries: cfg.maxRetries, delayMs: Math.round(delay), status }, 'Retrying failed request');
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Retry failed');
}

function extractStatus(error: unknown): number | null {
  if (error instanceof Error) {
    const msg = error.message;
    const match = msg.match(/error:\s*(\d{3})/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
