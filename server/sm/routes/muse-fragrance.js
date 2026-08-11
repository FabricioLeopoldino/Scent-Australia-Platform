// Register a new MUSE fragrance: one Library oil in, three sellable variants
// out, with the store codes generated HERE.
//
// WHY (owner, 2026-08-11). Until now the Muse store was the source of the SKU:
// marketing created the product and typed the codes, and the platform matched
// what it found. That is how four products launched under the wrong code on
// 7 August, and eleven more were found selling wrong on 11 August. The owner's
// requirement is the SA model — "eu cadastro na plataforma e o Shopify recebe
// as SKU" — with one rule behind it:
//
//   THE SKU IS THE ONLY LINK. NEVER THE NAME.
//
// Marketing may rename, re-photograph, re-describe and re-categorise freely;
// nothing breaks, because nothing matches on any of that. What must never
// happen is the same code being typed on both sides and drifting. So the code
// is minted here, once, and travels outward.
//
// The number is NOT the oil's id. It is the position in the original MUSE
// fragrance list (Muse_RD00038 ↔ legacy fragrance 38), which holds for all 366
// variants alive today. That list is frozen at 124, so a new fragrance
// continues the sequence — 125 next. Gaps (79, 98) are deliberately NOT
// reused: their codes still sit on retired draft products in the store, and a
// reused number would resolve to the wrong thing there.
const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query, withTransaction } = require('../db')
const { auth, requireRole, auditLog } = require('../auth')

// The three formats a MUSE fragrance is sold in. `variantTitle` is the value
// under the store's "Choose Your Format" option — the same words the live
// catalogue uses, because the readiness check compares the code prefix against
// exactly these.
const FORMATS = [
  { master: 'TS10', prefix: 'TS', variantTitle: 'Travel Spray' },
  { master: 'RS100', prefix: 'RS', variantTitle: 'Room Spray' },
  { master: 'RD200', prefix: 'RD', variantTitle: 'Reed Diffuser' },
]
const pad = (n) => String(n).padStart(5, '0')

// What the next registration would look like. Reads only — the UI shows this
// for confirmation before anything is written, so nobody discovers the codes
// after the fact.
async function planFragrance(oilId, wanted) {
  const oil = (await query(
    `SELECT id, name, "productCode", "currentStock", status, exclusivity
       FROM sa.products WHERE id = $1 AND category = 'OILS'`, [oilId])).rows[0]
  if (!oil) throw Object.assign(new Error('Oil not found in the Fragrance Library'), { status: 404 })
  if (oil.status !== 'active') throw Object.assign(new Error(`Oil "${oil.name}" is not active`), { status: 400 })
  // Mirrors lockOil: an oil reserved for SA or SM would be accepted here and
  // then refused at production, leaving a sellable product that cannot be made.
  if (oil.exclusivity && oil.exclusivity !== 'MUSE') {
    throw Object.assign(new Error(`Oil "${oil.name}" is exclusive to ${oil.exclusivity} and cannot be sold as MUSE`), { status: 400 })
  }

  const masters = (await query(
    `SELECT id, product_code, name, volume_ml, default_oil_pct, price
       FROM products WHERE product_code = ANY($1::text[]) AND is_master = true`,
    [FORMATS.map((f) => f.master)])).rows
  const byCode = new Map(masters.map((m) => [m.product_code, m]))
  const missing = FORMATS.filter((f) => !byCode.has(f.master)).map((f) => f.master)
  if (missing.length) throw Object.assign(new Error(`Master product missing: ${missing.join(', ')}`), { status: 500 })

  // Continue the sequence; never fill a gap.
  const next = Number((await query(
    `SELECT COALESCE(MAX(substring(sku from '[0-9]+')::int), 0) + 1 AS n
       FROM products WHERE sku LIKE 'Muse\\_%'`)).rows[0].n)

  const pick = Array.isArray(wanted) && wanted.length ? FORMATS.filter((f) => wanted.includes(f.master)) : FORMATS
  const lines = pick.map((f) => {
    const m = byCode.get(f.master)
    return {
      master: f.master,
      master_id: m.id,
      format: f.variantTitle,
      sku: `Muse_${f.prefix}${pad(next)}`,
      product_code: `${f.master}-M${pad(next)}`,
      volume_ml: m.volume_ml,
      oil_pct: m.default_oil_pct,
      price: m.price == null ? null : Number(m.price),
    }
  })

  // The same oil legitimately sells under more than one commercial name (the
  // owner confirmed this: 7 oils do). So this is a warning to read, never a
  // refusal — but it is the first thing to check when the intent was actually
  // to reuse an existing product.
  const existing = (await query(
    `SELECT sku, name FROM products
      WHERE oil_id = $1 AND master_product_id IS NOT NULL AND COALESCE(archived,false) = false
      ORDER BY sku`, [oilId])).rows

  return {
    oil: { id: oil.id, name: oil.name, code: oil.productCode, stock: Number(oil.currentStock) },
    number: next,
    title: oil.name.trim(),
    lines,
    warnings: [
      ...(existing.length ? [`This oil already has ${existing.length} active MUSE variant(s): ${existing.map((e) => e.sku).join(', ')}. Registering again creates a SECOND commercial product for the same oil — intended only when it is sold under another name.`] : []),
      ...(Number(oil.currentStock) <= 0 ? [`The oil is at ${oil.currentStock}. The product can be created and sold, but nothing can be produced until stock arrives.`] : []),
      ...(lines.some((l) => l.price == null) ? ['One or more formats have no price on their master. Set it before publishing to the store.'] : []),
    ],
  }
}

// Step 2 of the screen: show exactly what will be created, write nothing.
router.get('/muse-fragrance/preview', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const formats = req.query.formats ? String(req.query.formats).split(',') : null
    res.json(await planFragrance(String(req.query.oil_id || ''), formats))
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : sanitizeError(e) }) }
})

// Step 3: create the variants. The store is NOT touched here — publishing is a
// separate, deliberate step (owner, 2026-08-11: platform first, store once it
// is seen working).
router.post('/muse-fragrance', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const { oil_id, title, formats, prices } = req.body || {}
    if (!oil_id) return res.status(400).json({ error: 'oil_id required' })

    const attempt = async () => await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p)
      const plan = await planFragrance(String(oil_id), formats)
      const name = String(title || plan.title).trim()
      if (!name) throw Object.assign(new Error('A title is required'), { status: 400 })

      const created = []
      for (const l of plan.lines) {
        const price = prices && prices[l.master] != null ? Number(prices[l.master]) : l.price
        const row = (await tq(
          // fragrance_id stays NULL on purpose. It is the legacy link, and a
          // fragrance registered after the migration has no legacy record to
          // point at. Setting it would also revive the double-charge fixed the
          // same day: with both ids present the BOM builder used to bill the
          // fragrance twice.
          `INSERT INTO products
             (name, product_code, sku, category, unit, current_stock, segment,
              master_product_id, oil_id, fragrance_id, volume_ml, default_oil_pct, price)
           VALUES ($1,$2,$3,'FINISHED_GOOD','units',0,'MUSE',$4,$5,NULL,$6,$7,$8) RETURNING id, sku, name`,
          [`${(await tq(`SELECT name FROM products WHERE id = $1`, [l.master_id])).rows[0].name} — ${name}`,
           l.product_code, l.sku, l.master_id, oil_id, l.volume_ml, l.oil_pct, price]
        )).rows[0]
        created.push({ ...row, master: l.master, format: l.format, price })
      }
      return { number: plan.number, title: name, oil: plan.oil, created, warnings: plan.warnings }
    })

    // Two people registering at once compute the same number; the unique index
    // added the same day turns that into a clean 23505 instead of two products
    // sharing a code. Retry picks up the next free number.
    let out
    for (let tries = 0; ; tries++) {
      try { out = await attempt(); break }
      catch (e) {
        const collision = e.code === '23505' && String(e.constraint || '').includes('sku')
        if (!collision || tries >= 4) throw e
        await new Promise((r) => setTimeout(r, 120 * (tries + 1)))
      }
    }

    for (const c of out.created) {
      await auditLog(req.user.id, 'muse_fragrance_registered', 'product', c.id, c.sku,
        { oil_id, number: out.number, title: out.title, master: c.master })
    }
    res.status(201).json(out)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : sanitizeError(e) })
  }
})

module.exports = router
module.exports.FORMATS = FORMATS
