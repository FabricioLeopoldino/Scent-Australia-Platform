import 'dotenv/config';
import pkg from 'pg';
const { Pool, types } = pkg;

// Treat TIMESTAMP WITHOUT TIME ZONE columns as UTC.
// Prevents the pg driver from double-shifting naive timestamps because of
// process.env.TZ = 'Australia/Sydney' (same fix both legacy systems use).
types.setTypeParser(1114, (val) => new Date(val + 'Z'));

const DATABASE_URL = process.env.PLATFORM_DATABASE_URL;

// Neon's pooled endpoint (PgBouncer, host contains "-pooler") rejects the
// `options=-c search_path=...` startup parameter. The SA/SM pools REQUIRE
// search_path (their legacy queries are unqualified by design — PRD §7.3),
// so they connect to the DIRECT endpoint: same host minus "-pooler".
// The platform pool needs no search_path (its queries are fully
// schema-qualified) and keeps the pooled endpoint.
function directUrl(url) {
  if (!url) return url;
  return url.replace('-pooler.', '.');
}

// Free-tier resilience (NFR-7): Neon drops idle connections — keep the pool
// small, release idle clients fast, and never crash on transient pool errors.
const POOL_TUNING = {
  max: 10,
  min: 0,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true,
};

function makePool(label, { searchPath } = {}) {
  const url = searchPath ? directUrl(DATABASE_URL) : DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    ssl: url?.includes('localhost') ? false : { rejectUnauthorized: false },
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
    ...POOL_TUNING,
  });
  pool.on('error', (err) => {
    console.error(`[db] Unexpected pool error (${label}):`, err.message);
    // Don't exit — the pool recovers dropped Neon connections automatically.
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      console.error(`[db] Client error (${label}):`, err.message);
    });
  });
  return pool;
}

// One pool per module. search_path makes each module's unqualified table
// names resolve to its own schema — SA/SM query text stays untouched.
export const platformPool = makePool('platform'); // schema-qualified queries, pooled endpoint
export const saPool = makePool('sa', { searchPath: 'sa,public' });
export const smPool = makePool('sm', { searchPath: 'sm,public' });

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
