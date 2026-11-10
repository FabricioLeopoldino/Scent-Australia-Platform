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
    let statusFilter = `AND p.status = 'active'`
    if (req.query.include_inactive === '1') {
      statusFilter = ''
    }

    // Filtered in JS by canUseOil rather than in SQL. The rule lives in ONE
    // place — the same function the consumption lock and the registration
    // screen call — so the picker can never offer an oil that production will
    // then refuse, which is what a second copy of the rule in SQL invites.
    // ~270 rows; the cost of filtering here is nothing.
    //
    // `current_stock` is the oil's TOTAL across every company. `sectors` says
    // who holds it (the keys of shared/sectors.js; SA = the total minus what the
    // main store and the MUSE stocks hold, as sa/sectors.js sectorBalances does).
    // The MUSE screens showed the total under "Stock (SA)" (owner, 10 Nov 2026:
    // New York read 67.7 L in The Atelier, which held 20 L).
    const r = await query(
      `SELECT p.id, p.tag, p."productCode" AS code, p.name, p."currentStock" AS current_stock, p.unit, p.exclusivity, p.status,
              COALESCE(m.bin_location, p.bin_location) AS bin_location,
              COALESCE(h.main, 0) AS main, COALESCE(h.muse, 0) AS muse, COALESCE(h.muse_atelier, 0) AS muse_atelier,
              COALESCE(h.muse_library, 0) AS muse_library, COALESCE(h.muse_archive, 0) AS muse_archive, COALESCE(h.held, 0) AS held
       FROM sa.products p
       LEFT JOIN sa.sector_held h ON h.product_id = p.id
       LEFT JOIN sa.fragrance_registrations m ON m.product_id = p.id AND m.company = 'MUSE' AND m.active
       WHERE p.category = 'OILS' ${statusFilter}
       ORDER BY p."productCode"`
    )
    res.json(r.rows.filter((o) => canUseOil(o.exclusivity, seg.exclusivityBucket)).map(({ main, muse, muse_atelier, muse_library, muse_archive, held, ...o }) => ({
      ...o,
      sectors: {
        MAIN: Number(main), SA: Number(o.current_stock) - Number(held), MUSE: Number(muse),
        MUSE_ATELIER: Number(muse_atelier), MUSE_LIBRARY: Number(muse_library), MUSE_ARCHIVE: Number(muse_archive),
      },
    })))
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
