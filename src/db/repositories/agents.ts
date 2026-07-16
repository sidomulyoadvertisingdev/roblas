import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface Agent {
  id: number;
  tenantId: string | null;
  clientId: string;
  phone: string;
  displayName: string | null;
  isActive: boolean;
  lastReadyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentRow extends RowDataPacket {
  id: number;
  tenant_id: string | null;
  client_id: string;
  phone: string;
  display_name: string | null;
  is_active: number;
  last_ready_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const mapAgent = (row: AgentRow): Agent => ({
  id: row.id,
  tenantId: row.tenant_id,
  clientId: row.client_id,
  phone: row.phone,
  displayName: row.display_name,
  isActive: Boolean(row.is_active),
  lastReadyAt: row.last_ready_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class AgentsRepository {
  constructor(private readonly pool: Pool) {}

  async ensure(clientId: string, phone: string, tenantId?: string | null): Promise<Agent> {
    const existing = await this.findByClientId(clientId);
    if (existing) return existing;
    const [result] = await this.pool.execute<ResultSetHeader>(
      'INSERT INTO agents (tenant_id, client_id, phone) VALUES (:tenantId, :clientId, :phone)',
      { tenantId: tenantId ?? null, clientId, phone },
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('Failed to create agent');
    return created;
  }

  async findById(id: number): Promise<Agent | null> {
    const [rows] = await this.pool.execute<AgentRow[]>('SELECT * FROM agents WHERE id = :id LIMIT 1', { id });
    return rows[0] ? mapAgent(rows[0]) : null;
  }

  async findByClientId(clientId: string): Promise<Agent | null> {
    const [rows] = await this.pool.execute<AgentRow[]>(
      'SELECT * FROM agents WHERE client_id = :clientId LIMIT 1',
      { clientId },
    );
    return rows[0] ? mapAgent(rows[0]) : null;
  }

  async list(options: { tenantId?: string } = {}): Promise<Agent[]> {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (options.tenantId) { clauses.push('tenant_id = :tenantId'); params.tenantId = options.tenantId; }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await this.pool.execute<AgentRow[]>(`SELECT * FROM agents ${where} ORDER BY id ASC`, params);
    return rows.map(mapAgent);
  }

  async touchReady(id: number, phone: string, displayName?: string | null): Promise<void> {
    await this.pool.execute(
      'UPDATE agents SET last_ready_at = NOW(), phone = :phone, display_name = COALESCE(:displayName, display_name) WHERE id = :id',
      { id, phone, displayName: displayName ?? null },
    );
  }
}
