// The product sheet's Shopify read (PRD_H2_STOCK_MANAGEMENT.md §2.3, A11):
// the image and each SKU's status, asked of the SA store by the product's SKUs
// every time a sheet opens. NOTHING is stored (owner, 28 Oct): the browser
// loads the image straight from Shopify's CDN.
//
// Fails softly by design (R8): no credentials, no SKU, Shopify slow or down —
// the answer is "no image", never an error, so the sheet always opens.

import { OIL_PATTERN } from '../../shared/shopify-product-pattern.js';

const API = '2026-04';

/**
 * skus: the product's Shopify SKUs. Returns
 *   { image: { url, alt } | null, variants: [{ sku, title, status, main }] }
 * main: the variant sits on the oil's main product (P7), by the same rule the
 * server's Publish uses (shopify-products.js mainOf: the pattern's product
 * type, not archived), so the sheet's Publish / Add missing sizes match it.
 * or null when the store cannot be asked.
 */
export async function readShopifyImage(skus) {
  const shop = process.env.SA_SHOPIFY_SHOP_DOMAIN || process.env.SA_SHOPIFY_STORE_NAME;
  const token = process.env.SA_SHOPIFY_ACCESS_TOKEN;
  const list = [...new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 10);
  if (!shop || !token || !list.length) return null;
  const host = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
  // The SKUs come from our own table, but they are quoted all the same.
  const search = list.map((s) => `sku:"${s.replace(/["\\]/g, '')}"`).join(' OR ');
  try {
    const res = await fetch(`https://${host}/admin/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($q: String!) { productVariants(first: 25, query: $q) { nodes {
          sku image { url altText }
          product { title status productType featuredMedia { preview { image { url altText } } } } } } }`,
        variables: { q: search },
      }),
      signal: AbortSignal.timeout(6000),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    const nodes = body?.data?.productVariants?.nodes;
    if (!Array.isArray(nodes)) {
      console.error(`[shopify-image] no answer (${res.status})`, body?.errors?.[0]?.message || '');
      return null;
    }
    // The variant's own picture first, else its product's main one.
    const pic = nodes.map((n) => n.image || n.product?.featuredMedia?.preview?.image).find((i) => i?.url) || null;
    return {
      image: pic ? { url: pic.url, alt: pic.altText || nodes[0]?.product?.title || '' } : null,
      variants: nodes.map((n) => ({
        sku: n.sku, title: n.product?.title || '', status: (n.product?.status || '').toLowerCase(),
        main: n.product?.productType === OIL_PATTERN.productType && n.product?.status !== 'ARCHIVED',
      })),
    };
  } catch (e) {
    console.error('[shopify-image] read failed:', e.message);
    return null;
  }
}
