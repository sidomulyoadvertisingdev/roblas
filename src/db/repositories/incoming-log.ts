import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type WebhookStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

export interface IncomingLogEntry {
  id: number;
  agentId: number;
  waMessageId: string;
  fromPhone: string;
  bodyLength: number;
  msgType: string | null;
  isGroup: boolean;
  hasMedia: boolean;
  webhookStatus: WebhookStatus;
  webhookAttempts: number;
  webhookLastError: string | null;
  receivedAt: Date;
}

interface IncomingLogRow extends RowDataPacket {
  id: number;
  agent_id: number;
  wa_message_id: string;
  from_phone: string;
  body_length: number;
  msg_type: string | null;
  is_group: number;
  has_media: number;
  webhook_status: WebhookStatus;
  webhook_attempts: number;
  webhook_last_error: string | null;
  received_at: Date;
}

const mapRow = (row: IncomingLogRow): IncomingLogEntry => ({
  id: row.id,
  agentId: row.agent_id,
  waMessageId: row.wa_message_id,
  fromPhone: row.from_phone,
  bodyLength: row.body_length,
  msgType: row.msg_type,
  isGroup: Boolean(row.is_group),
  hasMedia: Boolean(row.has_media),
  webhookStatus: row.webhook_status,
  webhookAttempts: row.webhook_attempts,
  webhookLastError: row.webhook_last_error,
  receivedAt: row.received_at,
});

export interface RecordIncomingInput {
  agentId: number;
  waMessageId: string;
  fromPhone: string;
  bodyLength: number;
  msgType: string | null;
  isGroup: boolean;
  hasMedia: boolean;
  initialStatus?: WebhookStatus;
}

export class IncomingLogRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordIncomingInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO incoming_log
       (agent_id, wa_message_id, from_phone, body_length, msg_type, is_group, has_media, webhook_status)
       VALUES (:agentId, :waMessageId, :fromPhone, :bodyLength, :msgType, :isGroup, :hasMedia, :status)
       ON DUPLICATE KEY UPDATE received_at = received_at`,
      {
        agentId: input.agentId,
        waMessageId: input.waMessageId,
        fromPhone: input.fromPhone,
        bodyLength: input.bodyLength,
        msgType: input.msgType,
        isGroup: input.isGroup ? 1 : 0,
        hasMedia: input.hasMedia ? 1 : 0,
        status: input.initialStatus ?? 'pending',
      },
    );
    return result.insertId;
  }

  async updateWebhookStatus(id: number, status: WebhookStatus, error?: string | null): Promise<void> {
    await this.pool.execute(
      `UPDATE incoming_log
       SET webhook_status = :status,
           webhook_attempts = webhook_attempts + 1,
           webhook_last_error = :err
       WHERE id = :id`,
      { id, status, err: error ?? null },
    );
  }

  async list(options: { agentId?: number; limit?: number; offset?: number; status?: WebhookStatus } = {}): Promise<IncomingLogEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit, offset };
    if (options.agentId !== undefined) { clauses.push('agent_id = :agentId'); params.agentId = options.agentId; }
    if (options.status) { clauses.push('webhook_status = :status'); params.status = options.status; }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await this.pool.execute<IncomingLogRow[]>(
      `SELECT * FROM incoming_log ${where} ORDER BY id DESC LIMIT :limit OFFSET :offset`,
      params as never,
    );
    return rows.map(mapRow);
  }
}
