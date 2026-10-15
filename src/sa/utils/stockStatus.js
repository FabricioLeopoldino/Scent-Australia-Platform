// Single source of truth for "how healthy is this product's stock?" (QA #17).
//
// This used to be defined independently in 5 places with two different rules:
// Product Management / Machine Inventory / Dashboard used `currentStock <
// minStockLevel`, while BOM Viewer and Diffuser BOM used `<=` — so an item
// sitting exactly AT its reorder point showed as low on the BOM screens and
// healthy everywhere else. Unified on the `<` rule (the one the main stock
// screens and every Dashboard count already used) so no existing figure shifts.
//
// Negative is a real state platform-wide since the 2026-07-22 negative-stock
// policy (physical movements are always recorded, even when they overdraw), so
// it gets its own bucket instead of being lumped in with "low".
import { shelfOutlook, SAFETY_STOCK_FACTOR } from '../../../shared/shelf-outlook.js';

export const STOCK_STATUS = {
  NEGATIVE: { key: 'NEGATIVE', label: 'Negative Stock', color: 'red' },
  OUT:      { key: 'OUT',      label: 'Out of Stock',   color: 'red' },
  CRITICAL: { key: 'CRITICAL', label: 'Critical',       color: 'red' },
  LOW:      { key: 'LOW',      label: 'Low Stock',      color: 'yellow' },
  HEALTHY:  { key: 'HEALTHY',  label: 'In Stock',       color: 'green' },
};

/**
 * The minimum that decides "low". For an oil with a demand signal the server
 * sends `minStockAuto` — the Demand Planning safety stock — and it wins over
 * the typed value, which was a guess (owner, 2026-10-14). Everything else keeps
 * its typed `minStockLevel`.
 */
export function effectiveMin(product) {
  const auto = product?.minStockAuto;
  return auto != null ? auto : (parseFloat(product?.minStockLevel) || 0);
}

const stillToArrive = (o) => Math.max(0, (parseFloat(o.quantity) || 0) - (parseFloat(o.quantityReceived) || 0));

/** Still to arrive on open purchase orders (`incomingOrders` from /api/products). */
export function incomingQty(product) {
  return (product?.incomingOrders || []).reduce((sum, o) => sum + stillToArrive(o), 0);
}

/**
 * Shelf plus what is on order that counts toward it.
 *
 * An oil with an automatic minimum also carries its daily rate, so an order
 * counts only if it lands before the shelf is empty (shared/shelf-outlook.js).
 * Dream, 2026-10-15: 22.6 L (~4 days) with 200 L due in 13 read Healthy,
 * because the order counted the day it was raised — the owner: "imagina ficar
 * com zero no stock e o PO fica segurando o alerta em Healthy". Undated and
 * overdue orders do not count either. Without a rate (machines, spares, raw
 * materials, oils with no demand) there is no way to time an order, so every
 * open order counts, as before.
 */
export function coveredStock(product) {
  const stock = parseFloat(product?.currentStock) || 0;
  const rate = product?.autoDailyRate;
  if (product?.minStockAuto != null && rate > 0) {
    const orders = (product?.incomingOrders || []).map((o) => ({ qty: stillToArrive(o), days: o.etaDays ?? null }));
    // Capped like the server: an over-received open order nets off the total.
    const netOnOrder = Math.max(0, (product?.incomingOrders || []).reduce((s, o) =>
      s + (parseFloat(o.quantity) || 0) - (parseFloat(o.quantityReceived) || 0), 0));
    return Math.min(stock + shelfOutlook(stock, rate, orders).inTimeQty, stock + netOnOrder);
  }
  return stock + incomingQty(product);
}

/**
 * Full status for a SA product row.
 *
 * Empty and negative stay empty and negative whatever is on the way: that is
 * what is on the shelf today. Otherwise the shelf plus what is on order in
 * time (coveredStock) against the minimum:
 *   · at or above it            → HEALTHY
 *   · below it                  → LOW: order now, it still lands in time
 *   · below 80% of it (1/1.25)  → CRITICAL, automatic minimums only: that is
 *     less than what is used while an order travels, so even an order placed
 *     today lands after the shelf is empty. Same line as Critical in Demand
 *     Planning, so the two screens agree. (Owner, 2026-10-15.)
 */
export function getStockStatus(product) {
  const stock = parseFloat(product?.currentStock) || 0;
  if (stock < 0) return STOCK_STATUS.NEGATIVE;
  if (stock === 0) return STOCK_STATUS.OUT;
  const covered = coveredStock(product);
  const min = effectiveMin(product);
  if (product?.minStockAuto != null && covered < min / SAFETY_STOCK_FACTOR) return STOCK_STATUS.CRITICAL;
  if (covered < min) return STOCK_STATUS.LOW;
  return STOCK_STATUS.HEALTHY;
}

/** True for the "short but still in stock" bands — LOW and CRITICAL; excludes 0 and negative. */
export function isLowStock(product) {
  const key = getStockStatus(product).key;
  return key === 'LOW' || key === 'CRITICAL';
}

/** Multiplier above minStockLevel that still counts as "order it soon". */
export const REORDER_SOON_FACTOR = 1.5;

/**
 * Healthy, but within REORDER_SOON_FACTOR × minStockLevel — the early-warning
 * band Raw Materials shows. Kept here so the threshold isn't redefined per page.
 */
export function isReorderSoon(product) {
  if (getStockStatus(product).key !== 'HEALTHY') return false;
  const min = effectiveMin(product);
  return min > 0 && coveredStock(product) <= min * REORDER_SOON_FACTOR;
}
