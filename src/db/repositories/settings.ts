import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface SettingEntry {
  key: string;
  value: string | null;
  isSecret: boolean;
  updatedAt: Date;
}

interface SettingRow extends RowDataPacket {
  setting_key: string;
  setting_value: string | null;
  is_secret: number;
  updated_at: Date;
}

const mapRow = (row: SettingRow): SettingEntry => ({
  key: row.setting_key,
  value: row.setting_value,
  isSecret: Boolean(row.is_secret),
  updatedAt: row.updated_at,
});

export class SettingsRepository {
  constructor(private readonly pool: Pool) {}

  async getAll(): Promise<SettingEntry[]> {
    const [rows] = await this.pool.query<SettingRow[]>('SELECT * FROM settings');
    return rows.map(mapRow);
  }

  async getMap(): Promise<Record<string, string | null>> {
    const rows = await this.getAll();
    const map: Record<string, string | null> = {};
    for (const row of rows) map[row.key] = row.value;
    return map;
  }

  async upsert(key: string, value: string | null, isSecret = false): Promise<void> {
    await this.pool.execute(
      `INSERT INTO settings (setting_key, setting_value, is_secret)
       VALUES (:key, :value, :isSecret)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = VALUES(is_secret)`,
      { key, value, isSecret: isSecret ? 1 : 0 },
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.execute('DELETE FROM settings WHERE setting_key = :key', { key });
  }
}
