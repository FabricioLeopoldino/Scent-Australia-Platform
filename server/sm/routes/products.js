const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth, requireRole, auditLog, requireUploads } = require('../auth')

router.get('/products', auth, async (req, res) => {
  try {
    const { category, search, client_id, has_attachments, include_archived } = req.query
    let q = `
      SELECT p.*, s.name as supplier_name,
        COALESCE(r.reserved_qty, 0) as reserved_qty,
        COALESCE(r.reservation_detail, '[]'::json) as reservation_detail,
        COALESCE(att.attachment_count, 0) as attachment_count
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN (SELECT product_id, COUNT(*) as attachment_count FROM product_attachments GROUP BY product_id) att ON att.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          SUM(quantity_reserved) as reserved_qty,
          json_agg(json_build_object('order_number', po.order_number, 'qty', sr.quantity_reserved, 'status', sr.status)) as reservation_detail
        FROM stock_reservations sr
        LEFT JOIN production_orders po ON sr.production_order_id = po.id
        WHERE sr.status = 'reserved' AND sr.product_id IS NOT NULL
        GROUP BY product_id
      ) r ON r.product_id = p.id
      WHERE 1=1`
    const params = []
    // Default: hide archived products (matches the master pattern). UI toggle passes
    // include_archived=1 to show them so the user can restore.
    if (include_archived !== '1') q += ` AND p.archived = false`
    if (category && category !== 'ALL') { params.push(category); q += ` AND p.category = $${params.length}` }
    if (client_id) { params.push(parseInt(client_id)); q += ` AND p.client_id = $${params.length}` }
    if (search) { params.push(`%${search}%`); q += ` AND (p.name ILIKE $${params.length} OR p.product_code ILIKE $${params.length} OR p.barcode ILIKE $${params.length})` }
    if (has_attachments === '1') q += ` AND EXISTS (SELECT 1 FROM product_attachments WHERE product_id = p.id)`
    q += ` ORDER BY p.category, p.name`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/products/:id', auth, async (req, res) => {
  try {
    const result = await query(`SELECT p.*, s.name as supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE p.id = $1`, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/products', auth, async (req, res) => {
  try {
    const { name, product_code, category, sub_category, unit, current_stock, min_stock_level, supplier, supplier_id, supplier_code, bin_location, barcode, shopify_variant_id, lead_time, notes, image_data, client_id, volume_ml, default_oil_pct, is_master, master_product_id, fragrance_id, segment, price, description } = req.body
    if (!name || !product_code || !category) return res.status(400).json({ error: 'Name, product_code and category required' })
    // Auto-flag FG products without a master parent as masters (Cin7-style: FG in Products page = template)
    const finalIsMaster = is_master ?? (category === 'FINISHED_GOOD' && !master_product_id && !fragrance_id)
    const finalSegment = segment ?? (finalIsMaster ? (client_id ? 'MAJOR' : 'MUSE') : null)
    const result = await query(
      `INSERT INTO products (name, product_code, category, sub_category, unit, current_stock, min_stock_level, supplier, supplier_id, supplier_code, bin_location, barcode, shopify_variant_id, lead_time, notes, image_data, client_id, volume_ml, default_oil_pct, is_master, master_product_id, fragrance_id, segment, price, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [name, product_code.toUpperCase(), category, sub_category || null, unit || 'units', current_stock || 0, min_stock_level || 0, supplier || null, supplier_id || null, supplier_code || null, bin_location || null, barcode || null, shopify_variant_id || null, lead_time || null, notes || null, image_data || null, client_id || null, volume_ml ? parseFloat(volume_ml) : null, default_oil_pct ? parseFloat(default_oil_pct) : 25, finalIsMaster, master_product_id || null, fragrance_id || null, finalSegment, price ? parseFloat(price) : null, description || null]
    )
    await auditLog(req.user.id, 'product_created', 'product', result.rows[0].id, name, { product_code, category, is_master: finalIsMaster, segment: finalSegment })
    res.status(201).json(result.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Product code already exists' })
    res.status(500).json({ error: sanitizeError(e) })
  }
})

router.put('/products/:id', auth, async (req, res) => {
  try {
    const { name, product_code, category, sub_category, unit, min_stock_level, supplier, supplier_id, supplier_code, bin_location, barcode, shopify_variant_id, lead_time, notes, image_data, client_id, volume_ml, default_oil_pct, segment, price, description } = req.body
    const result = await query(
      `UPDATE products SET name=COALESCE($1,name), product_code=COALESCE($2,product_code), category=COALESCE($3,category), sub_category=$4, unit=COALESCE($5,unit), min_stock_level=COALESCE($6,min_stock_level), supplier=$7, supplier_id=$8, supplier_code=$9, bin_location=$10, barcode=$11, shopify_variant_id=$12, lead_time=$13, notes=$14, image_data=$15, client_id=$16, volume_ml=COALESCE($17,volume_ml), default_oil_pct=COALESCE($18,default_oil_pct), segment=COALESCE($19,segment), price=$20, description=$21 WHERE id=$22 RETURNING *`,
      [name, product_code?.toUpperCase(), category, sub_category ?? null, unit, min_stock_level, supplier ?? null, supplier_id ?? null, supplier_code ?? null, bin_location ?? null, barcode ?? null, shopify_variant_id ?? null, lead_time ?? null, notes ?? null, image_data ?? null, client_id ?? null, volume_ml ? parseFloat(volume_ml) : null, default_oil_pct ? parseFloat(default_oil_pct) : null, segment ?? null, price != null && price !== '' ? parseFloat(price) : null, description ?? null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Product code already exists' })
    res.status(500).json({ error: sanitizeError(e) })
  }
})

router.patch('/products/:id/bin-location', auth, async (req, res) => {
  try {
    const result = await query(`UPDATE products SET bin_location = $1 WHERE id = $2 RETURNING *`, [req.body.bin_location || null, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.patch('/products/:id/image', auth, requireUploads, async (req, res) => {
  try {
    const result = await query(`UPDATE products SET image_data = $1 WHERE id = $2 RETURNING id, name, image_data`, [req.body.image_data || null, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/products/:id/location', auth, async (req, res) => {
  try {
    const result = await query(`UPDATE products SET bin_location = $1 WHERE id = $2 RETURNING *`, [req.body.bin_location || null, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    await auditLog(req.user.id, 'product_location_updated', 'product', parseInt(req.params.id), result.rows[0].name, { bin_location: req.body.bin_location })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Soft archive by default — keeps history (transactions, reservations) intact.
// ?mode=permanent forces hard delete, only allowed when zero stock + zero transactions
// + zero reservations (otherwise FK constraints would fail anyway).
router.delete('/products/:id', auth, async (req, res) => {
  try {
    const prod = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id])
    if (!prod.rows[0]) return res.status(404).json({ error: 'Not found' })
    const mode = req.query.mode || 'archive'

    if (mode === 'permanent') {
      // Safety: refuse permanent delete if any history exists. Force archive first.
      const tx = await query(`SELECT 1 FROM transactions WHERE product_id = $1 LIMIT 1`, [req.params.id])
      const rs = await query(`SELECT 1 FROM stock_reservations WHERE product_id = $1 LIMIT 1`, [req.params.id])
      const hasStock = parseFloat(prod.rows[0].current_stock) > 0
      if (tx.rows[0] || rs.rows[0] || hasStock) {
        return res.status(400).json({ error: 'Cannot permanently delete — product has stock, transactions or reservations. Archive instead.' })
      }
      await query(`DELETE FROM products WHERE id = $1`, [req.params.id])
      await auditLog(req.query.userId || req.user.id, 'product_deleted', 'product', parseInt(req.params.id), prod.rows[0].name, { mode: 'permanent' })
      return res.json({ success: true, mode: 'permanent' })
    }

    // Default: soft archive (mirrors the master archive flow). UI shows archived behind a toggle.
    await query(`UPDATE products SET archived = true, updated_at = NOW() WHERE id = $1`, [req.params.id])
    await auditLog(req.query.userId || req.user.id, 'product_archived', 'product', parseInt(req.params.id), prod.rows[0].name, {})
    res.json({ success: true, mode: 'archive' })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Restore an archived product back to active.
router.post('/products/:id/restore', auth, async (req, res) => {
  try {
    const prod = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id])
    if (!prod.rows[0]) return res.status(404).json({ error: 'Not found' })
    await query(`UPDATE products SET archived = false, updated_at = NOW() WHERE id = $1`, [req.params.id])
    await auditLog(req.user.id, 'product_restored', 'product', parseInt(req.params.id), prod.rows[0].name, {})
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Transactions
router.get('/products/:id/transactions', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE t.product_id = $1 ORDER BY t.created_at DESC LIMIT 500`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Fragrance strength log
router.get('/fragrances/:id/strength-log', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT fsl.*, u.name as created_by_name FROM fragrance_strength_log fsl LEFT JOIN users u ON fsl.created_by = u.id WHERE fsl.fragrance_id = $1 ORDER BY fsl.date_used DESC`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/fragrances/:id/strength-log', auth, async (req, res) => {
  try {
    const { production_order_id, standard_pct, actual_pct_used, was_adjusted, adjustment_reason, batch_reference, date_used } = req.body
    const fragrance = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id])
    if (!fragrance.rows[0]) return res.status(404).json({ error: 'Fragrance not found' })
    const result = await query(
      `INSERT INTO fragrance_strength_log (fragrance_id, fragrance_name, production_order_id, standard_pct, actual_pct_used, was_adjusted, adjustment_reason, batch_reference, date_used, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, fragrance.rows[0].name, production_order_id || null, standard_pct || 25, actual_pct_used, was_adjusted || false, adjustment_reason || null, batch_reference || null, date_used || new Date().toISOString().split('T')[0], req.user.id]
    )
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Attachments
router.get('/products/:id/attachments', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT pa.id, pa.product_id, pa.filename, pa.content_type, pa.attachment_type, pa.version, pa.expires_at, pa.file_size, pa.notes, pa.uploaded_by, pa.created_at, u.name as uploaded_by_name
       FROM product_attachments pa LEFT JOIN users u ON pa.uploaded_by = u.id
       WHERE pa.product_id = $1 ORDER BY pa.created_at DESC`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/products/:id/attachments', auth, requireUploads, async (req, res) => {
  try {
    const { filename, content_type, attachment_type, version, expires_at, file_data, notes } = req.body
    if (!filename || !content_type || !file_data) return res.status(400).json({ error: 'filename, content_type, file_data required' })
    const ALLOWED = ['application/pdf','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/jpeg','image/png','image/jpg']
    if (!ALLOWED.includes(content_type)) return res.status(400).json({ error: 'Unsupported file type' })
    const fileSizeBytes = Math.round((file_data.length * 3) / 4)
    if (fileSizeBytes > 10 * 1024 * 1024) return res.status(400).json({ error: 'File exceeds 10MB limit' })
    const result = await query(
      `INSERT INTO product_attachments (product_id, filename, content_type, attachment_type, version, expires_at, file_size, file_data, notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, filename, content_type, attachment_type, version, expires_at, file_size, notes, created_at`,
      [req.params.id, filename, content_type, attachment_type || 'document', version || null, expires_at || null, fileSizeBytes, file_data, notes || null, req.user.id]
    )
    await auditLog(req.user.id, 'attachment_uploaded', 'product', parseInt(req.params.id), filename, { attachment_type, version })
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/products/:id/attachments/:attachId/download', auth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM product_attachments WHERE id = $1 AND product_id = $2`, [req.params.attachId, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    const att = result.rows[0]
    const buf = Buffer.from(att.file_data, 'base64')
    res.setHeader('Content-Type', att.content_type)
    res.setHeader('Content-Disposition', `attachment; filename="${att.filename}"`)
    res.setHeader('Content-Length', buf.length)
    res.send(buf)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/products/:id/attachments/:attachId/view', auth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM product_attachments WHERE id = $1 AND product_id = $2`, [req.params.attachId, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    const att = result.rows[0]
    const buf = Buffer.from(att.file_data, 'base64')
    res.setHeader('Content-Type', att.content_type)
    res.setHeader('Content-Disposition', `inline; filename="${att.filename}"`)
    res.setHeader('Content-Length', buf.length)
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(buf)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/products/:id/attachments/:attachId', auth, requireRole('root', 'admin'), async (req, res) => {
  try {
    const result = await query(`DELETE FROM product_attachments WHERE id = $1 AND product_id = $2 RETURNING filename`, [req.params.attachId, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    await auditLog(req.user.id, 'attachment_deleted', 'product', parseInt(req.params.id), result.rows[0].filename, {})
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Publish a product to Shopify as a draft (system stays source of truth for stock/price).
router.post('/products/:id/shopify/publish', auth, async (req, res) => {
  try {
    if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'Shopify not configured' })
    }
    const prod = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id])
    if (!prod.rows[0]) return res.status(404).json({ error: 'Not found' })
    const p = prod.rows[0]

    const images = []
    if (p.image_data) {
      const base64 = p.image_data.replace(/^data:image\/\w+;base64,/, '')
      images.push({ attachment: base64 })
    }

    const shopifyProduct = {
      product: {
        title: p.name,
        body_html: p.description || '',
        product_type: 'Diffusers',
        status: 'draft',
        images,
        variants: [{
          sku: p.product_code,
          barcode: p.barcode || undefined,
          price: p.price != null ? String(p.price) : '0.00',
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          inventory_quantity: Math.max(0, Math.trunc(parseFloat(p.current_stock) || 0)),
        }]
      }
    }

    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-04/products.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify(shopifyProduct)
    })
    const data = await response.json()
    if (!response.ok) return res.status(502).json({ error: data.errors ? JSON.stringify(data.errors) : 'Shopify API error' })

    const variant = data.product.variants[0]
    const updated = await query(
      `UPDATE products SET shopify_product_id = $1, shopify_variant_id = $2, shopify_inventory_item_id = $3, shopify_synced_at = NOW() WHERE id = $4 RETURNING *`,
      [data.product.id, variant.id, variant.inventory_item_id, p.id]
    )
    await auditLog(req.user.id, 'product_published_to_shopify', 'product', p.id, p.name, { shopify_product_id: data.product.id })
    res.json(updated.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Barcode lookup
router.get('/barcode/:code', auth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM products WHERE barcode = $1`, [req.params.code])
    if (!result.rows[0]) return res.status(404).json({ error: 'Product not found for barcode' })
    const product = result.rows[0]
    const [openPOs, pickingOrders] = await Promise.all([
      query(`SELECT po.id, po.order_number, po.quantity, po.quantity_received, po.supplier, po.status, po.estimated_delivery_date FROM purchase_orders po WHERE po.product_id = $1 AND po.status IN ('pending','partial') ORDER BY po.estimated_delivery_date ASC NULLS LAST LIMIT 10`, [product.id]),
      query(`SELECT DISTINCT pord.id, pord.order_number, pord.status, pord.due_date, poc.quantity_required, poc.quantity_debited, poc.id as component_id, poc.unit FROM production_order_components poc JOIN production_orders pord ON poc.production_order_id = pord.id WHERE poc.product_id = $1 AND pord.status IN ('draft','confirmed','queued','in_production') AND poc.quantity_debited < poc.quantity_required ORDER BY pord.due_date ASC NULLS LAST LIMIT 10`, [product.id])
    ])
    res.json({ ...product, open_pos: openPOs.rows, picking_orders: pickingOrders.rows })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
