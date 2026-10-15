// Does the shelf run dry before the next order lands? (owner, 2026-10-15)
//
// Milagrito: 100 L lasting ~19 days, 200 L due in 13, and the modal said
// "reorder immediately" because it compared the shelf with the supplier's lead
// time and ignored the order already raised. This walks the dated orders in
// delivery order, refilling the shelf as each lands, and stops at the first
// day it is empty before the next one arrives.
//
// Orders with no date, or past their date, cannot be placed on that timeline:
// they are returned for the screen to name, never assumed to arrive. The same
// goes for status — Dream, 22.6 L against a 141 L minimum, read Healthy because
// a 200 L order due nine days after the shelf empties was counted as stock.
// The owner: "imagina ficar com zero no stock e o PO fica segurando o alerta
// em Healthy". inTimeQty is only what lands before the shelf is empty.
//
// Shared by the server (Demand Planning status) and the screens (stock status,
// the modal's alarm) so all of them run the same walk.
//
// orders: [{ qty, days }] — qty in the same unit as stock, days from today.
export function shelfOutlook(stock, rate, orders = []) {
  const live = orders.filter((o) => o.qty > 0);
  const dated = live.filter((o) => o.days != null && o.days >= 0).sort((a, b) => a.days - b.days);
  const undatedQty = live.filter((o) => o.days == null).reduce((s, o) => s + o.qty, 0);
  const overdue = live.filter((o) => o.days != null && o.days < 0);

  let shelf = Math.max(0, stock), t = 0, inTimeQty = 0;
  for (const o of dated) {
    const runsOutIn = t + shelf / rate;
    // Delivered the day it runs out is still a day with an empty shelf.
    if (runsOutIn <= o.days) {
      return { runsOutIn, next: o, gapDays: o.days - runsOutIn, firstArrival: dated[0], inTimeQty, undatedQty, overdue };
    }
    shelf += o.qty - rate * (o.days - t);
    t = o.days;
    inTimeQty += o.qty;
  }
  return { runsOutIn: t + shelf / rate, next: null, gapDays: null, firstArrival: dated[0] || null, inTimeQty, undatedQty, overdue };
}

// How much to order TODAY so the shelf never runs dry between the day this
// order lands (leadTime) and the end of the period an order covers (horizon),
// given the orders already on the calendar (code review, 2026-10-15).
//
// The shelf is lowest just before each order lands, and at the horizon. So the
// order is the largest shortfall over those moments:
//   rate × t − shelf − (orders landing before t)
// Before the lead time nothing ordered today can help, so those moments are
// not checked — that is Critical, and chasing the supplier is the answer.
// Orders after the horizon do not count toward it. Orders with no date, or
// overdue, ARE counted from today: buying them a second time is the costlier
// mistake, and the screens name them so someone confirms the date.
//
// With every dated order landing before the lead time — all of them on
// 15 Oct — this is exactly rate × horizon − shelf − on order, the formula it
// replaces. It differs only when an order lands late, where that formula
// counted it as stock and left the shelf empty until it came (one gap, or
// several: the previous version sized only the first).
//
// Returns { qty, bindingDays }: bindingDays is the order whose late arrival
// sized it, or null when the horizon did (the ordinary case).
export function orderToCover(stock, rate, orders, leadTime, horizon) {
  const live = orders.filter((o) => o.qty > 0);
  const untimed = live.filter((o) => o.days == null || o.days < 0).reduce((s, o) => s + o.qty, 0);
  const dated = live.filter((o) => o.days != null && o.days >= 0).sort((a, b) => a.days - b.days);
  // Stock as recorded, negative included — exactly what the old formula used.
  const base = stock + untimed;
  const before = (t) => dated.filter((o) => o.days < t).reduce((s, o) => s + o.qty, 0);
  let qty = Math.max(0, rate * horizon - base - before(horizon + 1e-9)), bindingDays = null;
  for (const o of dated) {
    if (o.days <= leadTime || o.days > horizon) continue;
    const need = rate * o.days - base - before(o.days);
    // Under a day of demand is rounding dust, not a reason to call it a
    // late-order bridge (and force a 1 L order, and an Attention badge).
    if (need > qty) { qty = need; bindingDays = need >= rate ? o.days : null; }
  }
  return { qty, bindingDays };
}

// Safety stock = what is used while an order travels, plus 25% (owner,
// 2026-10-14). So below 1/1.25 = 80% of it, even an order placed today lands
// after the shelf is empty: that is Critical, on every screen.
export const SAFETY_STOCK_FACTOR = 1.25;
