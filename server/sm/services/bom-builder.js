const { query } = require('../db')

// Lookup master attributes from DB (volume, oil%, container flags).
// Replaces hardcoded PRODUCT_TYPES — works with any user-defined master.
async function getMasterAttrs(productType, qFn) {
  const qry = qFn || query
  const r = await qry(
    `SELECT p.volume_ml, p.default_oil_pct, p.volume_unit,
            p.is_pure_oil, p.is_candle, p.container_name
     FROM products p
     WHERE p.product_code = $1 AND p.is_master = true
     LIMIT 1`,
    [productType]
  )
  const row = r.rows[0]
  return {
    volume: parseFloat(row?.volume_ml) || 0,
    volumeUnit: row?.volume_unit || 'ml',
    defaultOilPct: parseFloat(row?.default_oil_pct) || 25,
    isPureOil: row?.is_pure_oil || false,
    isCandle: row?.is_candle || false,
    containerCode: null,
    containerName: row?.container_name || null,
    found: !!row,
  }
}

async function buildLineComponents(orderId, line, lineInput, clientId, qFn) {
  const qry = qFn || query
  const productType = line.product_type
  const qty = parseInt(line.quantity)
  const oilPct = parseFloat(line.oil_pct) || 25
  const masterAttrs = await getMasterAttrs(productType, qry)
  const volume = masterAttrs.volume || parseFloat(lineInput.volume_ml) || 0
  const isPureOil = masterAttrs.isPureOil
  // Components from product_bom (general products like ethanol, fragrance, generic bottles) always
  // reserve from general_stock. Major Client client_stock substitutes are added later in the dedicated
  // client_product_bom loop below with source='client_stock'.
  const source = 'general_stock'

  // Unified BOM query — supports both general products (component_product_id) and client_stock entries (client_stock_id).
  const bomEntries = await qry(
    `SELECT pb.*,
            COALESCE(p.name, cs.product_name) as component_name,
            COALESCE(p.product_code, cs.product_code) as component_code,
            COALESCE(p.unit, cs.unit) as component_unit,
            p.category as component_category,
            p.client_id as component_client_id,
            cs.client_id as cs_client_id
     FROM product_bom pb
     LEFT JOIN products p ON pb.component_product_id = p.id
     LEFT JOIN client_stock cs ON pb.client_stock_id = cs.id
     WHERE pb.product_type = $1 AND pb.is_active = true
     ORDER BY pb.sort_order, pb.id`,
    [productType]
  )

  // Compute ethanol and fragrance quantities upfront so ready formula can substitute them.
  // A line's fragrance component is EITHER the legacy sm fragrance_id OR (D14)
  // a Fragrance Library oil_id — never both — so either one counts toward the formula.
  const ethanolQty = qty * volume * ((100 - oilPct) / 100)
  const fragQty = isPureOil ? qty * volume : qty * volume * (oilPct / 100)
  const hasFragranceComponent = !!(line.fragrance_id || line.oil_id)
  const totalFormula = ethanolQty + (hasFragranceComponent ? fragQty : 0)

  // Ready formula substitution — RF covers as much of totalFormula as it can; remainder
  // falls back to ethanol + fragrance. Mirror of /api/bom-preview so creation matches the
  // preview the user saw. BUG history (2026-05-28): this used to set rfUsed=totalFormula
  // blindly, which oversold RF and skipped ethanol/frag. Result: Start Production failed
  // with "Insufficient stock" and ethanol/oil were never reserved.
  let rfUsed = 0
  let rfScale = 1 // share of totalFormula NOT covered by RF — multiplies ethanol/frag qty
  if (lineInput.use_ready_formula && lineInput.ready_formula_id && totalFormula > 0) {
    const rfResult = await qry(`SELECT * FROM products WHERE id = $1`, [lineInput.ready_formula_id])
    if (rfResult.rows[0]) {
      const rfRow = rfResult.rows[0]
      const rfRaw = parseFloat(rfRow.current_stock) || 0
      const rfReservedRes = await qry(
        `SELECT COALESCE(SUM(quantity_reserved), 0) as reserved
         FROM stock_reservations
         WHERE product_id = $1 AND status = 'reserved'`,
        [rfRow.id]
      )
      const rfReserved = parseFloat(rfReservedRes.rows[0]?.reserved) || 0
      const rfAvail = Math.max(0, rfRaw - rfReserved)
      rfUsed = Math.min(rfAvail, totalFormula)
      rfScale = totalFormula > 0 ? (totalFormula - rfUsed) / totalFormula : 1
      if (rfUsed > 0) {
        await qry(
          `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'ml')`,
          [line.id, orderId, rfRow.id, rfRow.product_code, rfRow.name, 'general_stock', rfUsed]
        )
      }
    }
  }

  for (const entry of bomEntries.rows) {
    if (entry.component_group === 'packing' && !line.needs_packing) continue
    if (entry.component_group === 'labeling' && !line.needs_labeling) continue
    if (entry.component_group === 'labeling' && lineInput.label_client_label_id) continue

    const isEthanol = entry.quantity_formula === 'ethanol_pct'
    // RF fully covered the formula → skip ethanol entirely
    if (isEthanol && rfScale === 0) continue

    let qtyRequired = isEthanol
      ? qty * volume * ((100 - oilPct) / 100)
      : qty * parseFloat(entry.quantity_per_unit)

    // Scale ethanol down proportionally to whatever RF couldn't cover
    if (isEthanol && rfScale < 1) qtyRequired = qtyRequired * rfScale

    // Entry is client_stock (Major Client own components) — source='client_stock', use client_stock_id
    if (entry.client_stock_id) {
      await qry(
        `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit, client_stock_id)
         VALUES ($1,$2,NULL,$3,$4,'client_stock',$5,$6,$7)`,
        [line.id, orderId, entry.component_code, entry.component_name, qtyRequired, entry.component_unit || 'units', entry.client_stock_id]
      )
    } else {
      // Entry is general product (default)
      await qry(
        `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit)
         VALUES ($1,$2,$3,$4,$5,'general_stock',$6,$7)`,
        [line.id, orderId, entry.component_product_id, entry.component_code, entry.component_name, qtyRequired, entry.component_unit || 'units']
      )
    }
  }

  if (line.fragrance_id) {
    const frag = await qry(`SELECT * FROM products WHERE id = $1`, [line.fragrance_id])
    if (frag.rows[0]) {
      const adjFragQty = rfUsed >= totalFormula ? 0 : fragQty * rfScale
      if (adjFragQty > 0) {
        await qry(
          `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'ml')`,
          [line.id, orderId, frag.rows[0].id, frag.rows[0].product_code, frag.rows[0].name, source, adjFragQty]
        )
      }
    }
  }

  // D14 Fragrance Library: the oil component comes straight from the Cold
  // Room (sa.products) instead of a separate sm fragrance record. No
  // production_order_components/stock_reservations row — Fragrance Library
  // consumption is a direct debit at production start (D14.6), never
  // reserved. The computed mL is stored on the line itself so start-time
  // debits exactly what the user saw in the order-creation preview, instead
  // of re-deriving ready-formula scaling against a possibly-different stock
  // level later.
  if (line.oil_id) {
    const adjOilQty = rfUsed >= totalFormula ? 0 : fragQty * rfScale
    await qry(`UPDATE production_order_lines SET oil_qty_ml = $1 WHERE id = $2`, [adjOilQty, line.id])
  }

  if (line.needs_packing && lineInput.packaging_component_id) {
    const pkg = await qry(`SELECT * FROM products WHERE id = $1`, [lineInput.packaging_component_id])
    if (pkg.rows[0]) {
      await qry(
        `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'units')`,
        [line.id, orderId, pkg.rows[0].id, pkg.rows[0].product_code, pkg.rows[0].name, source, qty]
      )
    }
  }

  if (lineInput.label_client_label_id) {
    const lbl = await qry(`SELECT * FROM client_labels WHERE id = $1`, [lineInput.label_client_label_id])
    if (lbl.rows[0]) {
      await qry(
        `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit)
         VALUES ($1,$2,NULL,NULL,$3,'client_label',$4,'units')`,
        [line.id, orderId, lbl.rows[0].label_name, qty]
      )
    }
  }

  // Legacy client_product_bom loop — DEPRECATED. Data is now in product_bom (with client_stock_id).
  // Migration on startup moves data over. This block intentionally disabled to avoid double-insertion.
  if (false && lineInput.use_client_stock && clientId) {
    const clientBom = await qry(
      `SELECT cpb.client_stock_id, cpb.quantity_per_unit, cpb.unit as bom_unit,
              cs.product_name as cs_name, cs.product_code as cs_code, cs.unit as cs_unit, cs.client_id
       FROM client_product_bom cpb
       JOIN client_stock cs ON cpb.client_stock_id = cs.id
       JOIN products p ON cpb.product_id = p.id
       WHERE p.client_id = $1 AND cpb.client_stock_id IS NOT NULL`,
      [clientId]
    )
    for (const bom of clientBom.rows) {
      await qry(
        `INSERT INTO production_order_components (production_order_line_id, production_order_id, product_id, product_code, product_name, source, quantity_required, unit, client_stock_id)
         VALUES ($1,$2,NULL,$3,$4,'client_stock',$5,$6,$7)`,
        [line.id, orderId, bom.cs_code, bom.cs_name, parseFloat(bom.quantity_per_unit) * qty, bom.bom_unit || bom.cs_unit || 'units', bom.client_stock_id]
      )
    }
  }
}

// D16 (MUSE make-to-order): compute the full BOM to DEDUCT when a finished-good
// variant is sold on Shopify WITHOUT a production order. Read-only — returns the
// oil (from the shared Fragrance Library) + the sm materials (ethanol + packaging)
// to debit. A variant qualifies as make-to-order only when it has an oil_id AND
// its master defines a BOM; otherwise the caller keeps the legacy finished-good
// stock deduction (D13). Mirrors buildLineComponents' formula so the numbers match
// what a production order would have consumed.
async function computeFinishedGoodBom(tq, variantId, qty) {
  const qFn = tq || query
  const q = parseInt(qty)
  const vr = await qFn(
    `SELECT v.id, v.oil_id, v.default_oil_pct AS v_oil_pct, v.volume_ml AS v_volume,
            m.product_code AS master_code, m.volume_ml AS m_volume, m.default_oil_pct AS m_oil_pct, m.is_pure_oil
     FROM products v LEFT JOIN products m ON m.id = v.master_product_id
     WHERE v.id = $1`,
    [variantId]
  )
  const v = vr.rows[0]
  if (!v || !v.oil_id || !(q > 0)) return { makeToOrder: false }

  const volume = parseFloat(v.v_volume) || parseFloat(v.m_volume) || 0
  const oilPct = parseFloat(v.v_oil_pct) || parseFloat(v.m_oil_pct) || 25
  if (!volume) return { makeToOrder: false }

  const bom = await qFn(
    `SELECT pb.quantity_formula, pb.quantity_per_unit, p.id AS product_id, p.product_code, p.name, p.unit
     FROM product_bom pb JOIN products p ON p.id = pb.component_product_id
     WHERE pb.product_type = $1 AND pb.is_active = true
     ORDER BY pb.sort_order, pb.id`,
    [v.master_code]
  )
  if (!bom.rows.length) return { makeToOrder: false } // master has no BOM → not make-to-order

  const oilMl = v.is_pure_oil ? q * volume : q * volume * (oilPct / 100)
  const materials = []
  for (const e of bom.rows) {
    const isEthanol = e.quantity_formula === 'ethanol_pct'
    const amount = isEthanol
      ? q * volume * ((100 - oilPct) / 100)
      : q * parseFloat(e.quantity_per_unit)
    materials.push({
      product_id: e.product_id, product_code: e.product_code, product_name: e.name,
      qty: amount, unit: e.unit || (isEthanol ? 'ml' : 'units'), is_ethanol: isEthanol,
    })
  }
  return { makeToOrder: true, oil: { oil_id: v.oil_id, ml: oilMl }, materials }
}

// Backwards-compat wrapper — returns just the volume number (sync-style usage broken,
// but callers should migrate to getMasterAttrs which is async).
async function getProductVolume(productType, qFn) {
  const attrs = await getMasterAttrs(productType, qFn)
  return attrs.volume
}

module.exports = { buildLineComponents, getMasterAttrs, getProductVolume, computeFinishedGoodBom }
