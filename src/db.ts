import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run work inside one transaction.
 *
 * Every write in Part One goes through this, because §4.3 requires the audit
 * event to be appended in the SAME transaction as the change it records. A
 * helper that makes the correct thing the easy thing.
 */
export async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
