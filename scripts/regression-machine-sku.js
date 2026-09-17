// Guards the one string that connects a Shopify sale to a machine.
//
// WHY THIS EXISTS (2026-09-15/16). HVAC Scent Station was registered on the
// Products screen, which minted SA_DM_00014 correctly and pushed it to Shopify.
// The owner then opened it on the Diffusers screen to fill in colour and
// sub-category. That screen loaded the SKU field from Object.KEYS of the stored
// map — the prefix 'SA_DM' — and saving wrote the prefix back as the VALUE. The
// sale match is on the value, so the product had quietly stopped being sellable
// through the platform: a sale would arrive, match nothing, and be filed in
// webhook_skipped, which nobody reads.
//
// It had never happened before because the thirteen machines registered in March
// carry key === value ('SA_0001' → 'SA_0001'). SA_DM_00014 is the first SKU whose
// key and value differ, so it is the first one the round-trip could destroy.
//
// The fix was not to validate the typing. It was to stop asking: the SKU is
// minted on the server and the field is read-only — the same rule the Muse
// catalogue was put under on 11 August, after fifteen products launched on
// hand-typed codes. This proves the rule holds on both sides.
//
// READ-ONLY. Writes nothing.
//
// Run: node scripts/regression-machine-sku.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  console.log('\n1. The Diffusers screen reads the SKU, never the prefix');
  const screen = src('src/sa/pages/MachineInventory.jsx');
  check(!/Object\.keys\(machine\.shopifySkus/.test(screen),
    'it no longer renders Object.keys of the SKU map');
  check((screen.match(/Object\.values\(machine\.shopifySkus/g) || []).length >= 2,
    'the list and the edit form both read Object.values', 'expected both');

  console.log('\n2. And it cannot write one');
  check(!/shopifySkus:\s*skusObject/.test(screen),
    'the save payload no longer carries shopifySkus at all');
  // lastIndexOf, not indexOf: the first 'Shopify SKU' in the file is the table
  // heading. Anchoring on it passed the window over the list and never looked at
  // the form at all — the check would have gone on passing with the input made
  // editable again.
  const field = screen.slice(screen.lastIndexOf('<label>Shopify SKU</label>'));
  check(/readOnly/.test(field.slice(0, 700)), 'the field is read-only');

  console.log('\n2b. And neither does anything else that shows a SKU to a person');
  // Found by sweeping for the same mistake after fixing the screen: the exported
  // spreadsheet listed the prefixes under a column headed "Shopify SKUs", so
  // every oil read "SA_CA, SA_1L, SA_CDIFF, SA_PRO, SA_HF". The same workbook's
  // SKU Mappings sheet had it right, so one file disagreed with itself.
  const xls = src('src/sa/utils/excelExport.js');
  check(!/'Shopify SKUs': Object\.keys/.test(xls),
    'the Excel export lists SKUs, not prefixes');

  console.log('\n3. The server mints it, and mints the series Shopify already has');
  const server = src('server/sa/index.js');
  check(/Minted SKU for \$\{productId\}/.test(server),
    'PUT /products/:id mints a SKU when the product would be left without one');
  // The dangerous half of that guard. A first version minted over ANY empty
  // payload, so saving a March machine would have replaced its live SA_0013 with
  // SA_00013 — a code Shopify does not carry — and turned a working product
  // unsellable, by the very guard meant to prevent it.
  check(/Object\.keys\(stored\)\.length > 0[\s\S]{0,700}skusJson = null/.test(server),
    'and never mints over a SKU that is already stored');
  // Evaluated from the real source rather than restated here, so a change to the
  // series fails this test instead of silently disagreeing with it.
  const s = server.indexOf('const generateAutoSkus');
  const mint = eval(`(${server.slice(s, server.indexOf('\n};', s) + 3)
    .replace('const generateAutoSkus = ', '').replace(/;\s*$/, '')})`);
  // The value, not the key. SA_DM is the key the Shopify push looks its variant
  // config up by; SA_00014 is the SKU the store actually carries, set there by
  // the owner on 16 September. The two differing is the whole point.
  check(mint('SCENT_MACHINES', 14).SA_DM === 'SA_00014',
    'machine 14 mints SA_00014 — the SKU live in Shopify today',
    JSON.stringify(mint('SCENT_MACHINES', 14)));
  check(mint('SCENT_MACHINES', 15).SA_DM === 'SA_00015',
    'and the next machine continues the series');
  check(mint('MACHINES_SPARES', 22).SA_MAC === 'SA_MAC_00022', 'spares mint SA_MAC_000NN');
  check(mint('RAW_MATERIALS', 6).SA_RM === 'SA_RM_00006', 'raw materials mint SA_RM_000NN');

  console.log('\n4. Nothing live is carrying a broken SKU');
  // The corruption signature: a SKU value with no digits in it. A prefix written
  // as a value always looks like this, and a real code never does.
  const bare = (await pool.query(`
    SELECT "productCode" c, category, "shopifySkus" s
    FROM products, jsonb_each_text("shopifySkus") kv
    WHERE status = 'active' AND kv.value !~ '[0-9]'`)).rows;
  check(bare.length === 0, 'no active product has a SKU without a number in it',
    bare.map((r) => `${r.c}=${JSON.stringify(r.s)}`).join(', '));

  const empty = (await pool.query(`
    SELECT "productCode" c, name, category FROM products
    WHERE status = 'active' AND category IN ('SCENT_MACHINES','MACHINES_SPARES','RAW_MATERIALS')
      AND ("shopifySkus" IS NULL OR "shopifySkus" = '{}'::jsonb)
    ORDER BY "productCode"`)).rows;
  // Not a hard failure: a machine registered minutes ago and not yet saved is
  // legitimately here. Named rather than counted, so it is actionable — saving
  // it on the Diffusers screen now mints the code.
  if (empty.length) {
    console.log(`  note  ${empty.length} product(s) carry no SKU yet — open and save to mint:`);
    for (const r of empty) console.log(`          ${r.c.padEnd(22)} ${String(r.name).slice(0, 40)}`);
  } else {
    check(true, 'every machine, spare and raw material carries a SKU');
  }

  console.log('\n5. A machine can be registered in one place');
  // The round trip — register on Products, complete on Diffusers — is what let a
  // live SKU be overwritten. It existed because neither screen was complete:
  // Products had no colour or sub-category, and Diffusers had no code, tag or
  // SKU of its own. Owner's call, 16 September: Products is the one place.
  const prod = src('src/sa/pages/ProductManagement.jsx');
  check(/formData\.category === 'SCENT_MACHINES'/.test(prod),
    'the Products form shows the machine-only fields');
  for (const f of ['sub_category', 'color']) {
    check(new RegExp(`formData\\.${f}`).test(prod) && new RegExp(`${f}: product\\.${f}`).test(prod),
      `it edits and reloads ${f}`);
  }
  check(!/setShowAddModal\(true\);\s*\}\s*\)?\s*>\s*\n?\s*\+ Add Machine/.test(screen),
    'the Diffusers screen no longer opens a second create form');
  check(/\/sa\/products/.test(screen.slice(0, screen.indexOf('+ Add Machine'))),
    'its Add Machine button points at Products');

  console.log('\n6. A sale still lands on the value, not the key');
  // If this ever changed to match on the key, the whole finding above inverts.
  check(/jsonb_each_text\("shopifySkus"\) WHERE value = \$1/.test(server),
    'the webhook matches a sale on the SKU value');

  console.log(failed === 0
    ? '\n✅ machine-sku: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
