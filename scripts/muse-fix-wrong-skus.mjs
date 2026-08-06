// Re-point 4 LIVE Muse variants at the SKU of the correct internal record.
//
// WHY (2026-08-07, owner approved): yesterday's muse-assign-skus.mjs matched
// Shopify titles to platform records BY NAME. Two legacy junk records had names
// that matched more closely than the real ones, so four sellable variants ended
// up carrying the SKU of a record with NO oil linked:
//
//   "Oasis" / Reed Diffuser            → Muse_RD00079 "Oasis and Allure - alternate"
//   "Sandalwood & Hint of Jasmine" ×3  → Muse_..00098 "Sandalwood Gif & Jasmine"
//
// Both junk records were created 2026-07-09 by bad data entry, have zero stock,
// zero movements and zero audit rows (verified). A sale on any of the four would
// deduct nothing from the Fragrance Library and drive finished stock negative.
//
// The targets already exist and are already linked to the oils the owner's map
// specifies (FRAG_0041 Cologne, FRAG_0145 Sandalwood & Hint of Jasmin). This
// only makes Shopify agree with that map.
//
// Writes ONE field (inventoryItem.sku) on 4 variants. Nothing else is sent, so
// title, price, images and description are untouched.
//
// Run: node scripts/muse-fix-wrong-skus.mjs          (dry run — shows the plan)
//      node scripts/muse-fix-wrong-skus.mjs --apply  (writes)
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const DOMAIN = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;
if (!DOMAIN || !TOKEN) { console.error('MUSE_SHOPIFY_SHOP_DOMAIN / _ACCESS_TOKEN missing.'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

// product title → [current sku, corrected sku]. The product title is part of the
// guard: a variant is only touched when BOTH the product and the SKU match.
const PLAN = [
  { product: 'Oasis',                        from: 'Muse_RD00079', to: 'Muse_RD00078' },
  { product: 'Sandalwood & Hint of Jasmine', from: 'Muse_TS00098', to: 'Muse_TS00097' },
  { product: 'Sandalwood & Hint of Jasmine', from: 'Muse_RS00098', to: 'Muse_RS00097' },
  { product: 'Sandalwood & Hint of Jasmine', from: 'Muse_RD00098', to: 'Muse_RD00097' },
];

const gql = async (query, variables = {}) => {
  const r = await fetch(`https://${DOMAIN}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  await new Promise((s) => setTimeout(s, 600)); // 2 req/s
  return j.data;
};

const LIST = `query($cursor:String){ products(first:100, after:$cursor){
  pageInfo{hasNextPage endCursor}
  nodes{ id title status variants(first:30){ nodes{ id title sku } } } } }`;

async function allProducts() {
  const out = []; let cursor = null, more = true;
  while (more) {
    const d = await gql(LIST, { cursor });
    out.push(...d.products.nodes);
    cursor = d.products.pageInfo.endCursor;
    more = d.products.pageInfo.hasNextPage;
  }
  return out;
}

const products = await allProducts();
const activeVariants = products
  .filter((p) => p.status === 'ACTIVE')
  .flatMap((p) => p.variants.nodes.map((v) => ({ ...v, product: p.title, productId: p.id })));

// ── Resolve and guard ──────────────────────────────────────────────────────
const jobs = [];
let blocked = 0;
for (const step of PLAN) {
  const matches = activeVariants.filter((v) => v.product === step.product && (v.sku || '').trim() === step.from);
  if (matches.length !== 1) {
    console.error(`BLOCKED  ${step.from} → ${step.to}: expected exactly 1 ACTIVE variant on "${step.product}", found ${matches.length}`);
    blocked++; continue;
  }
  // The corrected SKU must not already be live on a DIFFERENT active variant —
  // two sellable variants sharing one SKU makes the fulfilment join ambiguous.
  const clash = activeVariants.filter((v) => (v.sku || '').trim() === step.to && v.id !== matches[0].id);
  if (clash.length) {
    console.error(`BLOCKED  ${step.to} is already live on: ${clash.map((c) => `${c.product}/${c.title}`).join(', ')}`);
    blocked++; continue;
  }
  jobs.push({ ...step, variantId: matches[0].id, productId: matches[0].productId, variantTitle: matches[0].title });
}

console.log(`\nPlan (${jobs.length} of ${PLAN.length} resolved, ${blocked} blocked):`);
for (const j of jobs) console.log(`  "${j.product}" / ${j.variantTitle.padEnd(15)} ${j.from} → ${j.to}`);

if (blocked) { console.error('\n❌ Refusing to write — resolve the blocked rows first.'); process.exit(1); }

// ── Snapshot BEFORE ────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('../_work', { recursive: true });
const snapPath = `../_work/muse-sku-fix-${stamp}.json`;
writeFileSync(snapPath, JSON.stringify({ takenAt: new Date().toISOString(), jobs }, null, 2));
console.log(`\nSnapshot written: ${snapPath}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

// ── Apply ──────────────────────────────────────────────────────────────────
const MUT = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message }
  }
}`;

console.log('\nApplying…');
let failed = 0;
for (const j of jobs) {
  const d = await gql(MUT, {
    productId: j.productId,
    variants: [{ id: j.variantId, inventoryItem: { sku: j.to } }],
  });
  const errs = d.productVariantsBulkUpdate.userErrors;
  if (errs.length) { console.error(`  FAIL  ${j.from} → ${j.to}: ${JSON.stringify(errs)}`); failed++; continue; }
  const got = d.productVariantsBulkUpdate.productVariants[0]?.sku;
  console.log(got === j.to ? `  ok    ${j.from} → ${got}` : `  FAIL  expected ${j.to}, store returned ${got}`);
  if (got !== j.to) failed++;
}

// ── Verify by re-reading the store ─────────────────────────────────────────
console.log('\nRe-reading the store to verify…');
const after = (await allProducts())
  .filter((p) => p.status === 'ACTIVE')
  .flatMap((p) => p.variants.nodes.map((v) => ({ ...v, product: p.title })));
for (const j of jobs) {
  const now = after.find((v) => v.id === j.variantId);
  const ok = (now?.sku || '').trim() === j.to;
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} "${j.product}" / ${j.variantTitle} = ${now?.sku}`);
  if (!ok) failed++;
  const stillOld = after.filter((v) => (v.sku || '').trim() === j.from);
  if (stillOld.length) console.log(`         (note: ${j.from} still on ${stillOld.length} other ACTIVE variant(s))`);
}

console.log(failed === 0 ? '\n✅ all 4 corrected and verified in the store' : `\n❌ ${failed} problem(s)`);
process.exitCode = failed === 0 ? 0 : 1;
