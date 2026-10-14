// Does the shelf run dry before the next order lands? (owner, 2026-10-15)
//
// Milagrito: 100 L lasting ~19 days, 200 L due in 13, and the modal said
// "reorder immediately" because it compared the shelf with the supplier's lead
// time and ignored the order already raised. This walks the dated orders in
// delivery order, refilling the shelf as each lands, and stops at the first
// day it is empty before the next one arrives.
//
// Orders with no date, or past their date, cannot be placed on that timeline:
// they are returned for the screen to name, never assumed to arrive.
//
// orders: [{ qty, date, days }] — qty in the same unit as stock, days from today.
export function shelfOutlook(stock, rate, orders = []) {
  const live = orders.filter((o) => o.qty > 0);
  const dated = live.filter((o) => o.days != null && o.days >= 0).sort((a, b) => a.days - b.days);
  const undatedQty = live.filter((o) => o.days == null).reduce((s, o) => s + o.qty, 0);
  const overdue = live.filter((o) => o.days != null && o.days < 0);

  let shelf = stock, t = 0;
  for (const o of dated) {
    const runsOutIn = t + shelf / rate;
    // Delivered the day it runs out is still a day with an empty shelf.
    if (runsOutIn <= o.days) return { runsOutIn, next: o, gapDays: o.days - runsOutIn, firstArrival: dated[0], undatedQty, overdue };
    shelf += o.qty - rate * (o.days - t);
    t = o.days;
  }
  return { runsOutIn: t + shelf / rate, next: null, gapDays: null, firstArrival: dated[0] || null, undatedQty, overdue };
}
