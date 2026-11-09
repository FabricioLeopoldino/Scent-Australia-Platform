// P7 (owner, 30 Oct 2026): an oil goes to the SA Shopify store as ONE main
// product, "Name (SUPPLIER CODE)", with its five sizes as variants — the
// pattern of the owner's test product 9664987103321, Jardin De Carthage.
// OFFLINE — Shopify is a stub and no database is opened, so it runs anywhere.
//
// Pins what is sent (shared/shopify-product-pattern.js) against the test
// product's own figures, and what server/sa/shopify-products.js does with each
// Shopify answer: a second main product refused, Point of Sale only, the
// missing sizes added as variants of the main product, never as products.
//
// Run: node scripts/regression-shopify-product-pattern.js
import { oilProductInput, oilVariantBulkInput, variantCost, oilWarnings, OIL_PATTERN } from '../shared/shopify-product-pattern.js';
import { publishOil, addMissingOilSizes } from '../server/sa/shopify-products.js';
import { readShopifyImage } from '../server/sa/shopify-image.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const KEYS = ['SA_CA', 'SA_HF', 'SA_CDIFF', 'SA_1L', 'SA_PRO'];
const oil = {
  id: 'OIL_78', name: 'Jardin de Carthage', supplier: 'Luxaroma', supplier_code: 'Lux0639',
  shopifySkus: Object.fromEntries(KEYS.map((k) => [k, `${k}_00078`])),
};

console.log('\n1. What is sent, against the test product');
const input = oilProductInput(oil, { costPerLitre: 42.40 });
check(input.title === 'Jardin de Carthage (LUX0639)', 'title: the name and the supplier code in capitals', input.title);
check(input.productType === 'Scent Australia (SA Warehouse)' && input.vendor === 'Scent Australia', 'type and vendor');
check(JSON.stringify(input.tags) === '["Luxaroma - Scent Australia"]', 'tag: supplier - company', JSON.stringify(input.tags));
check(input.category === 'gid://shopify/TaxonomyCategory/hb-3-2-8-8' && input.status === 'ACTIVE', 'category Perfume Oils, active');
check(input.descriptionHtml === '<p>Supplier: Luxaroma</p><p>Supplier code: LUX0639</p>', 'description: supplier and supplier code', input.descriptionHtml);
check(input.productOptions[0].name === 'Scent Australia' && input.productOptions[0].values.length === 5, 'one option, "Scent Australia", five values');
check(input.variants.map((v) => v.sku).join() === KEYS.map((k) => `${k}_00078`).join(), 'the five SKUs unchanged, in order');
check(input.variants.map((v) => v.price).join() === '150.00,150.00,200.00,300.00,300.00', 'the standard prices (owner, 30 Oct)', input.variants.map((v) => v.price).join());
check(input.variants.map((v) => v.inventoryItem.cost).join() === '16.96,21.20,29.68,42.40,42.40', 'cost per item from $42.40/L = the test product\'s own figures', input.variants.map((v) => v.inventoryItem.cost).join());
check(input.variants.map((v) => v.inventoryItem.measurement.weight.value).join() === '600,500,700,1000,1000', 'weights, the cartridge with its cartridge (600 g)');
check(input.variants.every((v) => v.taxable && v.inventoryItem.tracked && v.inventoryItem.requiresShipping && v.inventoryPolicy === 'CONTINUE'),
  'charge tax on, tracked, physical, sold when Shopify shows 0');
check(input.variants[0].optionValues[0].name === 'Jardin de Carthage Oil Cartridge (400ml)', 'variant title: the name and the size, as the store names them');
const typed = oilProductInput(oil, { costPerLitre: 42.40, prices: { SA_1L: '310' } });
check(typed.variants[3].price === '310.00' && typed.variants[0].price === '150.00', 'a typed price is sent as typed, the others stay standard');
const noCost = oilProductInput(oil, {});
check(noCost.variants.every((v) => !('cost' in v.inventoryItem)), 'no cost per litre: no cost per item, never $0');
check(variantCost(0, 400) === null && variantCost(-1, 400) === null, '0 or negative is no cost');
check(oilWarnings({ name: 'X' }, null).length === 3, 'no supplier, no code, no cost: three warnings');
const bare = oilProductInput({ name: 'X', shopifySkus: { SA_1L: 'SA_1L_00999' } }, {});
check(bare.title === 'X' && bare.tags.length === 0 && bare.variants.length === 1, 'an oil with one size and no supplier: what it has, nothing invented');
const bulk = oilVariantBulkInput(oil, 'SA_HF', 'SA_HF_00078', { costPerLitre: 42.40 });
check(bulk.inventoryItem.sku === 'SA_HF_00078' && !('sku' in bulk) && bulk.inventoryItem.cost === '21.20', 'an added size carries its SKU on the inventory item');

// ── The Shopify conversation, stubbed.
process.env.SA_SHOPIFY_SHOP_DOMAIN = 'stub';
process.env.SA_SHOPIFY_ACCESS_TOKEN = 'stub';
const realFetch = globalThis.fetch;
let calls = [];
let script = {};
globalThis.fetch = async (url, opts) => {
  const { query, variables } = JSON.parse(opts.body);
  calls.push({ query, variables });
  const name = /productVariants\(first/.test(query) ? 'variants' : /productSet/.test(query) ? 'set'
    : /publications\(first/.test(query) ? 'pubs' : /publishablePublish/.test(query) ? 'publish' : /productVariantsBulkCreate/.test(query) ? 'bulk' : '?';
  const answer = script[name]?.(variables);
  return { ok: true, status: 200, json: async () => answer };
};
const v = (sku, product) => ({ sku, product });
const oldListing = (k) => ({ id: `gid://shopify/Product/old-${k}`, title: `Jardin de Carthage ${k}`, productType: '', status: 'ACTIVE' });
const main = { id: 'gid://shopify/Product/main', title: 'Jardin de Carthage (LUX0639)', productType: OIL_PATTERN.productType, status: 'ACTIVE' };

try {
  console.log('\n2. Publish');
  calls = [];
  script = {
    variants: () => ({ data: { productVariants: { nodes: KEYS.map((k) => v(`${k}_00078`, oldListing(k))) } } }),
    set: () => ({ data: { productSet: { product: { id: 'gid://shopify/Product/new', title: 'Jardin de Carthage (LUX0639)', variants: { nodes: KEYS.map((k) => ({ sku: `${k}_00078` })) } }, userErrors: [] } } }),
    pubs: () => ({ data: { publications: { nodes: [{ id: 'gid://shopify/Publication/online', name: 'Online Store' }, { id: 'gid://shopify/Publication/pos', name: 'Point of Sale' }] } } }),
    publish: () => ({ data: { publishablePublish: { userErrors: [] } } }),
  };
  let out = await publishOil(oil, { costPerLitre: 42.40 });
  const sent = calls.find((c) => /productSet/.test(c.query))?.variables.input;
  check(JSON.stringify(sent) === JSON.stringify(input), 'productSet receives exactly the pattern input');
  const pub = calls.find((c) => /publishablePublish/.test(c.query))?.variables;
  check(pub?.id === 'gid://shopify/Product/new' && JSON.stringify(pub.input) === '[{"publicationId":"gid://shopify/Publication/pos"}]', 'published on Point of Sale, and on nothing else');
  check(out.posPublished === true && out.skus.length === 5, 'the answer: created, five sizes, on Point of Sale');
  check(out.oldListings.length === 5, 'the old one-per-size listings are named, to archive');

  script.publish = () => ({ errors: [{ message: 'Access denied for publishablePublish field. Required access: `write_publications` access scope.' }] });
  out = await publishOil({ ...oil, id: 'OIL_79' }, { costPerLitre: 42.40 });
  check(out.posPublished === false && /write_publications/.test(out.posError), 'without the channel permission: created, and the answer says to turn Point of Sale on', out.posError);

  script.variants = () => ({ data: { productVariants: { nodes: [v('SA_CA_00078', main)] } } });
  calls = [];
  let err = await publishOil({ ...oil, id: 'OIL_80' }, { costPerLitre: 42.40 }).catch((e) => e);
  check(err?.status === 409 && /already has its main product/.test(err.message), 'a second main product is refused', err?.message);
  check(!calls.some((c) => /productSet/.test(c.query)), 'and nothing is written');

  script.set = () => ({ data: { productSet: { product: null, userErrors: [{ field: ['variants'], message: 'Price must be greater than 0' }] } } });
  script.variants = () => ({ data: { productVariants: { nodes: [] } } });
  err = await publishOil({ ...oil, id: 'OIL_81' }, {}).catch((e) => e);
  check(err?.status === 400 && /Shopify refused the product: Price must be greater than 0/.test(err.message), 'Shopify\'s refusal comes back in its own words');

  // Shopify's SKU search lags a new product by seconds, so the second of two
  // Publishes would not see the first. The server holds the oil instead.
  console.log('\n2b. A second Publish while Shopify cannot see the first yet');
  script.variants = () => ({ data: { productVariants: { nodes: [] } } });
  script.set = () => ({ data: { productSet: { product: { id: 'gid://shopify/Product/new2', title: 'Jardin de Carthage (LUX0639)', variants: { nodes: [] } }, userErrors: [] } } });
  calls = [];
  const sets = () => calls.filter((c) => /productSet/.test(c.query)).length;
  const twin = { ...oil, id: 'OIL_82' };
  const [one, two] = await Promise.all([publishOil(twin, {}).catch((e) => e), publishOil(twin, {}).catch((e) => e)]);
  check(sets() === 1, 'a double click: Shopify is asked to create it once', String(sets()));
  check(one?.title && two?.status === 409 && /being published right now/.test(two.message), 'the second click is refused while the first is sending', two?.message);
  err = await publishOil(twin, {}).catch((e) => e);
  check(err?.status === 409 && /was just published/.test(err.message) && sets() === 1, 'right after, while Shopify still shows no main product: refused, nothing sent', err?.message);
  const failing = { ...oil, id: 'OIL_83' };
  script.set = () => ({ data: { productSet: { product: null, userErrors: [{ field: ['x'], message: 'no' }] } } });
  await publishOil(failing, {}).catch(() => {});
  script.set = () => ({ data: { productSet: { product: { id: 'gid://shopify/Product/new3', title: 'X', variants: { nodes: [] } }, userErrors: [] } } });
  out = await publishOil(failing, {}).catch((e) => e);
  check(out?.title === 'X', 'a Publish Shopify refused can be tried again straight away', out?.message);

  console.log('\n3. Add the missing sizes');
  script.variants = () => ({ data: { productVariants: { nodes: [v('SA_CA_00078', main), v('SA_1L_00078', main), v('SA_PRO_00078', main), v('SA_HF_00078', oldListing('SA_HF'))] } } });
  script.bulk = (vars) => ({ data: { productVariantsBulkCreate: { productVariants: vars.variants.map((x) => ({ sku: x.inventoryItem.sku })), userErrors: [] } } });
  calls = [];
  out = await addMissingOilSizes(oil, { costPerLitre: 42.40 });
  const bulkCall = calls.find((c) => /productVariantsBulkCreate/.test(c.query))?.variables;
  check(bulkCall?.productId === main.id && bulkCall.variants.map((x) => x.inventoryItem.sku).join() === 'SA_HF_00078,SA_CDIFF_00078',
    'the sizes the MAIN product lacks are added to it (an old listing does not count)', bulkCall?.variants.map((x) => x.inventoryItem.sku).join());
  check(out.added === 2 && out.productTitle === main.title, 'the answer: two added to the main product');
  script.variants = () => ({ data: { productVariants: { nodes: [v('SA_CA_00078', oldListing('SA_CA'))] } } });
  err = await addMissingOilSizes(oil, {}).catch((e) => e);
  check(err?.status === 409 && /no main product in Shopify yet/.test(err.message), 'no main product yet: refused, Publish creates it');

  // The product sheet's Publish / Add missing sizes (SKU Mapping removed, 6 Nov)
  // decide from readShopifyImage's `main`. It must be the server's own rule, or
  // the sheet offers a button the server refuses.
  console.log('\n4. The product sheet sees the main product the way the server does');
  const featuredMedia = null;
  script.variants = () => ({ data: { productVariants: { nodes: [
    v('SA_CA_00078', { ...oldListing('SA_CA'), featuredMedia }),
    v('SA_CA_00078', { ...main, status: 'ARCHIVED', featuredMedia }),
    v('SA_HF_00078', { ...main, featuredMedia }),
  ] } } });
  const read = await readShopifyImage(['SA_CA_00078', 'SA_HF_00078']);
  const mainOf = (sku) => read.variants.filter((x) => x.sku === sku).some((x) => x.main);
  check(!mainOf('SA_CA_00078'), 'an old listing or an ARCHIVED main product is not the main product');
  check(mainOf('SA_HF_00078'), 'the live main product is');
  check(/productVariants\(first: 25/.test(calls.at(-1).query), 'room for old listings and the main product of every size');
} finally {
  globalThis.fetch = realFetch;
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ shopify-product-pattern: all checks passed');
process.exit(failed ? 1 : 0);
