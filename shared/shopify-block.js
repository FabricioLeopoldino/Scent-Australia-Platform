// Creating products in Shopify from the platform is ON HOLD (owner, 19 Nov
// 2026), until the company defines how a product is created in Shopify.
//
// Products are still created and edited in the platform; only the step that
// creates them, or their sizes, in a Shopify store is refused, with the
// message below. It covers the SA store (new machines, spares and raw
// materials, oil Publish, Add missing sizes, formulas) and the MUSE store
// (product Publish, the New Fragrance publish). Updating products that already
// exist in Shopify is not affected.
//
// To lift the hold: set SHOPIFY_PRODUCT_CREATION_BLOCKED to false.
export const SHOPIFY_PRODUCT_CREATION_BLOCKED = true;

export const SHOPIFY_BLOCK_MESSAGE =
  'This action has been blocked for now, until the correct way to create products in Shopify is defined.';

// 423 Locked: the request is fine, the action is on hold.
export const SHOPIFY_BLOCK_STATUS = 423;
