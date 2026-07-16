import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.js';

export interface UsageRecord {
  tenantId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  intent: string;
  success: boolean;
  errorMessage?: string | undefined;
}

export interface TenantUsageSummary {
  tenantId: string;
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  requestsToday: number;
  tokensToday: number;
  lastRequestAt: Date | null;
}

export class UsageMeter {
  private pool: Pool;
  private logger: Logger;
  private buffer: UsageRecord[] = [];
  private flushInterval: ReturnType<typeof setInterval>;

  constructor(pool: Pool, logger: Logger) {
    this.pool = pool;
    this.logger = logger;
    this.flushInterval = setInterval(() => this.flush(), 30_000);
  }

  async record(entry: UsageRecord): Promise<void> {
    this.buffer.push(entry);
    if (this.buffer.length >= 50) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      const values = batch.map((r) => [
        crypto.randomUUID(),
        r.tenantId,
        r.provider,
        r.model,
        r.promptTokens,
        r.completionTokens,
        r.totalTokens,
        r.latencyMs,
        r.intent,
        r.success ? 1 : 0,
        r.errorMessage ?? null,
      ]);

      await this.pool.execute(
        `INSERT INTO tenant_usage_log
         (id, tenant_id, provider, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, intent, success, error_message)
         VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        values.flat(),
      );

      this.logger.debug({ event: 'usage_flushed', count: batch.length }, 'Usage records flushed to DB');
    } catch (error) {
      this.logger.error({ err: error, event: 'usage_flush_failed', count: batch.length }, 'Failed to flush usage records');
      this.buffer.unshift(...batch);
    }
  }

  async getTenantSummary(tenantId: string): Promise<TenantUsageSummary> {
    const [totalRows] = await this.pool.execute(
      `SELECT COUNT(*) as total_requests, COALESCE(SUM(total_tokens), 0) as total_tokens,
              COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
              MAX(created_at) as last_request_at
       FROM tenant_usage_log WHERE tenant_id = ?`,
      [tenantId],
    );
    const totalArr = totalRows as Array<Record<string, unknown>>;
    const total = totalArr[0] ?? { total_requests: 0, total_tokens: 0, total_prompt_tokens: 0, total_completion_tokens: 0, last_request_at: null };

    const today = new Date().toISOString().slice(0, 10);
    const [todayRows] = await this.pool.execute(
      `SELECT COUNT(*) as requests_today, COALESCE(SUM(total_tokens), 0) as tokens_today
       FROM tenant_usage_log WHERE tenant_id = ? AND DATE(created_at) = ?`,
      [tenantId, today],
    );
    const todayArr = todayRows as Array<Record<string, unknown>>;
    const todayData = todayArr[0] ?? { requests_today: 0, tokens_today: 0 };

    return {
      tenantId,
      totalRequests: Number(total.total_requests),
      totalTokens: Number(total.total_tokens),
      totalPromptTokens: Number(total.total_prompt_tokens),
      totalCompletionTokens: Number(total.total_completion_tokens),
      requestsToday: Number(todayData.requests_today),
      tokensToday: Number(todayData.tokens_today),
      lastRequestAt: total.last_request_at ? new Date(total.last_request_at as string) : null,
    };
  }

  async getTenantDailyUsage(tenantId: string, days = 30): Promise<Array<{ day: string; requests: number; tokens: number }>> {
    const [rows] = await this.pool.execute(
      `SELECT DATE(created_at) as day, COUNT(*) as requests, COALESCE(SUM(total_tokens), 0) as tokens
       FROM tenant_usage_log
       WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at) ORDER BY day`,
      [tenantId, days],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      day: String(r.day),
      requests: Number(r.requests),
      tokens: Number(r.tokens),
    }));
  }

  destroy(): void {
    clearInterval(this.flushInterval);
    this.flush().catch(() => undefined);
  }
}
