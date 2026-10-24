import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(databaseUrl?: string) {
  const connString =
    databaseUrl ??
    process.env['DATABASE_URL'] ??
    'postgresql://agentpay:agentpay_dev_pw@localhost:5432/agentpay';

  console.log(`[db:migrate] Connecting to database...`);
  const pool = new pg.Pool({ connectionString: connString, connectionTimeoutMillis: 5000 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create migrations tracking table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const checkRes = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [file],
      );

      if (checkRes.rowCount === 0) {
        console.log(`[db:migrate] Applying migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())',
          [file],
        );
        console.log(`[db:migrate] Successfully applied: ${file}`);
      } else {
        console.log(`[db:migrate] Migration already applied: ${file}`);
      }
    }

    await client.query('COMMIT');
    console.log('[db:migrate] All migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[db:migrate] Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Allow direct execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
