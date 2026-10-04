import pg from 'pg';
import { config } from './config.js';

// pg returns NUMERIC as a string, prices fit in a double so parse them
pg.types.setTypeParser(1700, (value) => (value === null ? null : Number.parseFloat(value)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

// values always go in the params array, never into the SQL string
export function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
