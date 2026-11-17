// Proves that editing a product changes only what the form sent.
//
// WHY THIS EXISTS (2026-11-17). PUT /api/sm/products/:id wrote every optional
// field it did not receive as NULL. Most forms send the whole product, so it
// went unnoticed; the MUSE fragrance edit sends three fields (name, minimum,
// notes), so saving a rename there blanked the barcode, the bin location, the
// supplier, the Shopify variant id, the price, the description and the photo.
//
// Proves: a three-field edit leaves every other field alone and its audit line
// names only what changed; a form can still clear a field by sending it empty;
// a field that is never cleared by null (name) still is not.
//
// Creates one disposable product and removes it, with its audit lines, after.
//
// Run: node scripts/regression-product-edit-keeps-fields.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

// Test copy only: this suite boots its own server, and a server runs its
// startup migrations; dotenv above reads the LIVE url. Same guard as regression-sa.js.
if (!(process.env.PLATFORM_DATABASE_URL || '').includes('ep-old-water-') && process.env.REGRESSION_ALLOW_PRODUCTION !== '1') {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-). Set REGRESSION_ALLOW_PRODUCTION=1 to override.');
  process.exit(1);
}
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `ZZEDIT_${String(Date.now()).slice(-8)}`;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

// What the product starts with. Every one of these used to be blanked.
const FILLED = {
  sub_category: 'Probe', supplier: 'Probe Supplier', supplier_code: 'PS-1',
  bin_location: 'A-01-02', barcode: `${TAG}-BC`, shopify_variant_id: '99999999',
  lead_time: 14, notes: 'old note', image_data: 'data:image/png;base64,AAAA',
  price: 12.5, description: 'Probe description',
};

let failed = 0, server, productId;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const row = async () => (await pool.query('SELECT * FROM products WHERE id = $1', [productId])).rows[0];
const same = (a, b) => (a == null ? null : String(Number.isNaN(Number(a)) ? a : Number(a))) === (b == null ? null : String(Number.isNaN(Number(b)) ? b : Number(b)));

try {
  const client = (await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1')).rows[0];
  if (client) FILLED.client_id = client.id;
  const cols = Object.keys(FILLED);
  productId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, current_stock, min_stock_level, segment, ${cols.join(', ')})
     VALUES ($1, $2, 'FINISHED_GOOD', 'units', 0, 5, 'MUSE', ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [`${TAG} probe`, TAG, ...cols.map((c) => FILLED[c])])).rows[0].id;

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  // 3 minutes: a cold Neon connection has taken longer than 90×500ms before.
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  const token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SM', 'MUSE'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
  const put = (body) => fetch(`${BASE}/api/sm/products/${productId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });

  console.log('\n1. The MUSE fragrance edit: three fields sent');
  const r1 = await put({ name: `${TAG} renamed`, min_stock_level: 7, notes: 'new note' });
  check(r1.status === 200, 'the edit answers 200', `got ${r1.status}`);
  const a = await row();
  check(a.name === `${TAG} renamed` && Number(a.min_stock_level) === 7 && a.notes === 'new note', 'the three fields sent were saved');
  for (const c of cols.filter((k) => k !== 'notes')) {
    check(same(a[c], FILLED[c]), `${c} is untouched`, `was ${JSON.stringify(FILLED[c]).slice(0, 30)}, now ${JSON.stringify(a[c])?.slice(0, 30)}`);
  }
  const audit = (await pool.query(
    `SELECT details FROM audit_log WHERE action = 'product_updated' AND entity_type = 'product' AND entity_id::text = $1 ORDER BY id DESC LIMIT 1`,
    [String(productId)])).rows[0]?.details || {};
  check(Object.keys(audit).sort().join(',') === 'min_stock_level,name', 'the audit line names only what changed', `got ${Object.keys(audit).join(',')}`);

  console.log('\n2. A form can still clear a field by sending it empty');
  const r2 = await put({ barcode: null, price: '' });
  check(r2.status === 200, 'the edit answers 200', `got ${r2.status}`);
  const b = await row();
  check(b.barcode === null && b.price === null, 'barcode and price were cleared');
  check(b.bin_location === FILLED.bin_location && b.supplier === FILLED.supplier && b.name === `${TAG} renamed`, 'nothing else moved');

  console.log('\n3. A field that null never clears still is not cleared');
  await put({ name: null, bin_location: 'B-09' });
  const c = await row();
  check(c.name === `${TAG} renamed`, 'name null keeps the name');
  check(c.bin_location === 'B-09', 'and the field sent beside it was saved');

  const none = await fetch(`${BASE}/api/sm/products/2147483000`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'x' }),
  });
  check(none.status === 404, 'an unknown product answers 404', `got ${none.status}`);
} catch (e) {
  failed++;
  console.error('ERROR', e.message);
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  if (productId) {
    await pool.query(`DELETE FROM audit_log WHERE entity_type = 'product' AND entity_id::text = $1`, [String(productId)]).catch(() => {});
    await pool.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});
  }
  await pool.end();
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
