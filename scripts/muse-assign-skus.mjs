// D18 / MUSE launch — write the platform SKU onto each Shopify variant.
//
// WHY: marketing rebuilt the Muse catalogue as one product per FRAGRANCE with a
// variant per FORMAT, and created every variant WITHOUT a SKU. The SKU is the
// only join between Shopify and the platform: `smFulfillmentHandler` reads
// `line_items[].sku` and does `SELECT … FROM products WHERE sku = $1`. With an
// empty SKU it hits `if (!sku) continue` — the sale ships, stock never moves,
// and NOTHING is logged. This script closes that gap before MUSE goes live.
//
// SAFETY
//   · Dry run by default. Writes only with --commit.
//   · Refuses to run without MUSE_ALLOW_WRITE=yes as well.
//   · PARTIAL update: sends only the SKU field, so titles, descriptions,
//     images, metafields, collections, tags and prices are untouched. (This is
//     why we are not using Shopify's CSV import, which rewrites whole rows.)
//   · Never overwrites a variant that already has a SKU.
//   · Snapshots every variant's prior state to a timestamped JSON first.
//   · Verifies each planned SKU still exists in the platform before writing.
//
// Usage:
//   node scripts/muse-assign-skus.mjs                 # dry run
//   MUSE_ALLOW_WRITE=yes node scripts/muse-assign-skus.mjs --commit
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
const PLAN_FILE = process.argv.find((a) => a.endsWith('.csv')) || '../MUSE_SKU_PLAN.csv';
const API = '2025-01';

if (COMMIT && process.env.MUSE_ALLOW_WRITE !== 'yes') {
  console.error('Refusing to write: set MUSE_ALLOW_WRITE=yes as well as --commit.');
  process.exit(1);
}
const DOMAIN = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;
if (!DOMAIN || !TOKEN) { console.error('MUSE_SHOPIFY_SHOP_DOMAIN / _ACCESS_TOKEN missing.'); process.exit(1); }

function parseCsv(t) {
  const rs = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f); rs.push(r); r = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || r.length) { r.push(f); rs.push(r); }
  return rs;
}

const shopify = async (path, init = {}) => {
  const res = await fetch(`https://${DOMAIN}/admin/api/${API}${path}`, {
    ...init,
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  // Shopify REST allows 2 calls/second; back off politely rather than hammering.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return shopify(path, init);
  }
  return res;
};

// ── 1. Plan ────────────────────────────────────────────────────────────────
const plan = parseCsv(readFileSync(PLAN_FILE, 'utf8')).slice(1)
  .filter((r) => r[0] && r[3] && r[4] !== 'already set')
  .map((r) => ({ handle: r[0], fragrance: r[1], format: r[2], sku: r[3], source: r[4] }));
console.log(`Plan .................. ${plan.length} variants from ${PLAN_FILE}`);

// ── 2. Every planned SKU must still exist in the platform ──────────────────
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});
const known = await pool.query(
  `SELECT sku FROM products WHERE sku = ANY($1) AND COALESCE(archived,false) = false`,
  [[...new Set(plan.map((p) => p.sku))]]);
await pool.end();
const knownSkus = new Set(known.rows.map((r) => r.sku));
const orphan = plan.filter((p) => !knownSkus.has(p.sku));
if (orphan.length) {
  console.error(`\n❌ ${orphan.length} planned SKUs are not live products in the platform — aborting.`);
  orphan.slice(0, 10).forEach((p) => console.error(`   ${p.sku}  ${p.fragrance} — ${p.format}`));
  process.exit(1);
}
console.log(`Platform check ........ all ${plan.length} SKUs exist and are active ✅`);

// ── 3. Read the live Shopify catalogue ─────────────────────────────────────
const wanted = new Set(plan.map((p) => p.handle));
const live = new Map();
let url = `/products.json?limit=250&fields=id,handle,title,variants`;
for (let page = 0; url && page < 20; page++) {
  const res = await shopify(url);
  if (!res.ok) { console.error(`Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const { products } = await res.json();
  for (const p of products) if (wanted.has(p.handle)) live.set(p.handle, p);
  const link = res.headers.get('link') || '';
  const next = link.split(',').find((s) => s.includes('rel="next"'));
  url = next ? '/products.json' + next.match(/[?&](page_info=[^>]+)/)?.[0].replace(/^&/, '?') + '&limit=250' : null;
}
console.log(`Shopify ............... ${live.size} of ${wanted.size} planned products found`);

// ── 4. Resolve each plan row to a concrete variant ─────────────────────────
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const actions = [], problems = [];
for (const row of plan) {
  const prod = live.get(row.handle);
  if (!prod) { problems.push(`${row.handle}: product not found in Shopify`); continue; }
  const v = prod.variants.find((x) => norm(x.option1 || x.title) === norm(row.format));
  if (!v) { problems.push(`${row.handle}: no variant "${row.format}"`); continue; }
  if ((v.sku || '').trim()) {
    problems.push(`${row.handle} / ${row.format}: already has SKU "${v.sku}" — skipped`);
    continue;
  }
  actions.push({ ...row, variantId: v.id, productId: prod.id, before: v.sku || '' });
}

console.log(`\nTo write .............. ${actions.length}`);
console.log(`Skipped / problems .... ${problems.length}`);
if (problems.length) problems.slice(0, 25).forEach((p) => console.log(`   • ${p}`));

// ── 5. Snapshot, then write ────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapFile = `../_work/muse-sku-snapshot-${stamp}.json`;
writeFileSync(snapFile, JSON.stringify(actions.map((a) => ({
  handle: a.handle, format: a.format, variantId: a.variantId, skuBefore: a.before, skuAfter: a.sku,
})), null, 2), 'utf8');
console.log(`\nSnapshot .............. ${snapFile}`);

if (!COMMIT) {
  console.log('\n── DRY RUN — nothing was written. Sample of the first 10: ──');
  actions.slice(0, 10).forEach((a) => console.log(`   ${a.fragrance} / ${a.format}  →  ${a.sku}`));
  console.log(`\nRe-run with:  MUSE_ALLOW_WRITE=yes node scripts/muse-assign-skus.mjs --commit`);
  process.exit(0);
}

let ok = 0, failed = 0;
for (const [i, a] of actions.entries()) {
  const res = await shopify(`/variants/${a.variantId}.json`, {
    method: 'PUT',
    // ONLY the sku field — everything else on the variant stays as marketing left it.
    body: JSON.stringify({ variant: { id: a.variantId, sku: a.sku } }),
  });
  if (res.ok) { ok++; }
  else { failed++; console.error(`   ✗ ${a.fragrance} / ${a.format}: ${res.status} ${(await res.text()).slice(0, 160)}`); }
  if ((i + 1) % 25 === 0) console.log(`   … ${i + 1}/${actions.length}`);
  await new Promise((r) => setTimeout(r, 550)); // stay under 2 req/s
}
console.log(`\n${failed === 0 ? '✅' : '⚠️'} written=${ok}  failed=${failed}`);
console.log(`Rollback: every variant in ${snapFile} had an empty SKU — clear them to revert.`);
process.exit(failed === 0 ? 0 : 1);
