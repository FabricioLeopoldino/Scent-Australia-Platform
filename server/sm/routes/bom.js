const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth, auditLog } = require('../auth')
const { getMasterAttrs } = require('../services/bom-builder')

async function getBomCurrentVersion(productType) {
  const r = await query(`SELECT MAX(version) as v FROM product_bom_history WHERE product_type = $1`, [productType])
  return parseInt(r.rows[0]?.v || 0)
}

async function saveBomSnapshot(productType, action, userId) {
  const newVersion = (await getBomCurrentVersion(productType)) + 1
  const snap = await query(
    `SELECT pb.id, pb.component_product_id, pb.quantity_formula, pb.quantity_per_unit, pb.sort_order, pb.component_group,
            p.name as component_name, p.product_code as component_code, p.unit as component_unit, p.category as component_category
     FROM product_bom pb
     JOIN products p ON pb.component_product_id = p.id
     WHERE pb.product_type = $1 AND pb.is_active = true
     ORDER BY pb.sort_order, pb.id`,
    [productType]
  )
  await query(
    `INSERT INTO product_bom_history (product_type, version, action, changed_by, snapshot) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [productType, newVersion, action, userId ? parseInt(userId) : null, JSON.stringify(snap.rows)]
  )
  return newVersion
}

router.get('/bom-rules', auth, async (req, res) => {
  try {
    res.json((await query(`SELECT * FROM bom_rules ORDER BY product_type, component_type`)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/bom-rules/:id', auth, async (req, res) => {
  try {
    const { quantity_per_unit } = req.body
    if (quantity_per_unit == null || isNaN(parseFloat(quantity_per_unit))) return res.status(400).json({ error: 'Invalid quantity' })
    const result = await query(`UPDATE bom_rules SET quantity_per_unit = $1 WHERE id = $2 RETURNING *`, [parseFloat(quantity_per_unit), req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Rule not found' })
    await auditLog(req.user.id, 'bom_rule_updated', 'bom_rule', parseInt(req.params.id), null, { quantity_per_unit })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/bom-preview', auth, async (req, res) => {
  try {
    const { lines } = req.body
    const result = []

    // Build map of total reserved qty per product_id across all active reservations
    const reservedRows = await query(
      `SELECT product_id, SUM(quantity_reserved) as total_reserved
       FROM stock_reservations WHERE status = 'reserved' AND product_id IS NOT NULL
       GROUP BY product_id`
    )
    const reservedMap = {}
    for (const r of reservedRows.rows) reservedMap[r.product_id] = parseFloat(r.total_reserved) || 0

    for (const line of lines) {
      const { product_type, fragrance_id, oil_id, oil_pct, quantity, volume_ml: volOverride, label_client_label_id, use_client_stock, is_large_client, client_id, needs_packing, needs_labeling, use_ready_formula, ready_formula_id } = line
      const qty = parseInt(quantity) || 0
      const oilPct = parseFloat(oil_pct) || 25
      const masterAttrs = await getMasterAttrs(product_type)
      const volume = masterAttrs.volume || parseFloat(volOverride) || 0
      const isPureOil = masterAttrs.isPureOil
      const components = []

      if (qty > 0) {
        let ethanolEntry = null

        const bomEntries = await query(
          `SELECT pb.*, p.name as component_name, p.product_code as component_code, p.unit as component_unit, p.current_stock as component_stock, p.category as component_category, p.client_id as component_client_id
           FROM product_bom pb
           JOIN products p ON pb.component_product_id = p.id
           WHERE pb.product_type = $1 AND pb.is_active = true
           ORDER BY pb.sort_order, pb.id`,
          [product_type]
        )
        for (const entry of bomEntries.rows) {
          if (entry.component_group === 'packing' && !needs_packing) continue
          if (entry.component_group === 'labeling' && !needs_labeling) continue
          if (entry.component_group === 'labeling' && label_client_label_id) continue
          if (is_large_client && entry.component_category === 'COMPONENT' && !entry.component_client_id) continue
          const qtyRequired = entry.quantity_formula === 'ethanol_pct'
            ? qty * volume * ((100 - oilPct) / 100)
            : qty * parseFloat(entry.quantity_per_unit)
          const rawStock = parseFloat(entry.component_stock)
          const comp = {
            product_id: entry.component_product_id,
            product_code: entry.component_code,
            product_name: entry.component_name,
            source: 'general_stock',
            quantity_required: qtyRequired,
            current_stock: rawStock,
            available_stock: Math.max(0, rawStock - (reservedMap[entry.component_product_id] || 0)),
            unit: entry.component_unit || 'units',
            _is_ethanol: entry.quantity_formula === 'ethanol_pct',
          }
          components.push(comp)
          if (entry.quantity_formula === 'ethanol_pct') ethanolEntry = comp
        }

        let fragEntry = null
        if (fragrance_id) {
          const fragQty = isPureOil ? qty * volume : qty * volume * (oilPct / 100)
          const p = await query(`SELECT id, product_code, name, current_stock FROM products WHERE id = $1`, [fragrance_id])
          if (p.rows[0]) {
            const fragRaw = parseFloat(p.rows[0].current_stock)
            fragEntry = {
              product_id: p.rows[0].id,
              product_code: p.rows[0].product_code,
              product_name: p.rows[0].name,
              source: 'general_stock',
              quantity_required: fragQty,
              current_stock: fragRaw,
              available_stock: Math.max(0, fragRaw - (reservedMap[p.rows[0].id] || 0)),
              unit: 'ml',
              _is_fragrance: true,
            }
            components.push(fragEntry)
          }
        }

        // D14 Fragrance Library oil (picked instead of a legacy fragrance_id).
        // Show it in the preview — same mL formula as a fragrance — even though it
        // is debited from sa.products at start and not reserved (D14.6). Marked
        // source='fragrance_library' so the UI can label it accordingly.
        if (!fragrance_id && oil_id) {
          const oilQty = isPureOil ? qty * volume : qty * volume * (oilPct / 100)
          const oilRow = await query(`SELECT id, "productCode" AS product_code, name, "currentStock" AS current_stock FROM sa.products WHERE id = $1`, [oil_id])
          if (oilRow.rows[0]) {
            const oilRaw = parseFloat(oilRow.rows[0].current_stock)
            fragEntry = {
              product_id: null,
              product_code: oilRow.rows[0].product_code,
              product_name: oilRow.rows[0].name,
              source: 'fragrance_library',
              quantity_required: oilQty,
              current_stock: oilRaw,
              available_stock: oilRaw, // Library oil is never reserved (debited at start)
              unit: 'ml',
              _is_fragrance: true,
              _is_oil: true,
            }
            components.push(fragEntry)
          }
        }

        if (use_ready_formula && ready_formula_id && (ethanolEntry || fragEntry)) {
          const rfRow = await query(`SELECT id, product_code, name, current_stock FROM products WHERE id = $1`, [ready_formula_id])
          if (rfRow.rows[0]) {
            const rfRaw = parseFloat(rfRow.rows[0].current_stock)
            const rfAvail = Math.max(0, rfRaw - (reservedMap[rfRow.rows[0].id] || 0))
            const totalFormula = (ethanolEntry?.quantity_required || 0) + (fragEntry?.quantity_required || 0)
            const rfUsed = Math.min(rfAvail, totalFormula)
            const rfComp = {
              product_id: rfRow.rows[0].id,
              product_code: rfRow.rows[0].product_code,
              product_name: rfRow.rows[0].name,
              source: 'general_stock',
              quantity_required: rfUsed,
              current_stock: rfRaw,
              available_stock: rfAvail,
              unit: 'ml',
              _is_ready_formula: true,
            }
            if (rfAvail >= totalFormula) {
              if (ethanolEntry) components.splice(components.indexOf(ethanolEntry), 1)
              if (fragEntry) components.splice(components.indexOf(fragEntry), 1)
            } else {
              const remaining = totalFormula - rfAvail
              const scale = remaining / totalFormula
              if (ethanolEntry) { ethanolEntry.quantity_required = ethanolEntry.quantity_required * scale; ethanolEntry.product_name += ' (top-up only)' }
              if (fragEntry) { fragEntry.quantity_required = fragEntry.quantity_required * scale; fragEntry.product_name += ' (top-up only)' }
            }
            components.unshift(rfComp)
          }
        }

        if (is_large_client && client_id) {
          const cs = await query(`SELECT * FROM client_stock WHERE client_id = $1 ORDER BY category, product_name`, [client_id])
          for (const item of cs.rows) {
            components.push({
              product_id: null, product_code: item.product_code, product_name: item.product_name,
              source: 'client_stock', quantity_required: qty, current_stock: parseFloat(item.quantity),
              unit: item.unit || 'units', is_client_provided: true,
            })
          }
        }
      }

      if (label_client_label_id) {
        const l = await query(`SELECT * FROM client_labels WHERE id = $1`, [label_client_label_id])
        if (l.rows[0]) components.push({ product_id: null, label_id: l.rows[0].id, product_name: `${l.rows[0].label_name} ${l.rows[0].artwork_version}`, source: 'client_label', quantity_required: parseInt(quantity) || 0, current_stock: parseInt(l.rows[0].quantity), unit: 'units' })
      }

      result.push(components)
    }
    res.json(result)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/product-bom/:productType', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT pb.*,
              COALESCE(p.name, cs.product_name) as component_name,
              COALESCE(p.product_code, cs.product_code) as component_code,
              COALESCE(p.unit, cs.unit) as component_unit,
              COALESCE(p.current_stock, cs.quantity) as component_stock,
              COALESCE(p.category, 'CLIENT_STOCK') as component_category,
              CASE WHEN pb.client_stock_id IS NOT NULL THEN 'client_stock' ELSE 'general' END as source_kind,
              cs.client_id as cs_client_id
       FROM product_bom pb
       LEFT JOIN products p ON pb.component_product_id = p.id
       LEFT JOIN client_stock cs ON pb.client_stock_id = cs.id
       WHERE pb.product_type = $1 AND pb.is_active = true
       ORDER BY pb.sort_order, pb.id`,
      [req.params.productType]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/product-bom/:productType/history', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT pbh.*, u.name as changed_by_name FROM product_bom_history pbh LEFT JOIN users u ON pbh.changed_by = u.id WHERE pbh.product_type = $1 ORDER BY pbh.version DESC`,
      [req.params.productType]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/product-bom/:productType/rollback', auth, async (req, res) => {
  try {
    const { version } = req.body
    if (!version) return res.status(400).json({ error: 'version required' })
    const hist = await query(`SELECT * FROM product_bom_history WHERE product_type = $1 AND version = $2`, [req.params.productType, version])
    if (!hist.rows[0]) return res.status(404).json({ error: 'Version not found' })
    const snapshot = typeof hist.rows[0].snapshot === 'string' ? JSON.parse(hist.rows[0].snapshot) : hist.rows[0].snapshot
    await query(`UPDATE product_bom SET is_active = false WHERE product_type = $1 AND is_active = true`, [req.params.productType])
    for (const comp of (snapshot || [])) {
      await query(
        `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (product_type, component_product_id) DO UPDATE
           SET quantity_formula = EXCLUDED.quantity_formula, quantity_per_unit = EXCLUDED.quantity_per_unit,
               sort_order = EXCLUDED.sort_order, component_group = EXCLUDED.component_group, is_active = true`,
        [req.params.productType, comp.component_product_id, comp.quantity_formula || 'fixed', comp.quantity_per_unit, comp.sort_order || 0, comp.component_group || 'core']
      )
    }
    await saveBomSnapshot(req.params.productType, `rollback_v${version}`, req.user.id)
    const updated = await query(
      `SELECT pb.*, p.name as component_name, p.product_code as component_code, p.unit as component_unit, p.current_stock as component_stock, p.category as component_category
       FROM product_bom pb JOIN products p ON pb.component_product_id = p.id
       WHERE pb.product_type = $1 AND pb.is_active = true ORDER BY pb.sort_order, pb.id`,
      [req.params.productType]
    )
    res.json(updated.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/product-bom', auth, async (req, res) => {
  try {
    const { product_type, component_product_id, client_stock_id, quantity_formula, quantity_per_unit, sort_order, component_group } = req.body
    if (!product_type) return res.status(400).json({ error: 'product_type required' })
    if (!component_product_id && !client_stock_id) return res.status(400).json({ error: 'Either component_product_id or client_stock_id required' })
    if (component_product_id && client_stock_id) return res.status(400).json({ error: 'Pick one — general product OR client stock, not both' })

    // Check for existing row (by product_id OR client_stock_id depending on which is provided)
    let existing
    if (component_product_id) {
      existing = await query(`SELECT id FROM product_bom WHERE product_type = $1 AND component_product_id = $2`, [product_type, component_product_id])
    } else {
      existing = await query(`SELECT id FROM product_bom WHERE product_type = $1 AND client_stock_id = $2`, [product_type, client_stock_id])
    }

    let result
    if (existing.rows[0]) {
      result = await query(
        `UPDATE product_bom SET quantity_formula = $1, quantity_per_unit = $2, sort_order = $3, component_group = $4, is_active = true WHERE id = $5 RETURNING *`,
        [quantity_formula || 'fixed', parseFloat(quantity_per_unit) || 1, sort_order || 0, component_group || 'core', existing.rows[0].id]
      )
    } else {
      result = await query(
        `INSERT INTO product_bom (product_type, component_product_id, client_stock_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
        [product_type, component_product_id || null, client_stock_id || null, quantity_formula || 'fixed', parseFloat(quantity_per_unit) || 1, sort_order || 0, component_group || 'core']
      )
    }
    await saveBomSnapshot(product_type, 'add', req.user.id)
    let entityName
    if (component_product_id) {
      const compProd = await query(`SELECT name FROM products WHERE id = $1`, [component_product_id])
      entityName = compProd.rows[0]?.name || String(component_product_id)
    } else {
      const csRow = await query(`SELECT product_name FROM client_stock WHERE id = $1`, [client_stock_id])
      entityName = csRow.rows[0]?.product_name || String(client_stock_id)
    }
    await auditLog(req.user.id, 'product_bom_added', 'product_bom', result.rows[0].id, entityName, { product_type, source: client_stock_id ? 'client_stock' : 'general' })
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/product-bom/:id', auth, async (req, res) => {
  try {
    const { quantity_formula, quantity_per_unit, sort_order, component_group } = req.body
    const result = await query(
      `UPDATE product_bom SET quantity_formula = COALESCE($1, quantity_formula), quantity_per_unit = COALESCE($2, quantity_per_unit), sort_order = COALESCE($3, sort_order), component_group = COALESCE($4, component_group) WHERE id = $5 RETURNING *`,
      [quantity_formula, quantity_per_unit != null ? parseFloat(quantity_per_unit) : null, sort_order, component_group || null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    await saveBomSnapshot(result.rows[0].product_type, 'edit', req.user.id)
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/product-bom/:id', auth, async (req, res) => {
  try {
    const row = await query(`SELECT product_type FROM product_bom WHERE id = $1`, [req.params.id])
    const productType = row.rows[0]?.product_type
    await query(`UPDATE product_bom SET is_active = false WHERE id = $1`, [req.params.id])
    if (productType) await saveBomSnapshot(productType, 'delete', req.user.id)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
