import 'dotenv/config';
import pkg from 'pg';
const { Pool, types } = pkg;

// Treat TIMESTAMP WITHOUT TIME ZONE columns as UTC.
// Prevents the pg driver from double-shifting naive timestamps because of
// process.env.TZ = 'Australia/Sydney' (same fix both legacy systems use).
types.setTypeParser(1114, (val) => new Date(val + 'Z'));

const DATABASE_URL = process.env.PLATFORM_DATABASE_URL;

// Free-tier resilience (NFR-7): Neon drops idle connections — keep the pool
// small, release idle clients fast, and never crash on transient pool errors.
const POOL_TUNING = {
  max: 10,
  min: 0,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true,
};

function makePool(searchPath) {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    options: `-c search_path=${searchPath}`,
    ...POOL_TUNING,
  });
  pool.on('error', (err) => {
    console.error(`[db] Unexpected pool error (${searchPath}):`, err.message);
    // Don't exit — the pool recovers dropped Neon connections automatically.
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      console.error(`[db] Client error (${searchPath}):`, err.message);
    });
  });
  return pool;
}

// One pool per module. search_path makes each module's unqualified table
// names resolve to its own schema — SA/SM query text stays untouched.
export const platformPool = makePool('platform,public');
export const saPool = makePool('sa,public');
export const smPool = makePool('sm,public');

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export function isDbConfigured() {
  return Boolean(DATABASE_URL);
}
