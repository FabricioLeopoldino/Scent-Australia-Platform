// Proves that no screen can create a product in Shopify while the hold is on.
//
// WHY THIS EXISTS (19 Nov 2026). The owner put creating products in Shopify
// from the platform on hold, until the company defines how a product is
// created there (shared/shopify-block.js). Products are still created in the
// platform. Every path that used to create a Shopify product or size must
// answer with the notice, and a new product must come back carrying it.
//
// Runs with every Shopify token blanked (run-tests.sh), so even a path the
// hold missed could not reach a real store: it would fail differently, and
// this test would say so.
//
// Run: node scripts/regression-shopify-create-blocked.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { SHOPIFY_BLOCK_MESSAGE } from '../shared/shopify-block.js';

if (!(process.env.PLATFORM_DATABASE_URL || '').includes('ep-old-water-') && process.env.REGRESSION_ALLOW_PRODUCTION !== '1') {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-). Set REGRESSION_ALLOW_PRODUCTION=1 to override.');
  process.exit(1);
}
const { Pool } = pkg;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `ZZBLOCK ${String(Date.now()).slice(-8)}`;
const pool = new Pool({ connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'), ssl: { rejectUnauthorized: false } });

let failed = 0, server, createdId = null, formulaId = null;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test',
      // A real store must be unreachable whatever the hold does.
      SHOPIFY_STORE_NAME: 'zz-no-such-store', SA_SHOPIFY_SHOP_DOMAIN: 'zz-no-such-store.example', SM_SHOPIFY_SHOP_DOMAIN: 'zz-no-such-store.example',
      SHOPIFY_SYNC_ENABLED: 'true', SM_SHOPIFY_SYNC_ENABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  const token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SA', 'SM', 'MUSE'] }, process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const refused = (r, label) => check(r.status === 423 && r.json.error === SHOPIFY_BLOCK_MESSAGE, label, `got ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);

  const oil = (await pool.query(`SELECT id FROM sa.products WHERE category = 'OILS' AND status = 'active' ORDER BY "productCode" LIMIT 1`)).rows[0];
  const machine = (await pool.query(`SELECT id FROM sa.products WHERE category <> 'OILS' ORDER BY "productCode" LIMIT 1`)).rows[0];
  const museProduct = (await pool.query(`SELECT id FROM sm.products WHERE price > 0 ORDER BY id LIMIT 1`)).rows[0];

  console.log('\n1. SA store');
  refused(await call('POST', `/api/sa/shopify/publish/${oil.id}`, { costPerLitre: 50 }), 'Publish an oil is refused with the notice');
  refused(await call('POST', `/api/sa/shopify/add-missing-variants/${oil.id}`, {}), 'Add missing sizes of an oil is refused with the notice');
  refused(await call('POST', `/api/sa/shopify/publish/${machine.id}`, {}), 'Publish any other product is refused with the notice');
  refused(await call('POST', `/api/sa/shopify/add-missing-variants/${machine.id}`, {}), 'Add missing for any other product is refused with the notice');

  console.log('\n2. A new SA product is created in the platform, with the notice');
  const made = await call('POST', '/api/sa/products', { name: TAG, category: 'RAW_MATERIALS', unit: 'units', currentStock: 0, minStockLevel: 0 });
  createdId = made.json.id || null;
  check(made.status === 200 && !!createdId, 'the product is created', `got ${made.status} ${JSON.stringify(made.json).slice(0, 160)}`);
  check(made.json.shopify_notice === SHOPIFY_BLOCK_MESSAGE, 'and the answer carries the notice');
  check(!/Shopify sync failed|Product synced to Shopify/.test(log), 'and no attempt to reach Shopify was made');

  console.log('\n3. A new formula with "publish to Shopify" is created, not published');
  const base = (await pool.query(`SELECT "productCode" c FROM sa.products WHERE unit = 'mL' AND category <> 'OILS' ORDER BY 1 LIMIT 1`)).rows[0];
  const oilCode = (await pool.query(`SELECT "productCode" c FROM sa.products WHERE category = 'OILS' ORDER BY 1 LIMIT 1`)).rows[0];
  const code = `ZZBLK_${String(Date.now()).slice(-6)}`;
  const f = await call('POST', '/api/sa/formulas', { tag: code, product_code: code, name: TAG, shopify_skus: [`${code}_400`],
    base_product_code: base?.c || oilCode.c, base_percentage: 90, oil_product_code: oilCode.c, oil_percentage: 10, publishToShopify: true });
  formulaId = f.json.id || null;
  check(f.status === 200 && f.json.shopifyResult?.blocked === true && f.json.shopifyResult?.error === SHOPIFY_BLOCK_MESSAGE,
    'the formula is saved and the Shopify step answers with the notice', `got ${f.status} ${JSON.stringify(f.json.shopifyResult || f.json).slice(0, 160)}`);

  console.log('\n4. MUSE store');
  if (museProduct) refused(await call('POST', `/api/sm/products/${museProduct.id}/shopify/publish`, {}), 'Publish a MUSE product is refused with the notice');
  else check(false, 'a MUSE product with a price to try');
  const n = (await pool.query(`SELECT substring(sku from '[0-9]+$')::int n FROM sm.products
      WHERE sku LIKE 'Muse@_%' ESCAPE '@' AND shopify_product_id IS NULL AND NOT COALESCE(archived, false) ORDER BY 1 DESC LIMIT 1`)).rows[0];
  if (n) {
    const r = await call('POST', `/api/sm/muse-fragrance/${n.n}/publish`, {});
    // It reads the store first (to adopt a product already there); with the
    // store unreachable that read fails before the hold is reached, so either
    // answer proves no product was created. The hold itself is asserted from
    // the source below.
    check(r.status >= 400, 'the New Fragrance publish does not create a product', `got ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  }
  const { readFileSync } = await import('node:fs');
  const sync = readFileSync(join(ROOT, 'server/sm/services/shopify-sync.js'), 'utf8');
  const body = sync.slice(sync.indexOf('async function createMuseProductOnShopify'));
  check(/SHOPIFY_PRODUCT_CREATION_BLOCKED\) throw/.test(body.slice(0, 600)), 'createMuseProductOnShopify refuses first, before anything else');
} catch (e) {
  failed++;
  console.error('ERROR', e.message);
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  if (createdId) {
    await pool.query(`DELETE FROM sa.audit_log WHERE entity_id::text = $1`, [String(createdId)]).catch(() => {});
    await pool.query(`DELETE FROM sa.transactions WHERE product_id = $1`, [createdId]).catch(() => {});
    await pool.query(`DELETE FROM sa.products WHERE id = $1`, [createdId]).catch(() => {});
  }
  if (formulaId) {
    await pool.query(`DELETE FROM sa.audit_log WHERE entity_type = 'formula' AND entity_id::text = $1`, [String(formulaId)]).catch(() => {});
    await pool.query(`DELETE FROM sa.formulas WHERE id = $1`, [formulaId]).catch(() => {});
  }
  await pool.end();
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
