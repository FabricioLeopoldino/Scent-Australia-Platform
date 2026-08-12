// The Aere 50ml refill: a FOURTH format for every fragrance already live on the
// store (Ed, 2026-08-12 — "Option A, we will add it as a fourth option to the
// existing/live fragrances").
//
// It is 100% fragrance oil, no alcohol (Emma, 2026-08-12) — so the master
// carries is_pure_oil, and `buildLineComponents` then charges the whole 50ml as
// oil instead of 25% of it. That flag has existed since D14 and has never been
// used; this is its first master.
//
// NO PACKAGING on this first run. Stefan asked for 250 units airfreighted
// without individual boxes to land faster; later runs will include them (Emma,
// 2026-08-12). So the recipe deliberately has no box and no box label. When the
// packaging arrives it is one more BOM row — orders already placed keep the
// recipe they were created with, because components are snapshotted per order.
//
// The BOM is left EMPTY on purpose: the 50ml vessel does not exist as a
// component yet (the 250 are still in the air) and the compliance-label question
// is unanswered. The master must not be sold before its recipe is built — an
// order against an empty BOM would consume the oil and nothing else.
//
// The number is NOT new. Muse_RF00038 belongs to the same fragrance as
// Muse_TS00038 — one number, one fragrance, four formats. Both SKU generators
// count globally so they cannot drift.
//
// Dry run by default. Pass --commit to apply.
//   node scripts/add-muse-refill-format.mjs
//   node scripts/add-muse-refill-format.mjs --commit [--csv]
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
const CSV = process.argv.includes('--csv');
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});
const DOMAIN = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;

const MASTER = { code: 'RF50', name: 'Library Refill 50ml', volume: 50, prefix: 'RF' };

// The list comes from the STORE, not from us: "each fragrance in The Library"
// means the fragrances a customer can buy today, which is what Ed is looking at.
async function activeFragrances() {
  const out = [];
  let cursor = null;
  for (;;) {
    const r = await fetch(`https://${DOMAIN}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ products(first:250${cursor ? `, after:"${cursor}"` : ''}, query:"status:active") {
        pageInfo{hasNextPage endCursor} nodes { title variants(first:10){nodes{sku}} } } }` }),
    }).then((x) => x.json());
    if (r.errors) throw new Error(JSON.stringify(r.errors));
    for (const p of r.data.products.nodes) {
      const nums = [...new Set(p.variants.nodes
        .map((v) => (v.sku || '').match(/Muse_(?:TS|RS|RD)([0-9]+)/)?.[1]).filter(Boolean))];
      // A product whose variants disagree about the number is the wrong-code
      // defect of 2026-08-11. Skip it loudly rather than guess which is right.
      if (nums.length === 1) out.push({ storeTitle: p.title, num: nums[0] });
      else if (nums.length > 1) console.warn(`   ⚠️  skipped "${p.title}" — variants carry ${nums.length} different numbers: ${nums.join(', ')}`);
    }
    if (!r.data.products.pageInfo.hasNextPage) break;
    cursor = r.data.products.pageInfo.endCursor;
  }
  return out;
}

try {
  if (!DOMAIN || !TOKEN) throw new Error('Muse store credentials required');
  const store = await activeFragrances();
  console.log(`\nActive fragrances on the store: ${store.length}`);

  const master = (await pool.query(
    `SELECT id, product_code, is_pure_oil, volume_ml FROM products WHERE product_code = $1 AND is_master = true`,
    [MASTER.code])).rows[0];

  // Every number must already resolve to exactly one fragrance here.
  const plat = new Map((await pool.query(
    `SELECT substring(sku from '[0-9]+$') num,
            max(oil_id) oil, count(DISTINCT oil_id) oils, count(*) formats,
            max(regexp_replace(name, '^.*— ', '')) fragrance
       FROM products
      WHERE sku LIKE 'Muse@_%' ESCAPE '@' AND COALESCE(archived,false) = false
      GROUP BY 1`)).rows.map((r) => [r.num, r]));

  const problems = [];
  const plan = [];
  for (const s of store) {
    const row = plat.get(s.num);
    if (!row) { problems.push(`${s.storeTitle} (${s.num}) — no such number here`); continue; }
    if (Number(row.oils) > 1) { problems.push(`${s.storeTitle} (${s.num}) — resolves to ${row.oils} different oils`); continue; }
    const sku = `Muse_${MASTER.prefix}${s.num}`;
    plan.push({ num: s.num, storeTitle: s.storeTitle, fragrance: row.fragrance, oil: row.oil, sku,
                code: `${MASTER.code}-M${s.num}`, name: `${MASTER.name} — ${row.fragrance}` });
  }
  if (problems.length) {
    console.error(`\n❌ REFUSING — ${problems.length} fragrance(s) cannot be resolved safely:`);
    problems.forEach((p) => console.error(`   ${p}`));
    process.exit(1);
  }

  const taken = (await pool.query(
    `SELECT sku FROM products WHERE sku = ANY($1::text[])`, [plan.map((p) => p.sku)])).rows;
  if (taken.length) {
    console.error(`\n❌ REFUSING — ${taken.length} refill SKU(s) already exist: ${taken.map((r) => r.sku).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n── MASTER ${master ? '(already exists)' : 'TO CREATE'}`);
  console.log(`   ${MASTER.code}  ${MASTER.name}  ${MASTER.volume}ml  100% oil (is_pure_oil)  BOM: empty for now`);

  console.log(`\n── REFILL VARIANTS TO CREATE: ${plan.length}`);
  plan.slice(0, 8).forEach((p) => console.log(`   ${p.sku}  ${p.name}   (oil ${p.oil})`));
  if (plan.length > 8) console.log(`   … and ${plan.length - 8} more`);

  if (CSV) {
    console.log('\n── LIST FOR THE STORE TEAM (csv)');
    console.log('Product,Option value,SKU,Barcode');
    plan.forEach((p) => console.log(`"${p.storeTitle}","Refill 50ml",${p.sku},${p.sku}`));
  }

  if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit (add --csv for the list).'); process.exit(0); }

  console.log('\nApplying…');
  const masterId = master ? master.id : (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, current_stock, segment,
                           is_master, volume_ml, default_oil_pct, is_pure_oil)
     VALUES ($1,$2,'FINISHED_GOOD','units',0,'MUSE',true,$3,100,true) RETURNING id`,
    [MASTER.name, MASTER.code, MASTER.volume])).rows[0].id;
  console.log(`   master ${MASTER.code}: ${master ? 'reused' : 'created'} (id ${masterId})`);

  let n = 0;
  for (const p of plan) {
    // barcode = sku, same rule as the other three formats.
    await pool.query(
      `INSERT INTO products (name, product_code, sku, barcode, category, unit, current_stock,
                             segment, master_product_id, oil_id, fragrance_id, volume_ml,
                             default_oil_pct, is_pure_oil)
       VALUES ($1,$2,$3,$3,'FINISHED_GOOD','units',0,'MUSE',$4,$5,NULL,$6,100,true)`,
      [p.name, p.code, p.sku, masterId, p.oil, MASTER.volume]);
    n++;
  }
  console.log(`   refill variants created: ${n}`);

  const check = (await pool.query(
    `SELECT count(*) n, count(DISTINCT oil_id) oils, min(sku) first, max(sku) last
       FROM products WHERE master_product_id = $1`, [masterId])).rows[0];
  console.log(`\nVerifying… ${check.n} variants, ${check.oils} distinct oils, ${check.first} … ${check.last}`);
  console.log('\n✅ done — run integrity-sm.cjs, then send the list with --csv.');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
