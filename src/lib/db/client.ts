import { Pool, types } from 'pg'

// Return timestamps as ISO strings, not Date objects.
// Our TypeScript types declare all timestamp columns as `string`.
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v: string) => v)
types.setTypeParser(types.builtins.TIMESTAMP, (v: string) => v)

const connectionString = process.env.MONITOR_POSTGRES_URL

if (
  !connectionString &&
  process.env.NODE_ENV === 'production' &&
  process.env.NEXT_PHASE !== 'phase-production-build'
) {
  throw new Error('MONITOR_POSTGRES_URL is not set')
}

export const pool = new Pool({
  connectionString: connectionString ?? 'postgresql://localhost/monitor_dev',
  max: Number(process.env.MONITOR_POSTGRES_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  ssl: connectionString?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
})

/**
 * Parametrised query that returns rows.
 * For transactions, use pool.connect() directly or withTransaction().
 */
export async function query<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query(text, params)
  return res.rows as T[]
}

/** Run a callback inside a transaction with BEGIN/COMMIT/ROLLBACK. */
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
