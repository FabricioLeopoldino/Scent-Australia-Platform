const express = require('express')
const router = express.Router()
const { query } = require('../db')
const { auth } = require('../auth')

router.get('/suppliers', auth, async (req, res) => {
  try {
    const { search } = req.query
    let q = `SELECT s.*, COUNT(p.id) as product_count FROM suppliers s LEFT JOIN products p ON p.supplier_id = s.id WHERE 1=1`
    const params = []
    if (search) { params.push(`%${search}%`); q += ` AND s.name ILIKE $${params.length}` }
    q += ` GROUP BY s.id ORDER BY s.name`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/suppliers', auth, async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, website, lead_time, notes } = req.body
    if (!name) return res.status(400).json({ error: 'Name required' })
    const result = await query(
      `INSERT INTO suppliers (name, contact_name, contact_email, contact_phone, website, lead_time, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, contact_name || null, contact_email || null, contact_phone || null, website || null, lead_time || null, notes || null]
    )
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.put('/suppliers/:id', auth, async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, website, lead_time, notes } = req.body
    const result = await query(
      `UPDATE suppliers SET name = COALESCE($1, name), contact_name = $2, contact_email = $3, contact_phone = $4, website = $5, lead_time = $6, notes = $7 WHERE id = $8 RETURNING *`,
      [name, contact_name ?? null, contact_email ?? null, contact_phone ?? null, website ?? null, lead_time ?? null, notes ?? null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/suppliers/:id', auth, async (req, res) => {
  try {
    await query(`DELETE FROM suppliers WHERE id = $1`, [req.params.id])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
