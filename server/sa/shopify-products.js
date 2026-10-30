// Writes an oil's products to the SA Shopify store in the owner's pattern
// (HYPER_UPDATE_BACKLOG.md P7, shared/shopify-product-pattern.js): ONE main
// product per fragrance with the five sizes as variants, then published on
// Point of Sale only.
//
// It replaces, for oils, the old one-product-per-size publish (still used by
// the other categories in index.js createProductInShopify). It writes ONLY on
// an admin's explicit click, never on a read.
//
// Guarded the way the PO read is: every Shopify answer is checked, a refusal
// comes back in Shopify's own words, and nothing is guessed. Two mains for one
// oil would split its sales history in Shopify, so a second one is refused.
import { OIL_PATTERN, oilProductInput, oilVariantBulkInput, oilSkus, oilWarnings } from '../../shared/shopify-product-pattern.js';

const API = '2026-04';
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

async function gql(query, variables) {
  const shop = process.env.SA_SHOPIFY_SHOP_DOMAIN || process.env.SA_SHOPIFY_STORE_NAME;
  const token = process.env.SA_SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) throw httpError(400, 'Shopify is not connected (SA store credentials missing)');
  const host = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
  const res = await fetch(`https://${host}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw httpError(502, `Shopify answered ${res.status} with no data`);
  if (body.errors?.length) throw httpError(502, `Shopify: ${body.errors.map((e) => e.message).join(' | ')}`);
  return body.data;
}

/** Every variant in the store carrying one of these SKUs, with its product. */
async function variantsBySku(skus) {
  if (!skus.length) return [];
  const q = skus.map((s) => `sku:"${s.replace(/["\\]/g, '')}"`).join(' OR ');
  const data = await gql(`query($q: String!) { productVariants(first: 50, query: $q) { nodes {
    sku product { id title productType status } } } }`, { q });
  // The search is by token, so the SKU is checked exactly here.
  return data.productVariants.nodes.filter((v) => skus.includes(v.sku));
}

/** The oil's main product in the pattern, if one exists (not archived). */
const mainOf = (existing) => existing.find((v) => v.product.productType === OIL_PATTERN.productType && v.product.status !== 'ARCHIVED')?.product || null;

/**
 * Point of Sale only (owner, 30 Oct). Needs the app's write_publications
 * scope; without it the product stays created but on no channel, and the
 * answer says so — the person turns Point of Sale on in Shopify.
 */
async function publishOnPointOfSale(productId) {
  try {
    const pubs = await gql(`{ publications(first: 25) { nodes { id name } } }`);
    const pos = pubs.publications.nodes.find((p) => p.name === OIL_PATTERN.publication);
    if (!pos) return { ok: false, error: 'The store has no Point of Sale channel' };
    const r = await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) {
      userErrors { field message } } }`, { id: productId, input: [{ publicationId: pos.id }] });
    const errs = r.publishablePublish.userErrors;
    return errs.length ? { ok: false, error: errs.map((e) => e.message).join('; ') } : { ok: true };
  } catch (e) {
    return { ok: false, error: /access denied|write_publications/i.test(e.message)
      ? 'The platform\'s Shopify app has no permission to choose sales channels (write_publications). Turn Point of Sale on for this product in Shopify.'
      : e.message };
  }
}

/** Create the oil's main product. Refused when one already exists. */
export async function publishOil(product, { costPerLitre, prices } = {}) {
  const sizes = oilSkus(product);
  if (!sizes.length) throw httpError(400, `${product.name} has none of the five sale SKUs`);
  const existing = await variantsBySku(sizes.map(([, sku]) => sku));
  const main = mainOf(existing);
  if (main) {
    throw httpError(409, `${product.name} already has its main product in Shopify ("${main.title}"). Use "Add missing" for a size it lacks.`);
  }
  const input = oilProductInput(product, { costPerLitre, prices });
  const data = await gql(`mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) {
    product { id title variants(first: 10) { nodes { sku } } }
    userErrors { field message } } }`, { input });
  const errs = data.productSet.userErrors;
  if (errs.length) throw httpError(400, `Shopify refused the product: ${errs.map((e) => e.message).join('; ')}`);
  const created = data.productSet.product;
  const pos = await publishOnPointOfSale(created.id);
  return {
    productId: created.id, title: created.title, skus: created.variants.nodes.map((v) => v.sku),
    posPublished: pos.ok, posError: pos.error || null,
    // The old one-per-size listings still carry these SKUs: to archive once the new one is right.
    oldListings: [...new Set(existing.map((v) => v.product.title))],
    warnings: oilWarnings(product, costPerLitre),
  };
}

/** Add the sizes the main product lacks. Refused when there is no main product yet. */
export async function addMissingOilSizes(product, { costPerLitre, prices } = {}) {
  const sizes = oilSkus(product);
  const existing = await variantsBySku(sizes.map(([, sku]) => sku));
  const main = mainOf(existing);
  if (!main) {
    throw httpError(409, `${product.name} has no main product in Shopify yet ("${OIL_PATTERN.productType}"). Publish creates it.`);
  }
  const onMain = new Set(existing.filter((v) => v.product.id === main.id).map((v) => v.sku));
  const missing = sizes.filter(([, sku]) => !onMain.has(sku));
  if (!missing.length) return { added: 0, skus: [], productTitle: main.title };
  const data = await gql(`mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { sku } userErrors { field message } } }`,
  { productId: main.id, variants: missing.map(([k, sku]) => oilVariantBulkInput(product, k, sku, { costPerLitre, prices })) });
  const errs = data.productVariantsBulkCreate.userErrors;
  if (errs.length) throw httpError(400, `Shopify refused the sizes: ${errs.map((e) => e.message).join('; ')}`);
  return { added: data.productVariantsBulkCreate.productVariants.length, skus: data.productVariantsBulkCreate.productVariants.map((v) => v.sku), productTitle: main.title, warnings: oilWarnings(product, costPerLitre) };
}
