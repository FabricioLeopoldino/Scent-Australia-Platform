// Brings the SA store's main fragrance products to the owner's pattern
// (HYPER_UPDATE_BACKLOG.md P7; audit of 2 Nov 2026). DRY RUN by default: it
// reads the store and prints what it WOULD change. `--apply` writes.
//
//   node scripts/shopify-fix-main-products.mjs            # dry run, writes nothing
//   node scripts/shopify-fix-main-products.mjs --apply    # changes the live SA store
//
// Only products of type "Scent Australia (SA Warehouse)". On each, and only
// where it differs:
//   channels     — Point of Sale only (off every other channel, on POS)
//   description  — only when EMPTY: "Supplier: X / Supplier code: Y", read from
//                  the product's own tag ("X - Scent Australia") and title "(Y)"
//   variants     — the standard price (owner, 2 Nov: 150/150/200/300/300 —
//                  "simbólico", the real price is in Xero), charge tax on,
//                  inventory tracked, the weight of the size
// Never touched: cost per item (being filled in by hand), title, SKUs, status,
// tags, type. Shopify is told nothing else.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { OIL_PATTERN, OIL_SIZES } from '../shared/shopify-product-pattern.js';
const req = createRequire(import.meta.url);
req('dotenv').config();

const APPLY = process.argv.includes('--apply');
const shop = process.env.SA_SHOPIFY_SHOP_DOMAIN || process.env.SA_SHOPIFY_STORE_NAME;
const host = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
async function gql(query, variables) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${host}/admin/api/2026-04/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': process.env.SA_SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60000),
    });
    const body = await res.json().catch(() => null);
    const throttled = res.status === 429 || body?.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 8) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!body || body.errors) throw new Error(`Shopify: ${JSON.stringify(body?.errors || res.status)}`);
    return body.data;
  }
}
const sizeOf = (sku) => Object.keys(OIL_SIZES).find((k) => new RegExp(`^${k}_\\d+$`).test(sku || ''));
const grams = (w) => (!w ? null : w.unit === 'KILOGRAMS' ? w.value * 1000 : w.unit === 'GRAMS' ? w.value : null);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pubs = (await gql(`{ publications(first: 25) { nodes { id name } } }`)).publications.nodes;
const pos = pubs.find((p) => p.name === OIL_PATTERN.publication);
if (!pos) throw new Error('No Point of Sale channel in the store');

const mains = [];
let after = null;
do {
  const d = await gql(`query($after: String, $q: String!) { products(first: 50, after: $after, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes { id title status tags descriptionHtml
      resourcePublications(first: 25) { nodes { isPublished publication { id name } } }
      variants(first: 20) { nodes { id sku price taxable inventoryItem { tracked measurement { weight { value unit } } } } } } } }`,
  { after, q: `product_type:'${OIL_PATTERN.productType}'` });
  mains.push(...d.products.nodes.filter((p) => p.status !== 'ARCHIVED'));
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

const plan = [];
for (const p of mains) {
  const off = p.resourcePublications.nodes.filter((n) => n.isPublished && n.publication.name !== OIL_PATTERN.publication).map((n) => n.publication);
  const onPos = p.resourcePublications.nodes.some((n) => n.isPublished && n.publication.name === OIL_PATTERN.publication);
  const supplier = (p.tags.find((t) => / - Scent Australia$/i.test(t)) || '').replace(/\s*-\s*Scent Australia$/i, '').trim();
  // The first "(CODE)" in the title — "Santal 33 A Fragrance (FIA211503) | Santal 66 (Black)".
  const code = (p.title.match(/\(([A-Za-z]{2,4}[ -]?\d{3,}[A-Za-z0-9/-]*)\)/) || [])[1] || '';
  const desc = !String(p.descriptionHtml || '').replace(/<[^>]+>/g, '').trim() && (supplier || code)
    ? [supplier && `<p>Supplier: ${esc(supplier)}</p>`, code && `<p>Supplier code: ${esc(code.toUpperCase())}</p>`].filter(Boolean).join('') : null;
  const variants = [];
  for (const v of p.variants.nodes) {
    const k = sizeOf(v.sku); if (!k) continue;
    const want = { price: OIL_SIZES[k].price, g: OIL_SIZES[k].weightG };
    const ch = {};
    if (Number(v.price) !== want.price) ch.price = [Number(v.price), want.price];
    if (!v.taxable) ch.taxable = [false, true];
    if (!v.inventoryItem?.tracked) ch.tracked = [false, true];
    if (grams(v.inventoryItem?.measurement?.weight) !== want.g) ch.weight = [grams(v.inventoryItem?.measurement?.weight), want.g];
    if (Object.keys(ch).length) variants.push({ id: v.id, sku: v.sku, k, ch });
  }
  if (off.length || !onPos || desc || variants.length) plan.push({ id: p.id, title: p.title, off, onPos, desc, variants });
}

// ── What would change.
const n = (f) => plan.reduce((s, x) => s + f(x), 0);
const vn = (key) => n((x) => x.variants.filter((v) => key in v.ch).length);
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${mains.length} main products, ${plan.length} need a change`);
console.log(`  channels: ${plan.filter((x) => x.off.length).length} come off ${[...new Set(plan.flatMap((x) => x.off.map((o) => o.name)))].join(' + ') || '—'}; ${plan.filter((x) => !x.onPos).length} go on Point of Sale`);
console.log(`  description filled (was empty): ${plan.filter((x) => x.desc).length}`);
console.log(`  variants: price ${vn('price')}, charge tax on ${vn('taxable')}, tracked ${vn('tracked')}, weight ${vn('weight')}`);
writeFileSync('shopify-fix-plan.json', JSON.stringify(plan, null, 1));
console.log('  full plan: shopify-fix-plan.json');
for (const x of plan.slice(0, 3)) {
  console.log(`\n  e.g. ${x.title}`);
  if (x.off.length) console.log(`    channels: off ${x.off.map((o) => o.name).join(', ')} → Point of Sale only`);
  if (x.desc) console.log(`    description: "${x.desc.replace(/<\/p><p>/g, ' / ').replace(/<\/?p>/g, '')}"`);
  for (const v of x.variants) console.log(`    ${v.sku}: ${Object.entries(v.ch).map(([k, [a, b]]) => `${k} ${a}→${b}`).join(', ')}`);
}
if (!APPLY) { console.log('\nNothing written. Run with --apply to make these changes in the live store.'); process.exit(0); }

// ── Apply, product by product; a failure is reported and the run goes on.
let ok = 0; const failed = [];
for (const x of plan) {
  try {
    // Point of Sale FIRST, the other channels off only after it worked. The other
    // order left a product on NO channel whenever the publish failed — for
    // example while the app still lacks write_publications (code review, 5 Nov).
    if (!x.onPos) {
      const r = await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`, { id: x.id, input: [{ publicationId: pos.id }] });
      if (r.publishablePublish.userErrors.length) throw new Error(r.publishablePublish.userErrors.map((e) => e.message).join('; '));
    }
    for (const o of x.off) {
      const r = await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishableUnpublish(id: $id, input: $input) { userErrors { message } } }`, { id: x.id, input: [{ publicationId: o.id }] });
      if (r.publishableUnpublish.userErrors.length) throw new Error(r.publishableUnpublish.userErrors.map((e) => e.message).join('; '));
    }
    if (x.desc) {
      const r = await gql(`mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`, { product: { id: x.id, descriptionHtml: x.desc } });
      if (r.productUpdate.userErrors.length) throw new Error(r.productUpdate.userErrors.map((e) => e.message).join('; '));
    }
    if (x.variants.length) {
      const variants = x.variants.map((v) => ({
        id: v.id,
        ...('price' in v.ch && { price: v.ch.price[1].toFixed(2) }),
        ...('taxable' in v.ch && { taxable: true }),
        ...(('tracked' in v.ch || 'weight' in v.ch) && { inventoryItem: {
          ...('tracked' in v.ch && { tracked: true }),
          ...('weight' in v.ch && { measurement: { weight: { value: v.ch.weight[1], unit: 'GRAMS' } } }) } }),
      }));
      const r = await gql(`mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } } }`, { productId: x.id, variants });
      if (r.productVariantsBulkUpdate.userErrors.length) throw new Error(r.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; '));
    }
    ok++;
  } catch (e) { failed.push({ title: x.title, error: e.message }); }
}
console.log(`\nApplied: ${ok} of ${plan.length}. Failed: ${failed.length}`);
for (const f of failed) console.log(`  ${f.title}: ${f.error}`);
