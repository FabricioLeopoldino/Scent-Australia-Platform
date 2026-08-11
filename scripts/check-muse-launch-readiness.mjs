// Read-only pre-launch check for the MUSE retail store.
//
// WHY (2026-08-07, the last business day before the 10 Aug launch): the only
// join between the Muse Shopify store and the platform is the SKU
// (`smFulfillmentHandler`: `if (!sku) continue`). A variant that is sellable on
// the store but unknown here ships and moves no stock — silently until the
// alarm added on 6 Aug fires, and by then the goods have left the building.
//
// Answers four questions, writes nothing:
//   1. which sellable variants have no SKU at all
//   2. which sellable SKUs the platform does not know
//   3. which known SKUs have no oil linked (a sale would consume nothing)
//   4. what the platform's opening stock looks like
//
// Run: node scripts/check-muse-launch-readiness.mjs
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const DOMAIN = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;
if (!DOMAIN || !TOKEN) { console.error('MUSE_SHOPIFY_SHOP_DOMAIN / _ACCESS_TOKEN missing.'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

const QUERY = `query($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      title status
      variants(first: 30) { nodes { title sku } }
    }
  }
}`;

async function shopifyVariants() {
  const out = [];
  let cursor = null, more = true;
  while (more) {
    const r = await fetch(`https://${DOMAIN}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { cursor } }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    for (const p of j.data.products.nodes) {
      for (const v of p.variants.nodes) {
        out.push({ product: p.title, status: p.status, variant: v.title, sku: (v.sku || '').trim() });
      }
    }
    cursor = j.data.products.pageInfo.endCursor;
    more = j.data.products.pageInfo.hasNextPage;
    await new Promise((r) => setTimeout(r, 600)); // 2 req/s limit
  }
  return out;
}

const line = (s) => console.log(s);
const head = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

try {
  const variants = await shopifyVariants();
  const active = variants.filter((v) => v.status === 'ACTIVE');
  line(`Shopify: ${variants.length} variants, ${active.length} on ACTIVE products (sellable)`);

  // ── 1. sellable, no SKU ───────────────────────────────────────────────────
  head('1. SELLABLE VARIANTS WITH NO SKU  (a sale here moves no stock)');
  const noSku = active.filter((v) => !v.sku);
  line(`   ${noSku.length} found`);
  for (const v of noSku) line(`   · ${v.product}  /  ${v.variant}`);

  // ── 2. sellable SKU the platform does not know ────────────────────────────
  const skus = [...new Set(active.map((v) => v.sku).filter(Boolean))];
  const known = await pool.query(
    `SELECT p.sku, p.name, p.current_stock, p.oil_id, p.is_master,
            oil."productCode" AS oil_code, oil.name AS oil_name
       FROM products p
       LEFT JOIN sa.products oil ON oil.id = p.oil_id
      WHERE p.sku = ANY($1::text[])`, [skus]);
  const byS = new Map(known.rows.map((r) => [r.sku, r]));

  head('2. SELLABLE SKUs THE PLATFORM DOES NOT KNOW  (ships, deducts nothing)');
  const orphan = skus.filter((s) => !byS.has(s));
  line(`   ${orphan.length} of ${skus.length} sellable SKUs`);
  for (const s of orphan.slice(0, 25)) {
    const v = active.find((x) => x.sku === s);
    line(`   · ${s.padEnd(24)} ${v.product} / ${v.variant}`);
  }

  // ── 3. known, but no oil linked ───────────────────────────────────────────
  head('3. KNOWN SKUs WITH NO OIL LINKED  (make-to-order consumes nothing)');
  const noOil = known.rows.filter((r) => !r.oil_id);
  line(`   ${noOil.length} of ${known.rows.length}`);
  for (const r of noOil.slice(0, 25)) line(`   · ${r.sku.padEnd(24)} ${r.name}`);

  // ── 4. opening stock ──────────────────────────────────────────────────────
  head('4. OPENING STOCK ON THE PLATFORM');
  const neg = known.rows.filter((r) => Number(r.current_stock) < 0);
  const zero = known.rows.filter((r) => Number(r.current_stock) === 0);
  const pos = known.rows.filter((r) => Number(r.current_stock) > 0);
  line(`   negative : ${neg.length}   ← must be 0`);
  line(`   zero     : ${zero.length}   ← normal for make-to-order`);
  line(`   positive : ${pos.length}   ← ships from the shelf, no production`);
  for (const r of neg) line(`   NEGATIVE  ${r.sku.padEnd(24)} ${r.current_stock}  ${r.name}`);

  // ── 5. the SKU must agree with the format it is sold as ───────────────────
  // Added 2026-08-11 after this found TEN wrong SKUs on live, sellable products
  // in one pass. Checks 2 and 3 could not see them: the SKU is real, the
  // platform knows it, and it has an oil — it is simply the WRONG FORMAT.
  // "Green Tea / Room Spray" carried Muse_RD00054, so a $39 room spray order
  // made a 200 ml reed diffuser: twice the oil, the wrong vessel, and reeds the
  // room spray never has. EO Blend had its room spray AND its reed diffuser
  // both pointing at the 10 ml travel spray.
  //
  // This is the only check here that needs no other system to agree with it —
  // Muse_RD##### on a variant sold as "Room Spray" is wrong on its face. That
  // makes it the one to trust when a name-based comparison would be arguable
  // (one oil legitimately sells under several commercial names).
  head('5. SKU PREFIX vs THE FORMAT IT IS SOLD AS  (produces the wrong product)');
  const EXPECT = { 'Travel Spray': 'TS', 'Room Spray': 'RS', 'Reed Diffuser': 'RD' };
  const mismatched = active.filter((v) => {
    const want = EXPECT[v.variant];
    if (!want || !v.sku) return false;
    const got = (v.sku.match(/Muse_(TS|RS|RD)/) || [])[1];
    return got && got !== want;
  });
  line(`   ${mismatched.length} found`);
  for (const v of mismatched) {
    line(`   · ${v.product} / ${v.variant.padEnd(14)} ${v.sku}  → should be Muse_${EXPECT[v.variant]}#####`);
  }
  const unnamed = active.filter((v) => v.sku && !EXPECT[v.variant]);
  if (unnamed.length) {
    line(`   (${unnamed.length} sellable variant(s) whose name is not one of the three formats — not checkable by prefix)`);
    for (const v of unnamed.slice(0, 10)) line(`     ${v.product} / ${v.variant}  ${v.sku}`);
  }

  // ── 6. one SKU, one sellable variant ──────────────────────────────────────
  // The order matcher does `WHERE sku = $1` and takes what comes back. Two
  // sellable variants on one SKU means the store can sell something the
  // platform will resolve to the other one.
  head('6. THE SAME SKU ON TWO SELLABLE VARIANTS  (the matcher picks one)');
  const seen = new Map();
  for (const v of active.filter((x) => x.sku)) seen.set(v.sku, [...(seen.get(v.sku) || []), v]);
  const shared = [...seen.entries()].filter(([, vs]) => vs.length > 1);
  line(`   ${shared.length} found`);
  for (const [sku, vs] of shared.slice(0, 25)) {
    line(`   · ${sku}`);
    for (const v of vs) line(`       ${v.product} / ${v.variant}`);
  }

  head('VERDICT');
  const blocking = noSku.length + orphan.length + noOil.length + neg.length
    + mismatched.length + shared.length;
  line(blocking === 0
    ? '   ✅ nothing blocking — every sellable variant maps to one product, of the right format, with an oil'
    : `   ⚠️  ${blocking} item(s) need a decision`);
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
