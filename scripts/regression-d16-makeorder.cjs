// ═══════════════════════════════════════════════════════════════════════════
// D16 REGRESSION — MUSE make-to-order: a Shopify sale of a finished good with an
// oil_id (and a BOM'd master) deducts the FULL BOM instead of finished-good stock
// ═══════════════════════════════════════════════════════════════════════════
// A variant that has oil_id set AND whose master defines a BOM is produced-on-
// demand: selling it must debit oil (from the shared Fragrance Library, MUSE
// bucket) + ethanol + packaging — NOT a finished-good stock row — and a
// cancellation must restore all of it. Variants without oil_id/BOM keep the legacy
// D13 finished-good deduction (proved by regression-muse-fulfillment.cjs).
//
// Read-write, fully self-reverting: captures every touched stock, restores it,
// deletes its probe rows (sm + sa). No production order is created.
//
// Usage: REGRESSION_BASE=http://localhost:3000 node scripts/regression-d16-makeorder.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const SECRET = process.env.SM_SHOPIFY_WEBHOOK_SECRET || process.env.MUSE_SHOPIFY_WEBHOOK_SECRET;
const sm = new Pool({ connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'), ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public' });

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms = 15000, gap = 400) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(gap); } return false; };
const near = (a, b, e = 0.02) => Math.abs(parseFloat(a) - parseFloat(b)) < e;

async function send(topic, body) {
  const raw = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64');
  const res = await fetch(`${BASE}/api/webhook/shopify/muse`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': hmac }, body: raw,
  });
  return res.status;
}
const smStock = async (code) => parseFloat((await sm.query(`SELECT current_stock FROM products WHERE product_code = $1`, [code])).rows[0].current_stock);
const oilStock = async (id) => parseFloat((await sm.query(`SELECT "currentStock" FROM sa.products WHERE id = $1`, [id])).rows[0].currentStock);

const FID = 920000000 + Math.floor(Math.random() * 9999999);
const SKU = '__D16_PROBE';
const MATS = ['RM-ETHANOL', 'CMP-RB200', 'CMP-RLID'];
let variantId = null, OIL = null;
const orig = {};

async function cleanup() {
  await sm.query(`DELETE FROM webhook_processed WHERE shopify_order_id BETWEEN $1 AND $2`, [FID, FID + 5]);
  if (variantId) await sm.query(`DELETE FROM transactions WHERE product_id = $1`, [variantId]);
  await sm.query(`DELETE FROM transactions WHERE notes LIKE '%D16-PROBE%'`);
  await sm.query(`DELETE FROM sa.transactions WHERE notes LIKE '%D16-PROBE%'`);
  if (OIL && orig.oil != null) await sm.query(`UPDATE sa.products SET "currentStock" = $1 WHERE id = $2`, [orig.oil, OIL]);
  for (const c of MATS) if (orig[c] != null) await sm.query(`UPDATE products SET current_stock = $1 WHERE product_code = $2`, [orig[c], c]);
  if (variantId) await sm.query(`DELETE FROM products WHERE id = $1`, [variantId]);
}

(async () => {
  const master = (await sm.query(`SELECT id FROM products WHERE product_code = 'RD200_TEST' AND is_master = true`)).rows[0];
  if (!master) { bad('RD200_TEST master (with BOM) exists — run regression-sm.js once first'); await sm.end(); process.exit(1); }
  OIL = (await sm.query(`SELECT id FROM sa.products WHERE category = 'OILS' AND exclusivity IS NULL ORDER BY id LIMIT 1`)).rows[0]?.id;
  if (!OIL) { bad('a shared (non-exclusive) SA oil exists'); await sm.end(); process.exit(1); }

  orig.oil = await oilStock(OIL);
  for (const c of MATS) orig[c] = await smStock(c);

  variantId = (await sm.query(
    `INSERT INTO products (name, sku, category, segment, master_product_id, oil_id, current_stock, product_code)
     VALUES ('__D16 Probe Variant', $1, 'FINISHED_GOOD', 'MUSE', $2, $3, 0, '__D16_PROBE') RETURNING id`,
    [SKU, master.id, OIL]
  )).rows[0].id;
  console.log(`fixture: variant ${variantId} (master RD200_TEST 200mL@25%, oil ${OIL}) · oil0=${orig.oil} eth0=${orig['RM-ETHANOL']}\n`);

  const order = { name: '#D16-PROBE' };

  // ── SALE qty 2 → oil −100 (2×200×25%), ethanol −300 (2×200×75%), bottle −2, lid −2; finished-good UNCHANGED ──
  await send('fulfillments/create', { id: FID, order_id: FID, status: 'success', ...order, line_items: [{ sku: SKU, quantity: 2 }] });
  await waitUntil(async () => near(await oilStock(OIL), orig.oil - 100) && near(await smStock('RM-ETHANOL'), orig['RM-ETHANOL'] - 300));

  const oilAfter = await oilStock(OIL), ethAfter = await smStock('RM-ETHANOL'), botAfter = await smStock('CMP-RB200'), lidAfter = await smStock('CMP-RLID');
  const vStock = parseFloat((await sm.query(`SELECT current_stock FROM products WHERE id = $1`, [variantId])).rows[0].current_stock);

  near(oilAfter, orig.oil - 100) ? ok('sale debits OIL from the Fragrance Library (−100 mL)', `${orig.oil} → ${oilAfter}`) : bad('oil not debited', `${orig.oil} → ${oilAfter}`);
  near(ethAfter, orig['RM-ETHANOL'] - 300) ? ok('sale debits ethanol (−300 mL)', `→ ${ethAfter}`) : bad('ethanol wrong', `→ ${ethAfter}`);
  (near(botAfter, orig['CMP-RB200'] - 2) && near(lidAfter, orig['CMP-RLID'] - 2)) ? ok('sale debits packaging (bottle −2, lid −2)') : bad('packaging wrong', `bot→${botAfter} lid→${lidAfter}`);
  near(vStock, 0) ? ok('make-to-order: finished-good stock NOT deducted (stays 0)', `variant=${vStock}`) : bad('finished-good WAS deducted (should be BOM)', `variant=${vStock}`);

  const oilTx = await sm.query(`SELECT type FROM sa.transactions WHERE notes LIKE '%D16-PROBE%' AND type = 'muse_production'`);
  oilTx.rows.length >= 1 ? ok('oil consumption tagged muse_production (feeds SA demand + 4-bucket report)') : bad('no muse_production tx in sa', JSON.stringify(oilTx.rows));

  // ── CANCEL → restore oil + ethanol + packaging exactly ──
  await send('fulfillments/update', { id: FID, order_id: FID, status: 'cancelled', ...order, line_items: [{ sku: SKU, quantity: 2 }] });
  await waitUntil(async () => near(await oilStock(OIL), orig.oil) && near(await smStock('RM-ETHANOL'), orig['RM-ETHANOL']));

  const oilR = await oilStock(OIL), ethR = await smStock('RM-ETHANOL'), botR = await smStock('CMP-RB200'), lidR = await smStock('CMP-RLID');
  (near(oilR, orig.oil) && near(ethR, orig['RM-ETHANOL']) && near(botR, orig['CMP-RB200']) && near(lidR, orig['CMP-RLID']))
    ? ok('cancellation restores oil + ethanol + packaging exactly')
    : bad('cancellation did not fully restore', `oil ${oilR}/${orig.oil} eth ${ethR}/${orig['RM-ETHANOL']} bot ${botR} lid ${lidR}`);

  await cleanup();
  console.log(`\n══════ D16 MUSE MAKE-TO-ORDER: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); await sm.end(); process.exit(1); });
