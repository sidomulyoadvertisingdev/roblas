import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface Contact {
  id: number;
  tenantId: string | null;
  phone: string;
  name: string | null;
  role: string | null;
  agentId: number | null;
  isEnabled: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ContactRow extends RowDataPacket {
  id: number;
  tenant_id: string | null;
  phone: string;
  name: string | null;
  role: string | null;
  agent_id: number | null;
  is_enabled: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapRow = (row: ContactRow): Contact => ({
  id: row.id,
  tenantId: row.tenant_id,
  phone: row.phone,
  name: row.name,
  role: row.role,
  agentId: row.agent_id,
  isEnabled: Boolean(row.is_enabled),
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface UpsertContactInput {
  tenantId?: string | null;
  phone: string;
  name?: string | null;
  role?: string | null;
  agentId?: number | null;
  isEnabled?: boolean;
  notes?: string | null;
}

export class ContactsRepository {
  constructor(private readonly pool: Pool) {}

  async list(options: { tenantId?: string; agentId?: number } = {}): Promise<Contact[]> {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (options.tenantId) { clauses.push('tenant_id = :tenantId'); params.tenantId = options.tenantId; }
    if (options.agentId !== undefined) { clauses.push('(agent_id = :agentId OR agent_id IS NULL)'); params.agentId = options.agentId; }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await this.pool.execute<ContactRow[]>(
      `SELECT * FROM contacts ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(mapRow);
  }

  async findEnabledPhones(options: { tenantId?: string; agentId?: number } = {}): Promise<Set<string>> {
    const clauses: string[] = ['is_enabled = 1'];
    const params: Record<string, string | number> = {};
    if (options.tenantId) { clauses.push('tenant_id = :tenantId'); params.tenantId = options.tenantId; }
    if (options.agentId !== undefined) { clauses.push('(agent_id = :agentId OR agent_id IS NULL)'); params.agentId = options.agentId; }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const [rows] = await this.pool.execute<(RowDataPacket & { phone: string })[]>(
      `SELECT phone FROM contacts ${where}`,
      params,
    );
    return new Set(rows.map((row) => row.phone));
  }

  async create(input: UpsertContactInput): Promise<Contact> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO contacts (tenant_id, phone, name, role, agent_id, is_enabled, notes)
       VALUES (:tenantId, :phone, :name, :role, :agentId, :isEnabled, :notes)`,
      {
        tenantId: input.tenantId ?? null,
        phone: input.phone,
        name: input.name ?? null,
        role: input.role ?? null,
        agentId: input.agentId ?? null,
        isEnabled: input.isEnabled === false ? 0 : 1,
        notes: input.notes ?? null,
      },
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('Failed to create contact');
    return created;
  }

  async update(id: number, input: Partial<UpsertContactInput>): Promise<Contact | null> {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.phone !== undefined) { fields.push('phone = :phone'); params.phone = input.phone; }
    if (input.name !== undefined) { fields.push('name = :name'); params.name = input.name; }
    if (input.role !== undefined) { fields.push('role = :role'); params.role = input.role; }
    if (input.agentId !== undefined) { fields.push('agent_id = :agentId'); params.agentId = input.agentId; }
    if (input.isEnabled !== undefined) { fields.push('is_enabled = :isEnabled'); params.isEnabled = input.isEnabled ? 1 : 0; }
    if (input.notes !== undefined) { fields.push('notes = :notes'); params.notes = input.notes; }
    if (fields.length === 0) return this.findById(id);
    await this.pool.execute(`UPDATE contacts SET ${fields.join(', ')} WHERE id = :id`, params as never);
    return this.findById(id);
  }

  async findById(id: number): Promise<Contact | null> {
    const [rows] = await this.pool.execute<ContactRow[]>(
      'SELECT * FROM contacts WHERE id = :id LIMIT 1',
      { id },
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>('DELETE FROM contacts WHERE id = :id', { id });
    return result.affectedRows > 0;
  }
}
