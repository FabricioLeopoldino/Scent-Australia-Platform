import * as XLSX from 'xlsx';

// Helper functions for consistent formatting
const getCategoryLabel = (category) => {
  const labels = {
    'OILS': 'Oils',
    'MACHINES_SPARES': 'Spares',
    'RAW_MATERIALS': 'Raw Materials',
    'SCENT_MACHINES': 'Diffuser Machines',
    'SA_SCENTED_PRODUCTS': 'Scented Products'
  };
  return labels[category] || category;
};

const getTransactionTypeLabel = (type) => {
  const labels = {
    'add': 'Add Stock',
    'remove': 'Remove Stock',
    'return': 'Return to Stock',
    'incoming': 'Incoming Order',
    'adjust': 'Adjustment',
    'shopify_sale': 'Shopify Sale',
    'shopify_reversal': 'Shopify Sale (reversed)',
    // D14 Fragrance Library
    'muse_production': 'MUSE Production',
    'muse_reversal': 'MUSE Production (reversed)',
    'sm_std_production': 'SM-Standard Production',
    'sm_std_reversal': 'SM-Standard Production (reversed)',
    'sm_major_production': 'SM-Major Production',
    'sm_major_reversal': 'SM-Major Production (reversed)',
  };
  return labels[type] || type;
};

export function exportProductsToExcel(products, allAliases = []) {
  // Build a map: product_id -> alias names array
  const aliasMap = {};
  allAliases.forEach(a => {
    if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
    aliasMap[a.product_id].push(a.alias_name);
  });

  // Prepare data for export
  const data = products.map(product => ({
    'Tag': product.tag,
    'Product Code': product.productCode,
    'Name': product.name,
    'Status': product.status === 'inactive' ? 'Inactive' : 'Active',
    'Aliases': (aliasMap[product.id] || []).join(', ') || '-',
    'Category': getCategoryLabel(product.category),
    'Sub Category': product.sub_category || '-',
    'Color': product.color || '-',
    'Location': product.location || '-',
    'Bin Location': product.bin_location || '-',
    'Current Stock': product.currentStock,
    'Unit': product.unit,
    'Stock (Boxes)': product.stockBoxes || '-',
    'Units Per Box': product.unitPerBox || '-',
    'Min Stock Level': product.minStockLevel,
    'Supplier': product.supplier || '-',
    'Supplier Code': product.supplier_code || '-',
    'Shopify SKUs': Object.keys(product.shopifySkus || {}).join(', ') || '-',
    'Created At': product.createdAt ? new Date(product.createdAt).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-'
  }));

  // Create worksheet
  const ws = XLSX.utils.json_to_sheet(data);

  // Set column widths
  ws['!cols'] = [
    { wch: 15 }, // Tag
    { wch: 15 }, // Product Code
    { wch: 40 }, // Name
    { wch: 10 }, // Status
    { wch: 35 }, // Aliases
    { wch: 20 }, // Category
    { wch: 15 }, // Sub Category
    { wch: 10 }, // Color
    { wch: 15 }, // Location
    { wch: 30 }, // Bin Location
    { wch: 12 }, // Current Stock
    { wch: 8 },  // Unit
    { wch: 12 }, // Stock (Boxes)
    { wch: 12 }, // Units Per Box
    { wch: 15 }, // Min Stock Level
    { wch: 20 }, // Supplier
    { wch: 15 }, // Supplier Code
    { wch: 30 }, // Shopify SKUs
    { wch: 12 }  // Created At
  ];

  // Create workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  // Generate filename with timestamp
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `Products_Export_${timestamp}.xlsx`;

  // Download file
  XLSX.writeFile(wb, filename);
}

export function exportTransactionsToExcel(transactions, periodLabel = '') {
  // Prepare data for export
  const data = transactions.map(tx => ({
    'Transaction ID': tx.id,
    'Date': new Date(tx.created_at || tx.createdAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    'Product Code': tx.product_code || tx.productCode || '-',
    'Product Name': tx.product_name || tx.productName || '-',
    'Category': getCategoryLabel(tx.category),
    'Type': getTransactionTypeLabel(tx.type),
    'Quantity': tx.quantity,
    'Unit': tx.unit,
    'Balance After': tx.balance_after || tx.balanceAfter || '-',
    'Notes': tx.notes || '-',
    'Shopify Order': tx.shopify_order_id || tx.shopifyOrderId || '-'
  }));

  // Create worksheet
  const ws = XLSX.utils.json_to_sheet(data);
  
  // Set column widths
  ws['!cols'] = [
    { wch: 12 }, // Transaction ID
    { wch: 18 }, // Date
    { wch: 15 }, // Product Code
    { wch: 30 }, // Product Name
    { wch: 20 }, // Category
    { wch: 18 }, // Type
    { wch: 10 }, // Quantity
    { wch: 8 },  // Unit
    { wch: 12 }, // Balance After
    { wch: 40 }, // Notes
    { wch: 15 }  // Shopify Order
  ];

  // Create workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

  // Generate filename with period label
  const timestamp = new Date().toISOString().split('T')[0];
  const period = periodLabel ? `_${periodLabel}` : '';
  const filename = `Transactions${period}_${timestamp}.xlsx`;

  // Download file
  XLSX.writeFile(wb, filename);
}

export function exportFullDatabaseToExcel(products, transactions) {
  const wb = XLSX.utils.book_new();

  // Products sheet
  const productsData = products.map(product => ({
    'Tag': product.tag,
    'Product Code': product.productCode,
    'Name': product.name,
    'Status': product.status === 'inactive' ? 'Inactive' : 'Active',
    'Category': getCategoryLabel(product.category),
    'Sub Category': product.sub_category || '-',
    'Color': product.color || '-',
    'Location': product.location || '-',
    'Bin Location': product.bin_location || '-',
    'Current Stock': product.currentStock,
    'Unit': product.unit,
    'Stock (Boxes)': product.stockBoxes || '-',
    'Units Per Box': product.unitPerBox || '-',
    'Min Stock Level': product.minStockLevel,
    'Supplier': product.supplier || '-',
    'Supplier Code': product.supplier_code || '-',
    'Shopify SKUs': Object.keys(product.shopifySkus || {}).join(', ') || '-'
  }));
  const wsProducts = XLSX.utils.json_to_sheet(productsData);
  wsProducts['!cols'] = [
    { wch: 15 }, { wch: 15 }, { wch: 40 }, { wch: 10 }, { wch: 20 },
    { wch: 15 }, { wch: 10 }, { wch: 15 }, { wch: 30 }, { wch: 12 },
    { wch: 8 },  { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 20 },
    { wch: 15 }, { wch: 30 }
  ];
  XLSX.utils.book_append_sheet(wb, wsProducts, 'Products');

  // Transactions sheet
  const transactionsData = transactions.map(tx => ({
    'ID': tx.id,
    'Date': new Date(tx.created_at || tx.createdAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    'Product Code': tx.product_code || tx.productCode || '-',
    'Product Name': tx.product_name || tx.productName || '-',
    'Category': getCategoryLabel(tx.category),
    'Type': getTransactionTypeLabel(tx.type),
    'Quantity': tx.quantity,
    'Unit': tx.unit,
    'Balance After': tx.balance_after || tx.balanceAfter || '-',
    'Notes': tx.notes || '-',
    'Shopify Order': tx.shopify_order_id || tx.shopifyOrderId || '-'
  }));
  const wsTransactions = XLSX.utils.json_to_sheet(transactionsData);
  wsTransactions['!cols'] = [
    { wch: 12 }, { wch: 18 }, { wch: 15 }, { wch: 30 }, { wch: 20 },
    { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 40 }, { wch: 15 }
  ];
  XLSX.utils.book_append_sheet(wb, wsTransactions, 'Transactions');

  // SKU Mappings sheet
  const skuMappings = [];
  products.forEach(product => {
    if (product.shopifySkus && Object.keys(product.shopifySkus).length > 0) {
      Object.entries(product.shopifySkus).forEach(([variant, sku]) => {
        skuMappings.push({
          'Product Code': product.productCode,
          'Product Name': product.name,
          'Category': getCategoryLabel(product.category),
          'Variant': variant,
          'Shopify SKU': sku
        });
      });
    }
  });
  
  if (skuMappings.length > 0) {
    const wsSKU = XLSX.utils.json_to_sheet(skuMappings);
    wsSKU['!cols'] = [
      { wch: 15 }, { wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, wsSKU, 'SKU Mappings');
  }

  // Generate filename with timestamp
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `Full_Database_Export_${timestamp}.xlsx`;

  // Download file
  XLSX.writeFile(wb, filename);
}

// ═══════════════════════════════════════════════════════════════════════
// D15 — cross-company shared-oil usage report (Fragrance Library, D14).
// `transactions` must already be filtered to category=OILS for the chosen
// date range (the caller pages through /api/transactions, which caps each
// request at 5000 rows).
//
// `quantity` is always stored as a positive magnitude in sa.transactions —
// direction and the responsible business come from `type` alone. Every
// business debit type has a matching reversal type (mirrors D14's
// SEGMENT_MAP shape); the reversal nets against that SAME business's "used"
// total rather than counting as generic replenishment, so a cancelled
// production isn't double-counted as both "used" and "replenished".
// ═══════════════════════════════════════════════════════════════════════
const OIL_TX_TYPE_INFO = {
  // Generic stock movements — SA is the actor, no reversal counterpart to net
  add:      { company: 'SA', sign: 1,  bucket: 'replenished' },
  incoming: { company: 'SA', sign: 1,  bucket: 'replenished' },
  return:   { company: 'SA', sign: 1,  bucket: 'replenished' },
  remove:   { company: 'SA', sign: -1, bucket: 'used' },
  adjust:   { company: 'SA', sign: -1, bucket: 'used' }, // reserved type, never actually inserted (verified 2026-07-16)

  // SA's own Shopify store
  shopify_sale:     { company: 'SA', sign: -1, bucket: 'used' },
  shopify_reversal: { company: 'SA', sign: 1,  bucket: 'used' },

  // D14 Fragrance Library consumption — the 4-bucket model
  muse_production:     { company: 'MUSE',        sign: -1, bucket: 'used' },
  muse_reversal:       { company: 'MUSE',        sign: 1,  bucket: 'used' },
  sm_std_production:   { company: 'SM-Standard', sign: -1, bucket: 'used' },
  sm_std_reversal:     { company: 'SM-Standard', sign: 1,  bucket: 'used' },
  sm_major_production: { company: 'SM-Major',    sign: -1, bucket: 'used' },
  sm_major_reversal:   { company: 'SM-Major',    sign: 1,  bucket: 'used' },

  // Legacy D10 SA↔SM transfer (retired for oils by D14; kept for any
  // historical rows) — SA is the send/cancel side
  transfer_out:           { company: 'SA', sign: -1, bucket: 'used' },
  transfer_cancel_return: { company: 'SA', sign: 1,  bucket: 'used' },

  // Tech stock / ready formula — not expected on OILS in practice, classified
  // defensively so the export never silently drops a row
  tech_transfer_out:     { company: 'SA', sign: -1, bucket: 'used' },
  tech_transfer_in:      { company: 'SA', sign: 1,  bucket: 'used' },
  tech_remove:           { company: 'SA', sign: -1, bucket: 'used' },
  tech_return_from_tech: { company: 'SA', sign: 1,  bucket: 'used' },
  tech_return_to_main:   { company: 'SA', sign: 1,  bucket: 'used' },
  tech_return_input:     { company: 'SA', sign: 1,  bucket: 'used' },
  formula_ready_used:     { company: 'SA', sign: -1, bucket: 'used' },
  formula_ready_restored: { company: 'SA', sign: 1,  bucket: 'used' },
};

function classifyOilTx(type) {
  return OIL_TX_TYPE_INFO[type] || { company: 'SA', sign: -1, bucket: 'used' };
}

function extractOrderRef(notes) {
  if (!notes) return '-';
  const hash = notes.match(/#(\S+)/);
  if (hash) return `#${hash[1]}`;
  const smOrder = notes.match(/\b(SM-\d+)\b/);
  if (smOrder) return smOrder[1];
  return '-';
}

// Pure builder — all the report's arithmetic, no file I/O, so the regression
// gate can assert the numbers directly (`scripts/regression-sa.js`).
// Returns { summaryRows, detailRows }.
export function buildOilUsageSheets(transactions) {
  // Group by oil — needed to find each oil's own opening/closing balance.
  const byOil = {};
  for (const tx of transactions) {
    const key = tx.product_id;
    if (!byOil[key]) byOil[key] = { code: tx.product_code, name: tx.product_name, rows: [] };
    byOil[key].rows.push(tx);
  }

  const summaryRows = [];
  const detailRows = [];

  Object.values(byOil).forEach((oil) => {
    // Chronological order per oil — needed to find the period's opening
    // (before its first movement) and closing (after its last movement).
    const rows = [...oil.rows].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return ta !== tb ? ta - tb : (a.id || 0) - (b.id || 0);
    });

    let replenished = 0;
    const used = { MUSE: 0, 'SM-Standard': 0, 'SM-Major': 0, SA: 0 };

    rows.forEach((tx) => {
      const info = classifyOilTx(tx.type);
      const qty = parseFloat(tx.quantity) || 0;
      const after = parseFloat(tx.balance_after) || 0;
      const before = after - info.sign * qty;

      if (info.bucket === 'replenished') {
        replenished += qty;
      } else {
        used[info.company] -= info.sign * qty; // production(-1) adds to "used"; reversal(+1) nets it back down
      }

      detailRows.push({
        'Date': new Date(tx.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        'Oil Code': oil.code,
        'Oil Name': oil.name,
        'Company': info.company,
        'Movement': getTransactionTypeLabel(tx.type),
        'Quantity': qty,
        'Unit': tx.unit,
        'Before': before,
        'After': after,
        'Order #': extractOrderRef(tx.notes),
        'Notes': tx.notes || '-',
      });
    });

    const opening = rows.length ? parseFloat(rows[0].balance_after) - classifyOilTx(rows[0].type).sign * (parseFloat(rows[0].quantity) || 0) : 0;
    const closing = rows.length ? parseFloat(rows[rows.length - 1].balance_after) : 0;

    summaryRows.push({
      'Oil': oil.name,
      'Oil Code': oil.code,
      'Opening Stock': opening,
      'Replenished (+)': replenished,
      'MUSE Used': used.MUSE,
      'SM-Standard Used': used['SM-Standard'],
      'SM-Major Used': used['SM-Major'],
      'SA Used': used.SA,
      'Closing Stock': closing,
    });
  });

  summaryRows.sort((a, b) => a['Oil'].localeCompare(b['Oil']));
  detailRows.sort((a, b) => a['Oil Name'].localeCompare(b['Oil Name']));

  return { summaryRows, detailRows };
}

export function exportOilUsageToExcel(transactions, periodLabel = '') {
  const { summaryRows, detailRows } = buildOilUsageSheets(transactions);

  const wb = XLSX.utils.book_new();

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [
    { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 },
    { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  const wsDetail = XLSX.utils.json_to_sheet(detailRows);
  wsDetail['!cols'] = [
    { wch: 18 }, { wch: 14 }, { wch: 30 }, { wch: 14 }, { wch: 18 },
    { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 40 }
  ];
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Detail');

  const timestamp = new Date().toISOString().split('T')[0];
  const period = periodLabel ? `_${periodLabel}` : '';
  const filename = `Oil_Usage${period}_${timestamp}.xlsx`;

  XLSX.writeFile(wb, filename);
}
