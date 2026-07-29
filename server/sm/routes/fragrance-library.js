const express = require('express')
const router = express.Router()
const { sanitizeError } = require('../errors')
const { auth } = require('../auth')
const { query } = require('../db')
const { SEGMENT_MAP } = require('../services/fragrance-library')

// GET /api/fragrance-library?segment=MUSE|STANDARD|MAJOR — the oil picker for
// the BOM editor (D14). Lists sa.products OILS, filtered by exclusivity: an
// oil exclusive to a DIFFERENT business is hidden from this segment's picker;
// NULL exclusivity (shared) always shows. This IS the "link" — picking an oil
// here when building a MUSE/B2B product is the whole mechanism (no separate
// linking task, D14 §2).
router.get('/fragrance-library', auth, async (req, res) => {
  try {
    const segment = String(req.query.segment || '').toUpperCase()
    const seg = SEGMENT_MAP[segment]
    if (!seg) return res.status(400).json({ error: 'segment query param required: MUSE, STANDARD or MAJOR' })

    // Default: active oils only (safe for the order/BOM pickers — never show a
    // discontinued oil there). The Fragrance Library display page opts in to see
    // inactive ones too via ?include_inactive=1, behind its own toggle.
    const params = [seg.exclusivityBucket]
    let statusFilter = `AND status = 'active'`
    if (req.query.include_inactive === '1') {
      statusFilter = ''
    }

    const r = await query(
      `SELECT id, "productCode" AS code, name, "currentStock" AS current_stock, unit, exclusivity, status
       FROM sa.products WHERE category = 'OILS' ${statusFilter}
         AND (exclusivity IS NULL OR exclusivity = $1)
       ORDER BY "productCode"`,
      params
    )
    res.json(r.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
