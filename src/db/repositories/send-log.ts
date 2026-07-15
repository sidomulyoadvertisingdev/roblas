import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface SendLogEntry {
  id: number;
  agentId: number;
  phoneTo: string;
  messageLength: number;
  status: 'sent' | 'failed';
  messageId: string | null;
  error: string | null;
  createdAt: Date;
}

interface SendLogRow extends RowDataPacket {
  id: number;
  agent_id: number;
  phone_to: string;
  message_length: number;
  status: 'sent' | 'failed';
  message_id: string | null;
  error: string | null;
  created_at: Date;
}

const mapRow = (row: SendLogRow): SendLogEntry => ({
  id: row.id,
  agentId: row.agent_id,
  phoneTo: row.phone_to,
  messageLength: row.message_length,
  status: row.status,
  messageId: row.message_id,
  error: row.error,
  createdAt: row.created_at,
});

export interface RecordSendInput {
  agentId: number;
  phoneTo: string;
  messageLength: number;
  status: 'sent' | 'failed';
  messageId?: string | null;
  error?: string | null;
}

export interface ListSendOptions {
  agentId?: number;
  limit?: number;
  offset?: number;
  phone?: string;
  status?: 'sent' | 'failed';
}

export class SendLogRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordSendInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO send_log (agent_id, phone_to, message_length, status, message_id, error)
       VALUES (:agentId, :phoneTo, :messageLength, :status, :messageId, :error)`,
      {
        agentId: input.agentId,
        phoneTo: input.phoneTo,
        messageLength: input.messageLength,
        status: input.status,
        messageId: input.messageId ?? null,
        error: input.error ?? null,
      },
    );
    return result.insertId;
  }

  async list(options: ListSendOptions = {}): Promise<SendLogEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit, offset };
    if (options.agentId !== undefined) { clauses.push('agent_id = :agentId'); params.agentId = options.agentId; }
    if (options.phone) { clauses.push('phone_to = :phone'); params.phone = options.phone; }
    if (options.status) { clauses.push('status = :status'); params.status = options.status; }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await this.pool.execute<SendLogRow[]>(
      `SELECT * FROM send_log ${where} ORDER BY id DESC LIMIT :limit OFFSET :offset`,
      params as never,
    );
    return rows.map(mapRow);
  }

  async count(agentId?: number): Promise<{ total: number; sent: number; failed: number }> {
    const where = agentId !== undefined ? 'WHERE agent_id = :agentId' : '';
    const params = agentId !== undefined ? { agentId } : {};
    const [rows] = await this.pool.execute<(RowDataPacket & { status: string; total: number })[]>(
      `SELECT status, COUNT(*) AS total FROM send_log ${where} GROUP BY status`,
      params,
    );
    let sent = 0; let failed = 0;
    for (const row of rows) {
      if (row.status === 'sent') sent = Number(row.total);
      if (row.status === 'failed') failed = Number(row.total);
    }
    return { total: sent + failed, sent, failed };
  }
}
