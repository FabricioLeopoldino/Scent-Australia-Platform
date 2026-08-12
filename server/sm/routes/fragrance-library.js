const express = require('express')
const router = express.Router()
const { sanitizeError } = require('../errors')
const { auth } = require('../auth')
const { query } = require('../db')
const { SEGMENT_MAP, canUseOil } = require('../services/fragrance-library')

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
    let statusFilter = `AND status = 'active'`
    if (req.query.include_inactive === '1') {
      statusFilter = ''
    }

    // Filtered in JS by canUseOil rather than in SQL. The rule lives in ONE
    // place — the same function the consumption lock and the registration
    // screen call — so the picker can never offer an oil that production will
    // then refuse, which is what a second copy of the rule in SQL invites.
    // ~270 rows; the cost of filtering here is nothing.
    const r = await query(
      `SELECT id, "productCode" AS code, name, "currentStock" AS current_stock, unit, exclusivity, status
       FROM sa.products WHERE category = 'OILS' ${statusFilter}
       ORDER BY "productCode"`
    )
    res.json(r.rows.filter((o) => canUseOil(o.exclusivity, seg.exclusivityBucket)))
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
