import type { Logger } from '../logger.js';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const PLAN_LIMITS: Record<string, RateLimitConfig> = {
  free: { maxRequests: 30, windowMs: 60_000 },
  pro: { maxRequests: 120, windowMs: 60_000 },
  enterprise: { maxRequests: 600, windowMs: 60_000 },
};

const DEFAULT_LIMIT: RateLimitConfig = { maxRequests: 30, windowMs: 60_000 };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class TenantRateLimiter {
  private buckets = new Map<string, Bucket>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  check(tenantId: string, plan: string): RateLimitResult {
    const config = PLAN_LIMITS[plan] ?? DEFAULT_LIMIT;
    const now = Date.now();
    const bucket = this.buckets.get(tenantId);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(tenantId, { count: 1, resetAt: now + config.windowMs });
      return { allowed: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs };
    }

    if (bucket.count >= config.maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      this.logger.warn({ event: 'rate_limit_exceeded', tenantId, plan, retryAfter }, 'Rate limit exceeded');
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    bucket.count++;
    return { allowed: true, remaining: config.maxRequests - bucket.count, resetAt: bucket.resetAt };
  }

  reset(tenantId: string): void {
    this.buckets.delete(tenantId);
  }

  getLimits(plan: string): RateLimitConfig {
    return PLAN_LIMITS[plan] ?? DEFAULT_LIMIT;
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.buckets.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
