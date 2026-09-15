// Proves that selling a refurbished machine takes out the parts that ship with
// it, and that cancelling puts them back.
//
// WHY THIS EXISTS (2026-09-15). The webhook read:
//
//     // Check if product is a Machine — no BOM, direct debit
//
// and did exactly that. 2,447 machines have been sold through it, 14 of them
// refurbished, and not one component ever came out with them. The owner
// confirmed that is wrong in the world: "sim sai junto com alguns outros spare
// parts". So the machine left the building with a bottle in the box and the
// system only ever knew about the machine.
//
// Only REFURBISHED machines are wired up. A new machine's parts list lives in
// the separate diffuser_bom table under type codes nothing maps to a product,
// so there is no honest way to resolve one — see shared/refurb-machines.js.
//
// WHAT THIS TEST TOUCHES, and why that is acceptable. The resolver reads a
// static map, so a throwaway machine resolves to nothing and cannot exercise
// the path at all. It therefore sells a REAL refurbished machine, one unit, and
// cancels it — the cancellation is the restore, and it is verified rather than
// assumed. The component it watches IS disposable, so the numbers being
// asserted are not production ones. The finally block puts everything back and
// then checks that it did, because a suite that half-cleans is worse than one
// that does not run: that is how three real balances drifted on 14 September.
//
// Run: node scripts/regression-machine-bom-consumption.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
import { bomVariantFor, refurbVariantFor, REFURB_MACHINE_COVERAGE } from '../shared/refurb-machines.js';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3980;
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const COMP = `ZZMB_${STAMP}`.slice(0, 20);      // disposable component
// The 700 Medium on purpose: its variant is EMPTY, so the only things this
// suite can move are the machine and its own probe. Hanging the probe off
// REFURB_SCENTPRO instead would have dragged the real PRO bottle into every
// run — which is exactly what happened on the first attempt, and left
// SA_RM_00006 one unit out until it was put back.
const MACHINE = 'SA_RF00005';                    // real: ScentPro 700 Medium refurb, BLACK
const VARIANT = refurbVariantFor(MACHINE);
const ORDER = `#ZZMB${STAMP % 100000}`;
// Unique per run. A fixed fulfillment id is deduplicated by the webhook's own
// idempotency guard, so a second run of this suite silently does nothing and
// every assertion below passes or fails for the wrong reason. The first version
// had 90000001 hardcoded and reported a reversal failure that was really a sale
// that never happened.
const FULFILMENT_ID = 900000000 + (STAMP % 90000000);

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0, server, bomRowAdded = false, machineBefore = null;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const stockOf = async (code) => Number((await pool.query(
  `SELECT "currentStock"::float s FROM products WHERE "productCode" = $1`, [code])).rows[0]?.s);

try {
  console.log('\n1. The resolver decides, and it decides once');
  // A pure check, before anything is written. The sale and the reversal must
  // ask the SAME function — two copies of this decision is how a cancellation
  // starts crediting something the sale never took.
  check(bomVariantFor({ category: 'SCENT_MACHINES', productCode: MACHINE }) === VARIANT,
    `a refurbished machine resolves to its model's variant (${MACHINE} → ${VARIANT})`);
  check(bomVariantFor({ category: 'SA_SCENTED_PRODUCTS', productCode: 'SA_RD__00004' }) === 'SA_RD__00004',
    'a scented product still resolves to its own SKU, exactly as before');
  check(bomVariantFor({ category: 'SCENT_MACHINES', productCode: 'SCENT_MACHINES_00001' }) === null,
    'a NEW machine resolves to nothing — no mapping exists, so nothing is guessed');
  check(bomVariantFor({ category: 'MACHINES_SPARES', productCode: 'X' }) === null,
    'and a spare part is not a thing with a BOM');

  const src = (await import('node:fs')).readFileSync(join(ROOT, 'server/sa/index.js'), 'utf8');
  check((src.match(/bomVariantFor\(product\)/g) || []).length === 2,
    'the webhook calls the resolver exactly twice — once to sell, once to reverse',
    `${(src.match(/bomVariantFor\(product\)/g) || []).length} call sites`);

  // A disposable component, hung off the real variant for the duration.
  await pool.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", status)
     VALUES ($1,$1,$1,$2,'MACHINES_SPARES','units',500,'active')`, [COMP, `${COMP} probe part`]);
  await pool.query(
    `INSERT INTO bom (variant, seq, component_code, component_name, quantity)
     VALUES ($1::text, (SELECT COALESCE(MAX(seq),0)+1 FROM bom WHERE variant = $1::text), $2, $3, 2)`,
    [VARIANT, COMP, `${COMP} probe part`]);
  bomRowAdded = true;

  machineBefore = await stockOf(MACHINE);
  const compBefore = await stockOf(COMP);
  console.log(`\n(${MACHINE} at ${machineBefore} units, probe component at ${compBefore})`);

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-800)}`);

  const SECRET = process.env.SA_SHOPIFY_WEBHOOK_SECRET;
  const post = async (topic, payload) => {
    const body = JSON.stringify(payload);
    return fetch(`${BASE}/api/webhook/shopify/sa`, {
      method: 'POST', body,
      headers: {
        'Content-Type': 'application/json', 'X-Shopify-Topic': topic,
        'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64'),
      },
    });
  };
  // The handler answers 200 and commits after; poll the end state rather than
  // sleeping a guessed duration against a remote database.
  const waitFor = async (fn, ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 750)); }
    return false;
  };

  const line = { sku: MACHINE, quantity: 1, name: 'probe' };
  console.log('\n2. Selling one takes the machine AND what ships with it');
  await post('fulfillments/create', {
    id: FULFILMENT_ID, order_id: FULFILMENT_ID, name: ORDER, order_name: ORDER,
    line_items: [line],
  });
  const sold = await waitFor(async () => (await stockOf(COMP)) === compBefore - 2);
  check(sold, 'the component came out, 2 per machine as its BOM line says',
    `component at ${await stockOf(COMP)}, expected ${compBefore - 2}`);
  check((await stockOf(MACHINE)) === machineBefore - 1, 'and the machine itself came out once',
    `${await stockOf(MACHINE)} vs ${machineBefore - 1}`);
  const row = (await pool.query(
    `SELECT notes FROM transactions WHERE product_code = $1 ORDER BY id DESC LIMIT 1`, [COMP])).rows[0];
  check(!!row && row.notes.includes(VARIANT),
    'the ledger row names the variant that caused it, not just "BOM"', row?.notes);

  console.log('\n3. Cancelling gives back exactly what the sale took');
  // The half that matters most. A sale that debits and a cancellation that does
  // not credit is a leak that looks like a working feature.
  // fulfillments/UPDATE with status cancelled — there is no fulfillments/cancel
  // topic here, and sending one is silently ignored. The first run of this
  // suite did exactly that and reported a reversal failure that was its own.
  await post('fulfillments/update', {
    id: FULFILMENT_ID, order_id: FULFILMENT_ID, name: ORDER, order_name: ORDER,
    status: 'cancelled', line_items: [line],
  });
  // Only meaningful if the sale actually moved something. Without this the
  // section passes perfectly when the sale never fired — which is how the
  // deduplicated second run reported a green reversal over a no-op.
  check(sold, 'the sale really happened, so this section is testing something');
  const back = await waitFor(async () => (await stockOf(COMP)) === compBefore);
  check(back, 'the component is back to where it started',
    `component at ${await stockOf(COMP)}, expected ${compBefore}`);
  check((await stockOf(MACHINE)) === machineBefore, 'and so is the machine',
    `${await stockOf(MACHINE)} vs ${machineBefore}`);

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /BOM|Debited|Reversed|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ machine-bom-consumption: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // Put the real machine back whatever happened above, then PROVE it. A suite
  // that half-cleans is worse than one that never ran.
  try {
    if (bomRowAdded) await pool.query(`DELETE FROM bom WHERE component_code = $1`, [COMP]);
    await pool.query(`DELETE FROM transactions WHERE product_code = $1`, [COMP]);
    await pool.query(`DELETE FROM products WHERE "productCode" = $1`, [COMP]);
    // Every row this order touched, whatever product it hit. Scoping this to
    // the machine and the probe is how a real component stayed moved last time.
    await pool.query(`DELETE FROM transactions WHERE shopify_order_id = $1`, [ORDER]);
    // The real machine goes back to the figure read before anything was sent,
    // whether or not the reversal ran. If the suite dies between the sale and
    // the cancel, this is the only thing standing between a test and a wrong
    // balance on a live product.
    if (machineBefore !== null) {
      const now = await stockOf(MACHINE);
      if (now !== machineBefore) {
        await pool.query(`UPDATE products SET "currentStock" = $1 WHERE "productCode" = $2`,
          [machineBefore, MACHINE]);
        console.log(`  note  ${MACHINE} put back to ${machineBefore} (was ${now})`);
      }
    }
  } catch (e) { console.log(`  FAIL  cleanup threw — ${e.message}`); failed++; }
  const leftComp = Number((await pool.query(
    `SELECT count(*) c FROM products WHERE "productCode" = $1`, [COMP])).rows[0].c)
    + Number((await pool.query(`SELECT count(*) c FROM bom WHERE component_code = $1`, [COMP])).rows[0].c)
    + Number((await pool.query(
      `SELECT count(*) c FROM transactions WHERE shopify_order_id = $1`, [ORDER])).rows[0].c);
  const machineNow = machineBefore === null ? null : await stockOf(MACHINE);
  if (machineBefore !== null) {
    console.log(machineNow === machineBefore
      ? `  ok    ${MACHINE} back at ${machineBefore}`
      : `  FAIL  ${MACHINE} is ${machineNow}, should be ${machineBefore}`);
    if (machineNow !== machineBefore) failed++;
  }
  console.log(leftComp === 0 ? '  ok    left exactly as found'
    : `  FAIL  ${leftComp} probe row(s) left behind — check ${COMP} and order ${ORDER}`);
  if (leftComp) failed++;
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
