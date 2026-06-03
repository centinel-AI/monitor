import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pool } from './client'

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations')

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)

  const applied = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows
      .map((r: { filename: string }) => r.filename),
  )

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    console.log(`[migrate] applying ${file}`)
    await pool.query('BEGIN')
    try {
      await pool.query(sql)
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
      await pool.query('COMMIT')
    } catch (e) {
      await pool.query('ROLLBACK')
      throw e
    }
  }
}

// Run directly: node -r tsx/cjs src/lib/db/migrate.ts
if (process.env.RUN_MIGRATE === '1') {
  runMigrations()
    .then(() => { console.log('[migrate] done'); process.exit(0) })
    .catch((e) => { console.error(e); process.exit(1) })
}
