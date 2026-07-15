import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../logger.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationRow extends RowDataPacket {
  filename: string;
}

export const runMigrations = async (pool: Pool, logger: Logger): Promise<void> => {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  const [applied] = await pool.query<MigrationRow[]>('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((row) => row.filename));

  for (const filename of files) {
    if (appliedSet.has(filename)) continue;
    const filepath = path.join(MIGRATIONS_DIR, filename);
    const sql = await readFile(filepath, 'utf8');
    const statements = sql
      .split(/;\s*$/m)
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0 && !stmt.startsWith('--'));

    const connection = await pool.getConnection();
    try {
      for (const statement of statements) {
        await connection.query(statement);
      }
      await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
      logger.info({ event: 'db_migration_applied', filename }, `Migration applied: ${filename}`);
    } catch (error) {
      logger.error({ err: error, filename, event: 'db_migration_failed' }, 'Migration failed');
      throw error;
    } finally {
      connection.release();
    }
  }
};
