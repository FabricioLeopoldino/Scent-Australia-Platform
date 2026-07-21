const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query, withTransaction } = require('../db')
const { auth, auditLog, requireRole } = require('../auth')

// Slugify a string for use in product codes
function slugify(s) {
  return String(s || '').toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

// Next MUSE finished-good SKU — STORE PATTERN (owner, 2026-07-12): per master
// format, matching the SKUs live on the MUSE Shopify store:
//   master RD200 → Muse_RD#####  ·  RS100 → Muse_RS#####  ·  TS10 → Muse_TS#####
// (alpha prefix of the master code + 5-digit sequence). The old global
// MUS#### generator is retired — pattern consistency matters because these
// SKUs publish to Shopify.
async function nextMuseSku(tq, masterCode) {
  const alpha = String(masterCode || '').replace(/[^A-Za-z]/g, '').toUpperCase() || 'X'
  const prefix = `Muse_${alpha}`
  const r = await tq(`SELECT sku FROM products WHERE sku LIKE $1`, [prefix + '%'])
  const nums = r.rows
    .map(row => parseInt(String(row.sku).slice(prefix.length), 10))
    .filter(n => !isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return prefix + String(next).padStart(5, '0')
}

// Assign SKU + barcode to a MUSE variant if it doesn't have one yet
async function ensureMuseSku(tq, variantId) {
  const cur = await tq(
    `SELECT v.sku, m.product_code AS master_code
     FROM products v LEFT JOIN products m ON m.id = v.master_product_id
     WHERE v.id = $1`,
    [variantId]
  )
  if (cur.rows[0] && !cur.rows[0].sku) {
    const sku = await nextMuseSku(tq, cur.rows[0].master_code)
    await tq(`UPDATE products SET sku = $1, barcode = COALESCE(barcode, $1) WHERE id = $2`, [sku, variantId])
  }
}

// GET /api/product-types — flat list of all masters (compat layer for legacy callers)
router.get('/product-types', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.id, p.product_code as key, p.name as label, p.segment, p.client_id,
              p.volume_ml as volume, p.volume_unit, p.default_oil_pct,
              p.container_name, p.is_candle, p.is_pure_oil,
              COALESCE(
                (SELECT json_agg(mmf.fragrance_id) FROM muse_master_fragrances mmf WHERE mmf.master_product_id = p.id),
                (SELECT json_agg(mcf.fragrance_id) FROM major_client_master_fragrances mcf WHERE mcf.master_product_id = p.id),
                '[]'::json
              ) as fragrance_ids
       FROM products p
       WHERE p.is_master = true AND p.archived = false
       ORDER BY p.segment, p.name`
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// GET /api/masters?segment=MUSE|STANDARD|MAJOR&client_id=X — filtered list
router.get('/masters', auth, async (req, res) => {
  try {
    const { segment, client_id, include_archived } = req.query
    let q = `
      SELECT p.*,
             c.name as client_name,
             (SELECT COUNT(*) FROM products v WHERE v.master_product_id = p.id AND v.archived = false) as variant_count,
             COALESCE(
               (SELECT SUM(v.current_stock) FROM products v WHERE v.master_product_id = p.id AND v.archived = false),
               0
             ) as total_variant_stock,
             (SELECT COUNT(*) FROM muse_master_fragrances WHERE master_product_id = p.id) +
             (SELECT COUNT(*) FROM major_client_master_fragrances WHERE master_product_id = p.id) as fragrance_count,
             (SELECT COUNT(*) FROM product_bom WHERE product_type = p.product_code AND is_active = true) as bom_component_count
      FROM products p
      LEFT JOIN clients c ON p.client_id = c.id
      WHERE p.is_master = true`
    const params = []
    if (include_archived !== '1') q += ` AND p.archived = false`
    if (segment) { params.push(segment); q += ` AND p.segment = $${params.length}` }
    if (client_id === 'null') {
      q += ` AND p.client_id IS NULL`
    } else if (client_id) {
      params.push(parseInt(client_id)); q += ` AND p.client_id = $${params.length}`
    }
    q += ` ORDER BY p.name`
    const result = await query(q, params)
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// GET /api/masters/:id — full detail (master + BOM + fragrances + variants)
router.get('/masters/:id', auth, async (req, res) => {
  try {
    const masterRes = await query(
      `SELECT p.*, c.name as client_name
       FROM products p
       LEFT JOIN clients c ON p.client_id = c.id
       WHERE p.id = $1 AND p.is_master = true`,
      [req.params.id]
    )
    if (!masterRes.rows[0]) return res.status(404).json({ error: 'Master not found' })
    const master = masterRes.rows[0]

    // BOM components
    const bomRes = await query(
      `SELECT pb.*, p.name as component_name, p.product_code as component_code,
              p.unit as component_unit, p.current_stock, p.category
       FROM product_bom pb
       JOIN products p ON pb.component_product_id = p.id
       WHERE pb.product_type = $1 AND pb.is_active = true
       ORDER BY pb.sort_order, pb.id`,
      [master.product_code]
    )

    // Fragrances (from appropriate junction based on segment)
    const fragTable = master.segment === 'MAJOR' ? 'major_client_master_fragrances' : 'muse_master_fragrances'
    const fragRes = master.segment === 'STANDARD'
      ? { rows: [] }  // Standard: fragrance picked per-order, no pre-defined list
      : await query(
          `SELECT mmf.fragrance_id, p.product_code, p.name
           FROM ${fragTable} mmf
           JOIN products p ON mmf.fragrance_id = p.id
           WHERE mmf.master_product_id = $1
           ORDER BY p.name`,
          [master.id]
        )

    // Variants (only MUSE has variants with stock; Major tracks via order status)
    const variantsRes = await query(
      `SELECT v.id, v.product_code, v.name, v.current_stock, v.fragrance_id,
              v.archived, f.name as fragrance_name
       FROM products v
       LEFT JOIN products f ON v.fragrance_id = f.id
       WHERE v.master_product_id = $1
       ORDER BY f.name`,
      [master.id]
    )

    res.json({
      ...master,
      bom_components: bomRes.rows,
      fragrances: fragRes.rows,
      variants: variantsRes.rows,
    })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// POST /api/masters — create master + (optional) generate variants
router.post('/masters', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const {
      name, product_code, segment, client_id,
      volume_ml, volume_unit, default_oil_pct,
      container_name, is_pure_oil, is_candle,
      bom_components,  // [{ component_product_id, quantity_formula, quantity_per_unit, component_group, sort_order }]
      fragrance_ids,   // [101, 102, ...] (only for MUSE/MAJOR)
      generate_variants,  // default true for MUSE
      notes, image_data,
    } = req.body

    if (!name?.trim() || !product_code?.trim()) return res.status(400).json({ error: 'name and product_code required' })
    if (!['MUSE', 'STANDARD', 'MAJOR'].includes(segment)) return res.status(400).json({ error: 'segment must be MUSE, STANDARD, or MAJOR' })
    if (segment === 'MAJOR' && !client_id) return res.status(400).json({ error: 'client_id required for MAJOR segment' })
    if (segment !== 'MAJOR' && client_id) return res.status(400).json({ error: 'client_id only valid for MAJOR segment' })

    const result = await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)

      // 1. Create master product
      const masterRes = await tq(
        `INSERT INTO products
          (name, product_code, category, segment, is_master, client_id,
           volume_ml, volume_unit, default_oil_pct, container_name, is_pure_oil, is_candle, unit, current_stock, notes, image_data, price)
         VALUES ($1, $2, 'FINISHED_GOOD', $3, true, $4, $5, $6, $7, $8, $9, $10, 'units', 0, $11, $12, $13)
         RETURNING *`,
        [
          name.trim(), product_code.trim().toUpperCase(), segment, client_id || null,
          volume_ml ? parseFloat(volume_ml) : null, volume_unit || 'ml',
          default_oil_pct ? parseFloat(default_oil_pct) : 25,
          container_name?.trim() || null, !!is_pure_oil, !!is_candle, notes || null, image_data || null,
          req.body.price != null ? parseFloat(req.body.price) : null,
        ]
      )
      const master = masterRes.rows[0]

      // 2. Insert BOM components
      if (Array.isArray(bom_components) && bom_components.length > 0) {
        for (let i = 0; i < bom_components.length; i++) {
          const bom = bom_components[i]
          await tq(
            `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, true)
             ON CONFLICT (product_type, component_product_id) DO UPDATE
               SET quantity_formula = EXCLUDED.quantity_formula,
                   quantity_per_unit = EXCLUDED.quantity_per_unit,
                   sort_order = EXCLUDED.sort_order,
                   component_group = EXCLUDED.component_group,
                   is_active = true`,
            [
              master.product_code, bom.component_product_id,
              bom.quantity_formula || 'fixed',
              parseFloat(bom.quantity_per_unit) || 1,
              bom.sort_order ?? i, bom.component_group || 'core',
            ]
          )
        }
      }

      // 2b. BOM template by container — if no explicit BOM was sent and a container is set,
      // copy the BOM from an existing master that uses the same container (same segment;
      // same client for MAJOR). Saves rebuilding identical BOMs from scratch.
      let bomCopiedFrom = null
      if ((!Array.isArray(bom_components) || bom_components.length === 0) && container_name?.trim()) {
        const params = [master.id, segment, container_name.trim()]
        let where = `p.is_master = true AND p.archived = false AND p.id != $1 AND p.segment = $2
                     AND LOWER(TRIM(p.container_name)) = LOWER(TRIM($3))`
        if (segment === 'MAJOR') { params.push(client_id); where += ` AND p.client_id = $4` }
        const src = await tq(
          `SELECT p.product_code, p.name FROM products p
           WHERE ${where}
             AND EXISTS (SELECT 1 FROM product_bom WHERE product_type = p.product_code AND is_active = true)
           ORDER BY p.created_at DESC LIMIT 1`,
          params
        )
        if (src.rows[0]) {
          await tq(
            `INSERT INTO product_bom (product_type, component_product_id, client_stock_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
             SELECT $1, component_product_id, client_stock_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active
             FROM product_bom WHERE product_type = $2 AND is_active = true`,
            [master.product_code, src.rows[0].product_code]
          )
          bomCopiedFrom = src.rows[0].name
        }
      }

      // 3. Link fragrances + (for MUSE) create variants
      const variantsCreated = []
      if (Array.isArray(fragrance_ids) && fragrance_ids.length > 0 && segment !== 'STANDARD') {
        const fragTable = segment === 'MAJOR' ? 'major_client_master_fragrances' : 'muse_master_fragrances'
        for (const fragId of fragrance_ids) {
          await tq(
            `INSERT INTO ${fragTable} (master_product_id, fragrance_id) VALUES ($1, $2)
             ON CONFLICT (master_product_id, fragrance_id) DO NOTHING`,
            [master.id, fragId]
          )

          // MUSE: auto-create variant for each fragrance (if requested)
          if (segment === 'MUSE' && generate_variants !== false) {
            const frag = await tq(`SELECT product_code, name FROM products WHERE id = $1`, [fragId])
            if (frag.rows[0]) {
              const variantCode = `${master.product_code}-${slugify(frag.rows[0].product_code || frag.rows[0].name)}`
              const variantName = `${master.name} — ${frag.rows[0].name}`
              const variantRes = await tq(
                `INSERT INTO products
                  (name, product_code, category, segment, is_master, master_product_id, fragrance_id,
                   unit, current_stock, volume_ml, volume_unit, container_name, is_pure_oil, is_candle, client_id, price)
                 VALUES ($1, $2, 'FINISHED_GOOD', 'MUSE', false, $3, $4, 'units', 0, $5, $6, $7, $8, $9, NULL, $10)
                 ON CONFLICT (product_code) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [variantName, variantCode, master.id, fragId, master.volume_ml, master.volume_unit, master.container_name, master.is_pure_oil, master.is_candle, master.price]
              )
              variantsCreated.push(variantRes.rows[0].id)
              await ensureMuseSku(tq, variantRes.rows[0].id)
            }
          }
        }
      }

      return { master, variants_created: variantsCreated.length, bom_entries_created: (bom_components || []).length, fragrances_linked: (fragrance_ids || []).length, bom_copied_from: bomCopiedFrom }
    })

    await auditLog(req.user.id, 'master_created', 'product', result.master.id, name, { segment, product_code, variants_created: result.variants_created })
    res.status(201).json(result)
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Product code already exists' })
    res.status(500).json({ error: sanitizeError(e) })
  }
})

// PUT /api/masters/:id — update master (name, volume, oil_pct, container_type, notes)
// product_code and segment are immutable after creation
router.put('/masters/:id', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { name, volume_ml, volume_unit, default_oil_pct, container_name, is_pure_oil, is_candle, notes, image_data, price } = req.body
    const result = await query(
      `UPDATE products
       SET name = COALESCE($1, name),
           volume_ml = COALESCE($2, volume_ml),
           volume_unit = COALESCE($3, volume_unit),
           default_oil_pct = COALESCE($4, default_oil_pct),
           container_name = COALESCE($5, container_name),
           is_pure_oil = COALESCE($6, is_pure_oil),
           is_candle = COALESCE($7, is_candle),
           notes = $8,
           image_data = COALESCE($9, image_data),
           price = COALESCE($10, price)
       WHERE id = $11 AND is_master = true
       RETURNING *`,
      [name, volume_ml, volume_unit, default_oil_pct, container_name, is_pure_oil, is_candle, notes ?? null, image_data ?? null, price != null ? parseFloat(price) : null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Master not found' })
    // Price lives on the master (like SA's container price) and cascades to
    // its variants — that is the per-unit price Shopify publish uses.
    if (price != null) {
      await query(`UPDATE products SET price = $1 WHERE master_product_id = $2`, [parseFloat(price), req.params.id])
    }
    await auditLog(req.user.id, 'master_updated', 'product', parseInt(req.params.id), result.rows[0].name, req.body)
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// DELETE /api/masters/:id — soft archive (preserves variants/stock/history)
router.delete('/masters/:id', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE products SET archived = true WHERE id = $1 AND is_master = true RETURNING name, segment`,
      [req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Master not found' })
    await auditLog(req.user.id, 'master_archived', 'product', parseInt(req.params.id), result.rows[0].name, { segment: result.rows[0].segment })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// POST /api/masters/:id/fragrances — add fragrance, auto-create variant if MUSE
router.post('/masters/:id/fragrances', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { fragrance_id } = req.body
    if (!fragrance_id) return res.status(400).json({ error: 'fragrance_id required' })

    const masterRes = await query(`SELECT * FROM products WHERE id = $1 AND is_master = true`, [req.params.id])
    if (!masterRes.rows[0]) return res.status(404).json({ error: 'Master not found' })
    const master = masterRes.rows[0]
    if (master.segment === 'STANDARD') return res.status(400).json({ error: 'Standard masters do not pre-define fragrances' })

    const fragTable = master.segment === 'MAJOR' ? 'major_client_master_fragrances' : 'muse_master_fragrances'

    const result = await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)

      await tq(
        `INSERT INTO ${fragTable} (master_product_id, fragrance_id) VALUES ($1, $2)
         ON CONFLICT (master_product_id, fragrance_id) DO NOTHING`,
        [master.id, fragrance_id]
      )

      let variantId = null
      if (master.segment === 'MUSE') {
        const frag = await tq(`SELECT product_code, name FROM products WHERE id = $1`, [fragrance_id])
        if (frag.rows[0]) {
          const variantCode = `${master.product_code}-${slugify(frag.rows[0].product_code || frag.rows[0].name)}`
          const variantName = `${master.name} — ${frag.rows[0].name}`
          const v = await tq(
            `INSERT INTO products
              (name, product_code, category, segment, is_master, master_product_id, fragrance_id,
               unit, current_stock, volume_ml, volume_unit, container_name, is_pure_oil, is_candle, client_id, price)
             VALUES ($1, $2, 'FINISHED_GOOD', 'MUSE', false, $3, $4, 'units', 0, $5, $6, $7, $8, $9, NULL, $10)
             ON CONFLICT (product_code) DO UPDATE SET name = EXCLUDED.name, archived = false
             RETURNING id`,
            [variantName, variantCode, master.id, fragrance_id, master.volume_ml, master.volume_unit, master.container_name, master.is_pure_oil, master.is_candle, master.price]
          )
          variantId = v.rows[0].id
          // Auto-assign MUSE SKU + barcode (keeps existing if variant was re-added)
          await ensureMuseSku(tq, variantId)
        }
      }

      return { variant_id: variantId }
    })

    await auditLog(req.user.id, 'master_fragrance_added', 'product', master.id, master.name, { fragrance_id, variant_created: result.variant_id })
    res.json({ success: true, ...result })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// DELETE /api/masters/:id/fragrances/:fragId — remove fragrance, archive variant (preserves stock history)
router.delete('/masters/:id/fragrances/:fragId', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const masterRes = await query(`SELECT * FROM products WHERE id = $1 AND is_master = true`, [req.params.id])
    if (!masterRes.rows[0]) return res.status(404).json({ error: 'Master not found' })
    const master = masterRes.rows[0]

    const fragTable = master.segment === 'MAJOR' ? 'major_client_master_fragrances' : 'muse_master_fragrances'

    await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)

      await tq(`DELETE FROM ${fragTable} WHERE master_product_id = $1 AND fragrance_id = $2`, [master.id, req.params.fragId])

      // Archive variant (don't delete — preserves transaction history)
      if (master.segment === 'MUSE') {
        await tq(
          `UPDATE products SET archived = true
           WHERE master_product_id = $1 AND fragrance_id = $2`,
          [master.id, req.params.fragId]
        )
      }
    })

    await auditLog(req.user.id, 'master_fragrance_removed', 'product', master.id, master.name, { fragrance_id: parseInt(req.params.fragId) })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
module.exports.ensureMuseSku = ensureMuseSku
