// The SA Shopify product pattern (owner, 30 Oct 2026, HYPER_UPDATE_BACKLOG.md
// P7). ONE main product per fragrance, "Name (SUPPLIER CODE)", with the five
// sale SKUs as its variants — copied from the owner's test product
// 9664987103321, Jardin De Carthage (LUX0639). One definition, read by the
// server (what it sends to Shopify) and the screen (the preview before it does).
//
// The SKUs do not change: the platform still finds every sale, PO line and
// sheet by SKU, so the old one-product-per-size listings and the new main
// product both reach the same oil while the old ones are being archived.
import { SA_SKU_VARIANTS } from './sa-sku-variants.js';

export const OIL_PATTERN = {
  vendor: 'Scent Australia',
  productType: 'Scent Australia (SA Warehouse)',
  // Health & Beauty > … > Perfumes & Colognes > Perfume Oils (read from the test product).
  category: 'gid://shopify/TaxonomyCategory/hb-3-2-8-8',
  optionName: 'Scent Australia',
  status: 'ACTIVE',
  // Published on this channel only (owner, 30 Oct).
  publication: 'Point of Sale',
};

// Per size: the variant title after the name (as the store already names them),
// the weight with its packaging (the cartridge itself weighs, owner 30 Oct) and
// the selling price (owner, 30 Oct: "em torno de" — a default, editable when
// publishing). Volumes come from shared/sa-sku-variants.js.
const SIZE = {
  SA_CA:    { suffix: 'Oil Cartridge (400ml)',     weightG: 600,  price: 150 },
  SA_HF:    { suffix: '-500ML Oil Refill Bottle',  weightG: 500,  price: 150 },
  SA_CDIFF: { suffix: 'Oil Refill (700ml)',        weightG: 700,  price: 200 },
  SA_1L:    { suffix: '1L Oil Refill Bottle',      weightG: 1000, price: 300 },
  SA_PRO:   { suffix: '-1L Oil Refill Pro Bottle', weightG: 1000, price: 300 },
};
export const OIL_SIZES = Object.fromEntries(Object.entries(SIZE)
  .map(([k, s]) => [k, { ...s, volumeMl: SA_SKU_VARIANTS[k].volumeMl }]));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s) => String(s ?? '').trim();

/** "Jardin De Carthage (LUX0639)" — the supplier code in capitals; the name alone without one. */
export const oilTitle = (p) => (clean(p.supplier_code) ? `${clean(p.name)} (${clean(p.supplier_code).toUpperCase()})` : clean(p.name));
/** "Luxaroma - Scent Australia" — the supplier, then the company. */
export const oilTag = (p) => (clean(p.supplier) ? `${clean(p.supplier)} - Scent Australia` : null);
/** The description: the supplier and the supplier code (owner, 30 Oct). */
export const oilDescription = (p) => [
  clean(p.supplier) && `<p>Supplier: ${esc(clean(p.supplier))}</p>`,
  clean(p.supplier_code) && `<p>Supplier code: ${esc(clean(p.supplier_code).toUpperCase())}</p>`,
].filter(Boolean).join('');
export const variantTitle = (p, key) => `${clean(p.name)} ${OIL_SIZES[key].suffix}`;

/**
 * Cost per item from the supplier's cost per litre (owner, 30 Oct: "informando
 * o preço a plataforma já faz a conversão"): $42.40/L → 400 ml 16.96, 500 ml
 * 21.20, 700 ml 29.68, 1 L 42.40 — the test product's own figures. Ex GST, as
 * every cost in the platform (S8). Null when no cost was given: Shopify then
 * has none, never $0.
 */
export function variantCost(costPerLitre, volumeMl) {
  const c = Number(costPerLitre);
  return c > 0 ? Math.round(c * volumeMl / 10) / 100 : null;
}

/** The selling price for a size: the one typed, else the default. */
export const variantPrice = (key, prices = {}) => {
  const typed = Number(prices?.[key]);
  return typed > 0 ? typed : OIL_SIZES[key].price;
};

/** What the person should know before publishing: missing fields that the pattern needs. */
export function oilWarnings(p, costPerLitre) {
  return [
    !clean(p.supplier_code) && 'No supplier code: the title will be the name alone, and the description will not carry it.',
    !clean(p.supplier) && 'No supplier: no supplier tag, and the description will not name one.',
    !(Number(costPerLitre) > 0) && 'No cost per litre: the variants go to Shopify without a cost per item.',
  ].filter(Boolean);
}

/** The inventory item of one size: tracked, physical, weighed, costed. */
export const inventoryItemFor = (key, costPerLitre) => ({
  tracked: true,
  requiresShipping: true,
  measurement: { weight: { value: OIL_SIZES[key].weightG, unit: 'GRAMS' } },
  // Shopify's Decimal and Money travel as strings, so no float noise reaches it.
  ...(variantCost(costPerLitre, OIL_SIZES[key].volumeMl) != null && { cost: variantCost(costPerLitre, OIL_SIZES[key].volumeMl).toFixed(2) }),
});

/** The oil's five sale SKUs in pattern order, [[key, sku]] — only the sizes it has. */
export const oilSkus = (p) => Object.keys(OIL_SIZES).map((k) => [k, clean(p.shopifySkus?.[k])]).filter(([, sku]) => sku);

/**
 * Shopify's productSet input for an oil, in the pattern. Pure: tested offline
 * (scripts/regression-shopify-product-pattern.js).
 *   Charge tax on, physical product, stock tracked (owner, 30 Oct). Sold when
 *   Shopify shows 0 ("continue"), as the test product: the platform keeps the
 *   stock and never sends it to the SA store, so Shopify's own count is not the
 *   shelf.
 */
export function oilProductInput(p, { costPerLitre, prices } = {}) {
  const sizes = oilSkus(p);
  return {
    title: oilTitle(p),
    descriptionHtml: oilDescription(p),
    vendor: OIL_PATTERN.vendor,
    productType: OIL_PATTERN.productType,
    tags: [oilTag(p)].filter(Boolean),
    category: OIL_PATTERN.category,
    status: OIL_PATTERN.status,
    productOptions: [{ name: OIL_PATTERN.optionName, position: 1, values: sizes.map(([k]) => ({ name: variantTitle(p, k) })) }],
    variants: sizes.map(([k, sku], i) => ({
      optionValues: [{ optionName: OIL_PATTERN.optionName, name: variantTitle(p, k) }],
      sku,
      price: variantPrice(k, prices).toFixed(2),
      taxable: true,
      inventoryPolicy: 'CONTINUE',
      position: i + 1,
      inventoryItem: inventoryItemFor(k, costPerLitre),
    })),
  };
}

/** One size added to an existing main product (productVariantsBulkCreate: the SKU sits on the inventory item). */
export function oilVariantBulkInput(p, key, sku, { costPerLitre, prices } = {}) {
  return {
    optionValues: [{ optionName: OIL_PATTERN.optionName, name: variantTitle(p, key) }],
    price: variantPrice(key, prices).toFixed(2),
    taxable: true,
    inventoryPolicy: 'CONTINUE',
    inventoryItem: { sku, ...inventoryItemFor(key, costPerLitre) },
  };
}
