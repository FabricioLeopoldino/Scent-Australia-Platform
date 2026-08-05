// Proves the SA Shopify webhook handler only opens a database connection on the
// paths that actually need one.
//
// WHY THIS EXISTS (2026-08-06): `saWebhookHandler` used to call
// `await pool.connect()` on its very first line, before HMAC verification and
// before looking at the topic. Opening a connection wakes the Neon compute, and
// Neon bills by CU-hour and auto-suspends after 5 idle minutes. Shopify sends a
// stream of `fulfillments/update` no-ops (carrier tracking updates arrive around
// the clock, weekends included), so the database was held awake ~24/7: measured
// 118 h of compute against a 34 h keep-alive window. This is a COST regression
// guard — if it breaks nothing crashes, the monthly bill just grows silently.
//
// THE INSTRUMENT: boot the server with NO database configured. Any path that
// tries to connect fails; any path that does not, answers normally. A plain
// HTTP 200 is therefore proof that no connection was attempted.
//
// Payloads are signed for real (both the platform receiver and the SA handler
// verify HMAC), so this exercises the production path, not a dev-mode bypass.
//
// Run: node scripts/regression-webhook-lazy-connect.js

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PLATFORM_DATABASE_URL: '',   // the instrument: no database at all
    PORT: String(PORT),
    NODE_ENV: 'test',
    // Override whatever .env holds so we can sign payloads ourselves.
    SA_SHOPIFY_WEBHOOK_SECRET: SECRET,  // checked by the platform receiver
    SHOPIFY_WEBHOOK_SECRET: SECRET,     // checked again inside saWebhookHandler
    SA_SHOPIFY_API_SECRET: '',
    SCENT_SHOPIFY_WEBHOOK_SECRET: '',
    SHOPIFY_API_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

// Every request is bounded. With the bug reintroduced, `pool.connect()` sits
// OUTSIDE the try block, so a connection failure becomes an unhandled rejection
// and the request hangs forever rather than erroring — the suite must report
// that as a clean failure, not stall.
const REQUEST_TIMEOUT_MS = 15000;

function send(topic, body, hmac) {
  return fetch(`${BASE}/api/webhook/shopify/sa`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-hmac-sha256': hmac,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((e) => ({
    status: 0,
    timedOut: e.name === 'TimeoutError' || e.name === 'AbortError',
    json: async () => ({ error: e.message }),
  }));
}

function post(topic, payload) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
  return send(topic, body, hmac);
}

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  if (!await waitForBoot()) throw new Error(`server did not boot\n${serverLog}`);

  // ── THE HOT PATH: a carrier tracking update. Must answer with no database. ──
  {
    const r = await post('fulfillments/update', {
      id: 999001, name: '#T-1001', status: 'success', line_items: [],
    });
    const body = await r.json().catch(() => ({}));
    check(r.status === 200, 'no-op fulfillments/update answers 200 with no DB',
      r.timedOut ? 'TIMED OUT — the handler tried to reach the database' : `got ${r.status}`);
    check(body.skipped === 'fulfillment_update_not_cancelled',
      'no-op takes the skip path', `got ${JSON.stringify(body)}`);
  }

  // ── Other paths that must never need a connection ──────────────────────────
  {
    const r = await post('orders/fulfilled', { id: 999002, name: '#T-1002', line_items: [] });
    const body = await r.json().catch(() => ({}));
    check(r.status === 200 && body.skipped === 'handled_by_fulfillments_create',
      'orders/fulfilled skips with no DB', `got ${r.status} ${JSON.stringify(body)}`);
  }
  {
    const r = await post('fulfillments/update', { id: 999003, name: '#T-1003', status: 'success' });
    const body = await r.json().catch(() => ({}));
    check(r.status === 200 && body.skipped === 'no_line_items',
      'missing line_items skips with no DB', `got ${r.status} ${JSON.stringify(body)}`);
  }

  // ── A bad signature must still be rejected, and still without a database ───
  {
    const body = JSON.stringify({ id: 999005, name: '#T-1005', status: 'success', line_items: [] });
    const r = await send('fulfillments/update', body, 'ZGVmaW5pdGVseS13cm9uZw==');
    check(r.status === 401, 'invalid HMAC is rejected 401 (and never connects)',
      r.timedOut ? 'TIMED OUT — the handler connected before verifying' : `got ${r.status}`);
  }

  // ── COUNTER-PROOF: real work must still reach for a connection. Without this
  //    the suite would also pass if someone deleted the connection outright and
  //    quietly broke stock deduction. ─────────────────────────────────────────
  {
    const r = await post('fulfillments/create', {
      id: 999004, name: '#T-1004', line_items: [{ sku: 'NOPE-TEST', quantity: 1 }],
    });
    const body = await r.json().catch(() => ({}));
    const tookASkipPath = body.skipped === 'fulfillment_update_not_cancelled'
      || body.skipped === 'no_line_items'
      || body.skipped === 'handled_by_fulfillments_create';
    check(!tookASkipPath && r.status !== 200,
      'fulfillments/create still requires the DB (fails without one)',
      `got ${r.status} ${JSON.stringify(body)}`);
  }

  console.log(failed === 0
    ? '\n✅ webhook-lazy-connect: all checks passed'
    : `\n❌ webhook-lazy-connect: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ webhook-lazy-connect: ${e.message}`);
  failed++;
} finally {
  server.stdout.destroy();
  server.stderr.destroy();
  server.kill();
}

// Set the code and let the loop drain — process.exit() here races the child's
// pipe teardown and trips a libuv assertion on Windows.
process.exitCode = failed === 0 ? 0 : 1;
