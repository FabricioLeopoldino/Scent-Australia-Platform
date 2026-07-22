const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth, auditLog, requireUploads, requireRole } = require('../auth')

router.get('/clients', auth, async (req, res) => {
  try {
    const { search, is_large_client } = req.query
    let q = `SELECT * FROM clients WHERE 1=1`
    const params = []
    if (search) { params.push(`%${search}%`); q += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})` }
    if (is_large_client !== undefined) { params.push(is_large_client === 'true'); q += ` AND is_large_client = $${params.length}` }
    q += ` ORDER BY name`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/clients/:id', auth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM clients WHERE id = $1`, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/clients', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { shopify_customer_id, name, email, phone, address, is_large_client, notes } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' })
    // Block duplicate client names (case-insensitive) — a client is one record regardless of segment
    const dup = await query(`SELECT id FROM clients WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`, [name])
    if (dup.rows[0]) return res.status(409).json({ error: `A client named "${name.trim()}" already exists` })
    const result = await query(
      `INSERT INTO clients (shopify_customer_id, name, email, phone, address, is_large_client, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [shopify_customer_id || null, name.trim(), email || null, phone || null, address || null, is_large_client || false, notes || null]
    )
    await auditLog(req.user.id, 'client_created', 'client', result.rows[0].id, name, {})
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/clients/:id', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { name, email, phone, address, is_large_client, notes, shopify_customer_id } = req.body
    if (name?.trim()) {
      const dup = await query(`SELECT id FROM clients WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND id != $2 LIMIT 1`, [name, req.params.id])
      if (dup.rows[0]) return res.status(409).json({ error: `A client named "${name.trim()}" already exists` })
    }
    const result = await query(
      `UPDATE clients SET name = COALESCE($1, name), email = $2, phone = $3, address = $4, is_large_client = COALESCE($5, is_large_client), notes = $6, shopify_customer_id = $7 WHERE id = $8 RETURNING *`,
      [name, email ?? null, phone ?? null, address ?? null, is_large_client, notes ?? null, shopify_customer_id ?? null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/clients/:id/labels', auth, async (req, res) => {
  try {
    res.json((await query(
      `SELECT cl.*,
              COALESCE((
                SELECT SUM(pol.quantity)
                FROM production_order_lines pol
                JOIN production_orders po ON po.id = pol.production_order_id
                WHERE pol.label_client_label_id = cl.id
                  AND po.status IN ('draft', 'confirmed', 'queued', 'waiting_external')
              ), 0)::numeric as reserved_qty
       FROM client_labels cl
       WHERE cl.client_id = $1
       ORDER BY cl.label_name, cl.artwork_version`,
      [req.params.id]
    )).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/clients/:id/labels', auth, async (req, res) => {
  try {
    const { label_name, artwork_version, supplier, quantity, notes, applicable_product_type, image_data } = req.body
    if (!label_name) return res.status(400).json({ error: 'label_name required' })
    const result = await query(
      `INSERT INTO client_labels (client_id, label_name, artwork_version, supplier, quantity, notes, applicable_product_type, image_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, label_name, artwork_version || 'v1', supplier || null, quantity || 0, notes || null, applicable_product_type || null, image_data || null]
    )
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.patch('/client-labels/:id/image', auth, requireUploads, async (req, res) => {
  try {
    const r = await query(`UPDATE client_labels SET image_data = $1 WHERE id = $2 RETURNING id, label_name, image_data`, [req.body.image_data || null, req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(r.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/clients/:id/labels/receive', auth, async (req, res) => {
  try {
    const { client_label_id, quantity, notes } = req.body
    if (!client_label_id || !quantity) return res.status(400).json({ error: 'client_label_id and quantity required' })
    await query(`UPDATE client_labels SET quantity = quantity + $1 WHERE id = $2 AND client_id = $3`, [quantity, client_label_id, req.params.id])
    await query(
      `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, notes, user_id) VALUES ($1,$2,'received',$3,$4,$5)`,
      [client_label_id, req.params.id, quantity, notes || null, req.user.id]
    )
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/clients/:clientId/labels/:labelId/obsolete', auth, async (req, res) => {
  try {
    const { is_obsolete } = req.body
    await query(`UPDATE client_labels SET is_obsolete = $1 WHERE id = $2 AND client_id = $3`, [is_obsolete, req.params.labelId, req.params.clientId])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/clients/:id', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    // Deleting a client used to run unchecked: production_orders.client_id is
    // ON DELETE SET NULL (silently orphaning their order history), while
    // client_stock / client_labels CASCADE (destroying the record of the
    // client-owned inventory we physically hold). Refuse if any of it exists.
    const id = req.params.id
    const [orders, stock, labels] = await Promise.all([
      query(`SELECT COUNT(*)::int n FROM production_orders WHERE client_id = $1`, [id]),
      query(`SELECT COUNT(*)::int n FROM client_stock WHERE client_id = $1`, [id]),
      query(`SELECT COUNT(*)::int n FROM client_labels WHERE client_id = $1`, [id]),
    ])
    const blockers = []
    if (orders.rows[0].n) blockers.push(`${orders.rows[0].n} production order(s)`)
    if (stock.rows[0].n) blockers.push(`${stock.rows[0].n} client stock item(s)`)
    if (labels.rows[0].n) blockers.push(`${labels.rows[0].n} client label(s)`)
    if (blockers.length) {
      return res.status(400).json({ error: `This client still has ${blockers.join(', ')} — remove or reassign them before deleting the client` })
    }
    await query(`DELETE FROM clients WHERE id = $1`, [id])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/clients/:clientId/labels/:labelId', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    await query(`DELETE FROM client_labels WHERE id = $1 AND client_id = $2`, [req.params.labelId, req.params.clientId])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/clients/:id/orders', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT po.id, po.order_number, po.status, po.order_type, po.due_date, po.created_at,
              COUNT(pol.id) as line_count, SUM(pol.quantity) as total_qty
       FROM production_orders po
       LEFT JOIN production_order_lines pol ON pol.production_order_id = po.id
       WHERE po.client_id = $1
       GROUP BY po.id ORDER BY po.created_at DESC LIMIT 50`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/clients/:id/products', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, (SELECT COUNT(*) FROM client_product_bom WHERE product_id = p.id) as bom_count
       FROM products p WHERE p.client_id = $1 ORDER BY p.category, p.name`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/client-products/:id/bom', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT cpb.*,
         cs.product_name as cs_name, cs.product_code as cs_code, cs.unit as cs_unit, cs.quantity as cs_stock,
         gp.name as gp_name, gp.product_code as gp_code, gp.unit as gp_unit, gp.current_stock as gp_stock, gp.category as gp_category
       FROM client_product_bom cpb
       LEFT JOIN client_stock cs ON cpb.client_stock_id = cs.id
       LEFT JOIN products gp ON cpb.general_product_id = gp.id
       WHERE cpb.product_id = $1 ORDER BY cpb.created_at`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/client-products/:id/bom', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { client_stock_id, general_product_id, quantity_per_unit, unit, notes } = req.body
    if (!client_stock_id && !general_product_id) return res.status(400).json({ error: 'client_stock_id or general_product_id required' })
    const result = await query(
      `INSERT INTO client_product_bom (product_id, client_stock_id, general_product_id, quantity_per_unit, unit, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, client_stock_id || null, general_product_id || null, parseFloat(quantity_per_unit) || 1, unit || 'units', notes || null]
    )
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/client-products/:id/bom/:entryId', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    await query(`DELETE FROM client_product_bom WHERE id = $1 AND product_id = $2`, [req.params.entryId, req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// External SKU Mapping feature removed 2026-05-28 — was unused dead weight.
// Table customer_sku_mappings preserved in DB (no destructive migration); routes/reset still
// reference it for /api/reset cleanup. To fully drop, also remove from reset.js + db.js.

router.get('/clients/:id/stock', auth, async (req, res) => {
  try {
    res.json((await query(`SELECT cs.* FROM client_stock cs WHERE client_id = $1 ORDER BY product_name`, [req.params.id])).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/clients/:id/stock/receive', auth, async (req, res) => {
  try {
    const { product_code, product_name, category, barcode, unit, quantity, notes, image_data } = req.body
    if (!product_code || !product_name || quantity == null) return res.status(400).json({ error: 'product_code, product_name and quantity required' })
    const qty = parseFloat(quantity) || 0
    const existing = await query(`SELECT cs.* FROM client_stock cs WHERE client_id = $1 AND product_code = $2`, [req.params.id, product_code])
    let record
    if (existing.rows[0]) {
      const r = await query(
        `UPDATE client_stock
         SET quantity = quantity + $1,
             barcode = COALESCE($2, barcode),
             image_data = COALESCE($3, image_data),
             notes = COALESCE($4, notes)
         WHERE id = $5 RETURNING *`,
        [qty, barcode || null, image_data || null, notes || null, existing.rows[0].id]
      )
      record = r.rows[0]
    } else {
      const r = await query(
        `INSERT INTO client_stock (client_id, product_code, product_name, category, barcode, unit, quantity, received_date, notes, image_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9) RETURNING *`,
        [req.params.id, product_code, product_name, category || 'COMPONENTS', barcode || null, unit || 'units', qty, notes || null, image_data || null]
      )
      record = r.rows[0]
    }
    // Only log a 'received' transaction if quantity was actually added.
    if (qty > 0) {
      await query(
        `INSERT INTO client_stock_transactions (client_stock_id, client_id, type, quantity, unit, notes, user_id) VALUES ($1,$2,'received',$3,$4,$5,$6)`,
        [record.id, req.params.id, qty, unit || 'units', notes || null, req.user.id]
      )
    }
    res.json(record)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/client-stock', auth, async (req, res) => {
  try {
    const { search } = req.query
    let q = `SELECT cs.*, c.name as client_name FROM client_stock cs LEFT JOIN clients c ON cs.client_id = c.id WHERE 1=1`
    const params = []
    if (search) { params.push(`%${search}%`); q += ` AND (cs.product_name ILIKE $1 OR cs.product_code ILIKE $1 OR c.name ILIKE $1)` }
    q += ` ORDER BY c.name, cs.category, cs.product_name`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/client-labels', auth, async (req, res) => {
  try {
    const { search } = req.query
    let q = `SELECT cl.*, c.name as client_name,
                    COALESCE((
                      SELECT SUM(pol.quantity)
                      FROM production_order_lines pol
                      JOIN production_orders po ON po.id = pol.production_order_id
                      WHERE pol.label_client_label_id = cl.id
                        AND po.status IN ('draft', 'confirmed', 'queued', 'waiting_external')
                    ), 0)::numeric as reserved_qty
             FROM client_labels cl
             LEFT JOIN clients c ON cl.client_id = c.id
             WHERE cl.is_obsolete = false`
    const params = []
    if (search) { params.push(`%${search}%`); q += ` AND (cl.label_name ILIKE $1 OR c.name ILIKE $1)` }
    q += ` ORDER BY c.name, cl.label_name, cl.artwork_version`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.patch('/client-stock/:id/image', auth, requireUploads, async (req, res) => {
  try {
    const r = await query(`UPDATE client_stock SET image_data = $1 WHERE id = $2 RETURNING id, product_name, image_data`, [req.body.image_data || null, req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(r.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/client-stock/:id/add', auth, async (req, res) => {
  try {
    const { quantity, notes } = req.body
    if (!quantity || parseFloat(quantity) <= 0) return res.status(400).json({ error: 'Quantity required' })
    const r = await query(`UPDATE client_stock SET quantity = quantity + $1 WHERE id = $2 RETURNING *`, [quantity, req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    await query(`INSERT INTO client_stock_transactions (client_stock_id, client_id, type, quantity, unit, notes, user_id) VALUES ($1,$2,'add',$3,$4,$5,$6)`,
      [req.params.id, r.rows[0].client_id, quantity, r.rows[0].unit, notes || null, req.user.id])
    res.json(r.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/client-stock/:id/remove', auth, async (req, res) => {
  try {
    const { quantity, notes } = req.body
    if (!quantity || parseFloat(quantity) <= 0) return res.status(400).json({ error: 'Quantity required' })
    const r = await query(`UPDATE client_stock SET quantity = quantity - $1 WHERE id = $2 RETURNING *`, [quantity, req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    await query(`INSERT INTO client_stock_transactions (client_stock_id, client_id, type, quantity, unit, notes, user_id) VALUES ($1,$2,'remove',$3,$4,$5,$6)`,
      [req.params.id, r.rows[0].client_id, quantity, r.rows[0].unit, notes || null, req.user.id])
    res.json(r.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/client-stock/:id/adjust', auth, async (req, res) => {
  try {
    const { new_stock, notes } = req.body
    if (new_stock === undefined || new_stock === null || new_stock === '') return res.status(400).json({ error: 'new_stock required' })
    const r = await query(`UPDATE client_stock SET quantity = $1 WHERE id = $2 RETURNING *`, [new_stock, req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    await query(`INSERT INTO client_stock_transactions (client_stock_id, client_id, type, quantity, unit, notes, user_id) VALUES ($1,$2,'adjust',$3,$4,$5,$6)`,
      [req.params.id, r.rows[0].client_id, new_stock, r.rows[0].unit, notes || null, req.user.id])
    res.json(r.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/client-stock/:id/history', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, u.name as user_name FROM client_stock_transactions t LEFT JOIN users u ON t.user_id = u.id WHERE t.client_stock_id = $1 ORDER BY t.created_at DESC`,
      [req.params.id]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/client-stock/:id', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    await query(`DELETE FROM client_stock WHERE id = $1`, [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/client-stock/:id', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { product_code, product_name, category, unit, barcode, notes } = req.body
    if (!product_code || !product_name) return res.status(400).json({ error: 'product_code and product_name required' })
    const r = await query(
      `UPDATE client_stock SET product_code=$1, product_name=$2, category=$3, unit=$4, barcode=$5, notes=$6 WHERE id=$7 RETURNING *`,
      [product_code.trim(), product_name.trim(), category || 'COMPONENT', unit || 'units', barcode || null, notes || null, req.params.id]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(r.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/client-stock/next-lc-code', auth, async (req, res) => {
  try {
    const r = await query(`SELECT product_code FROM client_stock WHERE product_code ~ '^LC_[0-9]{5}$' ORDER BY product_code DESC LIMIT 1`)
    let nextNum = 1
    if (r.rows[0]) nextNum = parseInt(r.rows[0].product_code.replace('LC_', '')) + 1
    res.json({ code: `LC_${String(nextNum).padStart(5, '0')}` })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
