// H4 rules, offline (PRD_H4_PURCHASE_ORDERS.md R7–R9, D1, cases 10–15). No
// database is queried and Shopify is not called. The fixtures are the real
// purchase orders of 4 Nov 2026: #PO283, #PO275, #PO272, the bioethanol of
// #PO264/265, and the Print Express labels.
//
//   node scripts/regression-purchase-orders.js
//
// Importing the module opens a database pool lazily; nothing here connects.
const { buildOrders, holdOf, poDigits, AUTO_BY } = await import('../server/sa/purchase-orders.js');
const { resolveLine } = await import('../server/sa/shopify-purchase-orders.js');

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `  — ${detail}`}`);
};

const SINCE = '2026-11-05';
const DEST = { SA: 'SA Warehouse', MUSE_ATELIER: 'SA Custom Orders', MUSE: 'MUSE' };
const order = (number, { stock = 'SA', date = '2026-10-22', arrived = false, lines }) => ({
  shopifyId: `gid://shopify/PurchaseOrder/${number.replace('#PO', '')}`, number, supplier: 'Supplier',
  destination: DEST[stock] || 'Somewhere new', destinationStock: stock, destinationLabel: stock,
  destinationError: stock ? null : 'The destination "Somewhere new" is not linked to a company.',
  dateCreated: `${date}T01:00:00Z`, dateCreatedLocal: date, transfers: arrived ? ['#T1 (TRANSFERRED)'] : [],
  arrivedInShopify: arrived, lines,
});
const oil = (lineId, productId, litres, extra = {}) => ({
  lineId, sku: `SA_1L_${productId}`, quantity: litres, unitCost: 0, matched: true, reason: null,
  productId, productCode: productId, productName: productId, unit: 'mL', category: 'OILS', isOil: true,
  incomingQty: litres * 1000, perUnit: 1000, incomingMl: litres * 1000, bottles: litres, bottleMl: 1000, ...extra,
});
const other = (lineId, sku, qty, extra = {}) => ({
  lineId, sku, quantity: qty, unitCost: 0, matched: true, reason: null, productId: 'RM_1', productCode: 'RM_1',
  productName: 'Raw material', unit: 'units', category: 'RAW_MATERIALS', isOil: false, incomingQty: qty, perUnit: 1, ...extra,
});
let nextId = 1;
const row = (product, number, litres, { line = null, gid = null, rec = 0, status = 'pending', closedShort = false, by = 'payal', stock = 'SA' } = {}) => ({
  id: nextId++, product_id: product, order_number: number, q: litres * 1000, rec: rec * 1000, status, closed_short: closedShort,
  shopify_line_id: line, shopify_po_gid: gid, destination_stock: stock, added_by: by, added_at: new Date('2026-10-23T05:00:00Z'),
  product_name: product, product_code: product, unit: 'mL', category: 'OILS',
});
const regs = new Map([
  ['SANTAL', { SA: { active: true } }], ['TEATIME', { SA: { active: true } }], ['XMAS', { SA: { active: true } }],
  ['CAJU', { SA: { active: true } }], ['MYRRH', { SA: { active: true } }], ['NEWYORK', { SA: { active: true }, MUSE: { active: true } }],
]);
const ctx = (rows = []) => ({ regs, since: SINCE, handTyped: (() => {
  const m = new Map();
  for (const r of rows) {
    const d = !r.shopify_line_id && r.status !== 'cancelled' && poDigits(r.order_number);
    if (d) m.set(`${d}|${r.product_id}`, [...(m.get(`${d}|${r.product_id}`) || []), r]);
  }
  return m;
})() });
const build = (orders, rows) => buildOrders({ read: orders ? { orders } : null, rows, regs, since: SINCE });
const find = (list, n) => list.find((o) => o.number === n);
const lineOf = (o, id) => o?.lines.find((l) => l.lineId === id);

console.log('\nPO numbers');
record('"#PO283", "PO283", "po283" and "PO-283" are one order', ['#PO283', 'PO283', 'po283', 'PO-283'].every((s) => poDigits(s) === '283'));
record('a reference that is not a PO number has none ("2.10.26")', poDigits('2.10.26') === null);

console.log('\n#PO283 — two paths for one oil (R7 guard, case 11)');
{
  const po = order('#PO283', { arrived: true, lines: [oil('L1', 'SANTAL', 20), oil('L2', 'TEATIME', 10), oil('L3', 'XMAS', 10)] });
  const rows = [
    row('SANTAL', '#PO283', 20, { line: 'L1', gid: po.shopifyId, rec: 20, status: 'received' }),
    row('TEATIME', '#PO283', 5, { line: 'L2', gid: po.shopifyId, rec: 5, status: 'received' }),
    row('TEATIME', 'PO283', 5, { rec: 5, status: 'received' }),
    row('XMAS', 'po283', 10, { rec: 10, status: 'received' }),
  ];
  record('a line typed by hand as "po283" is held back, never accepted by itself', holdOf(po, po.lines[2], ctx(rows))?.state === 'by_hand');
  const list = build([po], rows);
  const o = find(list, '#PO283');
  record('… and counts as done once the hand-typed order is received', lineOf(o, 'L3')?.state === 'by_hand' && lineOf(o, 'L3')?.handDone === true);
  record('the order closes: Transferred in Shopify and every line done', o?.status === 'closed' && o?.alert === null && o?.attention === false, `${o?.status}/${o?.alert}`);
  const hand = list.filter((x) => x.origin === 'manual' && poDigits(x.number) === '283');
  record('the hand-typed rows stay visible as one manual order of their own, closed', hand.length === 1 && hand[0].lines.length === 2 && hand[0].status === 'closed',
    hand.map((h) => `${h.number}:${h.lines.length}:${h.status}`).join(' '));
  const pendingHand = [rows[0], rows[1], rows[2], { ...rows[3], rec: 0, status: 'pending' }];
  const o2 = find(build([po], pendingHand), '#PO283');
  record('if the hand-typed order is still pending: 🔴 received in Shopify, record it here', o2?.alert === 'record_here' && o2?.attention === true, `${o2?.status}/${o2?.alert}`);
}

console.log('\n#PO275 — received in Shopify, never here (case 12)');
{
  const po = order('#PO275', { stock: 'MUSE_ATELIER', date: '2026-10-09', arrived: true, lines: [oil('L1', 'CAJU', 100), oil('L2', 'MYRRH', 50)] });
  const o = find(build([po], []), '#PO275');
  record('its oils are not registered in MUSE: the lines say so', o?.lines.every((l) => l.state === 'not_registered' && l.registerCompany === 'MUSE'));
  record('🔴 received in Shopify, record it here', o?.alert === 'record_here' && o?.attention === true, `${o?.status}/${o?.alert}`);
  const clean = order('#PO312', { date: '2026-11-20', arrived: true, lines: [oil('L9', 'NEWYORK', 20)] });
  const c = find(build([clean], []), '#PO312');
  record('a new, clean order first seen when already Transferred is not accepted by itself', lineOf(c, 'L9')?.state === 'waiting' && lineOf(c, 'L9')?.autoReady === false && c?.alert === 'record_here');
}

console.log('\n#PO272 — received here, transfer still in progress (case 13)');
{
  const po = order('#PO272', { date: '2026-10-09', lines: [oil('L1', 'SANTAL', 5), oil('L2', 'TEATIME', 5)] });
  const rows = [
    row('SANTAL', '#PO272', 5, { line: 'L1', gid: po.shopifyId, rec: 5, status: 'received' }),
    row('TEATIME', '#PO272', 5, { line: 'L2', gid: po.shopifyId, rec: 5, status: 'received' }),
  ];
  const o = find(build([po], rows), '#PO272');
  record('🟡 received here, finish the transfer in Shopify', o?.status === 'received' && o?.alert === 'finish_in_shopify', `${o?.status}/${o?.alert}`);
  const done = find(build([{ ...po, arrivedInShopify: true }], rows), '#PO272');
  record('once Transferred, it is closed (case 14)', done?.status === 'closed' && done?.alert === null);
}

console.log('\nAutomatic accept and the cut-off (R7, R9, case 10)');
{
  const po = order('#PO310', { date: '2026-11-06', lines: [oil('L1', 'SANTAL', 20), oil('L2', 'NEWYORK', 10)] });
  record('a clean oil line on a new order is accepted by itself', holdOf(po, po.lines[0], ctx()) === null && lineOf(find(build([po], []), '#PO310'), 'L1')?.autoReady === true);
  const old = order('#PO305', { date: '2026-10-30', lines: [oil('L1', 'NEWYORK', 30)] });
  const o = find(build([old], []), '#PO305');
  record('an oil line from before the cut-off waits for a person', lineOf(o, 'L1')?.state === 'waiting' && lineOf(o, 'L1')?.autoReady === false && o?.attention === true);
  const museUnreg = order('#PO311', { stock: 'MUSE', date: '2026-11-06', lines: [oil('L1', 'SANTAL', 10)] });
  record('an oil not registered in the order\'s company is held back (case 15)', holdOf(museUnreg, museUnreg.lines[0], ctx())?.state === 'not_registered');
  const unknown = order('#PO313', { stock: null, date: '2026-11-06', lines: [oil('L1', 'SANTAL', 10)] });
  const u = find(build([unknown], []), '#PO313');
  record('an unknown destination is held back and needs a person (case 7)', lineOf(u, 'L1')?.state === 'unknown_destination' && u?.attention === true);
  record('the automatic accept is recorded as "Automatic (Shopify)"', AUTO_BY === 'Automatic (Shopify)');
}

console.log('\nNon-oil lines (D1, R9)');
{
  const eth = order('#PO264', { date: '2026-10-01', arrived: true, lines: [other('L1', 'SA_RM_00019', 400, { unit: 'mL', matched: false, reason: 'how much one SA_RM_00019 is, in mL, is not set' })] });
  const e = find(build([eth], []), '#PO264');
  record('#PO264, bioethanol from before the cut-off: information only, even with no multiplier', lineOf(e, 'L1')?.state === 'info');
  record('… and it closes once Transferred, with no alert', e?.status === 'closed' && e?.alert === null && e?.attention === false, `${e?.status}/${e?.alert}`);
  const notYet = find(build([{ ...eth, arrivedInShopify: false }], []), '#PO264');
  record('… not yet Transferred: shown as information, nothing to do', notYet?.status === 'info' && notYet?.alert === null && notYet?.attention === false);
  const labels = order('#PO320', { stock: 'MUSE_ATELIER', date: '2026-11-10', lines: [other('L1', 'PE_LABEL_1', 500, { matched: false, reason: 'no active product carries the code PE_LABEL_1' })] });
  record('Print Express labels for The Atelier: MUSE components, not tracked here yet', holdOf(labels, labels.lines[0], ctx())?.state === 'info');
  const spare = order('#PO321', { date: '2026-11-10', lines: [other('L1', 'SA_SP_00001', 3)] });
  record('a spare part on a new SA order is accepted by itself', holdOf(spare, spare.lines[0], ctx()) === null);
  const noMult = order('#PO322', { date: '2026-11-10', lines: [other('L1', 'SA_RM_00019', 400, { unit: 'mL', matched: false, reason: 'not set' })] });
  record('a new raw-material line with no multiplier waits for a person', holdOf(noMult, noMult.lines[0], ctx())?.state === 'unmatched');
}

console.log('\nWhat Shopify\'s list does not show');
{
  const rows = [
    row('SANTAL', 'PO-OLD-1', 10, { rec: 10, status: 'received', by: 'manual' }),
    row('TEATIME', 'PO-OLD-2', 10, { by: 'manual' }),
    row('XMAS', '#PO250', 10, { line: 'GONE1', gid: 'gid://shopify/PurchaseOrder/250' }),
    row('CAJU', '#PO251', 10, { line: 'GONE2', gid: 'gid://shopify/PurchaseOrder/251', rec: 10, status: 'received' }),
    row('MYRRH', '#PO252', 10, { line: 'GONE3', gid: 'gid://shopify/PurchaseOrder/252', status: 'cancelled' }),
  ];
  const list = build([], rows);
  record('a received manual order is closed', find(list, 'PO-OLD-1')?.status === 'closed');
  record('a pending manual order is on order, and SA\'s', find(list, 'PO-OLD-2')?.status === 'on_order' && find(list, 'PO-OLD-2')?.destinationStock === 'SA');
  const gone = find(list, '#PO250');
  record('an accepted line whose order left Shopify is flagged and needs a person', gone?.lines[0]?.missing === true && gone?.attention === true);
  record('a received one from an archived order is simply closed', find(list, '#PO251')?.status === 'closed');
  record('an order whose every line is cancelled shows as cancelled', find(list, '#PO252')?.status === 'cancelled' && find(list, '#PO252')?.attention === false);
  const down = build(null, rows);
  record('Shopify unreadable: the platform\'s own orders still list, none flagged as gone', down.length === 5 && !find(down, '#PO250')?.lines[0]?.missing);
}

console.log('\nEdited in Shopify after accepting');
{
  const po = order('#PO330', { date: '2026-11-10', lines: [oil('L1', 'SANTAL', 20)] });
  const o = find(build([po], [row('SANTAL', '#PO330', 10, { line: 'L1', gid: po.shopifyId })]), '#PO330');
  record('accepted as 10 L, now 20 L in Shopify: flagged, needs a person', lineOf(o, 'L1')?.changedInShopify === true && o?.attention === true);
  // Code review, 5 Nov: a line a person settled here is not reopened by Shopify.
  const c = find(build([po], [row('SANTAL', '#PO330', 10, { line: 'L1', gid: po.shopifyId, status: 'cancelled' })]), '#PO330');
  record('the same edit on a CANCELLED line: not flagged, no attention', lineOf(c, 'L1')?.changedInShopify === false && c?.attention === false);
  const s = find(build([po], [row('SANTAL', '#PO330', 10, { line: 'L1', gid: po.shopifyId, status: 'received', rec: 4, closedShort: true })]), '#PO330');
  record('the same edit on a line CLOSED SHORT: not flagged', lineOf(s, 'L1')?.changedInShopify === false);
}
record('"PO" inside a word is not a PO number ("SUPPO12", "ESPO-7")', poDigits('SUPPO12') === null && poDigits('ESPO-7') === null);

console.log('\nOne Shopify line → a quantity (D1, the sale\'s rule)');
{
  const products = new Map([
    ['SA_1L_00029', { id: 'CAJU', category: 'OILS', unit: 'mL' }],
    ['SA_SP_00001', { id: 'SP', category: 'MACHINES_SPARES', unit: 'units', unitPerBox: 10 }],
    ['SA_RM_BOX12', { id: 'BOX', category: 'RAW_MATERIALS', unit: 'units', skuMultipliers: { SA_RM_BOX12: 12 } }],
    ['SA_RM_CAPS', { id: 'CAPS', category: 'RAW_MATERIALS', unit: 'units', unitPerBox: 6 }],
    ['SA_RM_00019', { id: 'ETH', category: 'RAW_MATERIALS', unit: 'mL' }],
    ['SA_RM_ETH_L', { id: 'ETH', category: 'RAW_MATERIALS', unit: 'mL', skuMultipliers: { SA_RM_ETH_L: 1000 } }],
    ['FRAG_ODD', { id: 'ODD', category: 'OILS', unit: 'mL' }],
  ]);
  const res = (sku, qty) => resolveLine({ totalQuantity: qty, inventoryItem: { variant: { sku } } }, products);
  record('an oil bottle: 100 × 1 L = 100,000 mL', res('SA_1L_00029', 100).qty === 100000 && res('SA_1L_00029', 100).bottleMl === 1000);
  record('a spare part is one each, whatever its box (as a sale)', res('SA_SP_00001', 3).qty === 3);
  record('a units product takes its SKU multiplier: 2 boxes of 12 = 24', res('SA_RM_BOX12', 2).qty === 24);
  record('… or its units per box when the SKU has none: 2 × 6 = 12', res('SA_RM_CAPS', 2).qty === 12);
  record('a raw material in mL with no multiplier is never guessed', !!res('SA_RM_00019', 400).reason && res('SA_RM_00019', 400).qty === undefined);
  record('… with one (1 L each): 400 = 400,000 mL', res('SA_RM_ETH_L', 400).qty === 400000);
  record('an oil code that is not a bottle size is refused', /not a known bottle size/.test(res('FRAG_ODD', 1).reason || ''));
  record('an unknown code is refused, with the code', /SA_XX_1/.test(res('SA_XX_1', 1).reason || ''));
}

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
