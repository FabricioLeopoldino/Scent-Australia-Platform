const express = require('express')
const router = express.Router()
const { query } = require('../db')
const { auth, auditLog } = require('../auth')

// List all container types (active by default)
router.get('/container-types', auth, async (req, res) => {
  try {
    const { include_archived } = req.query
    const q = include_archived === '1'
      ? `SELECT * FROM container_types ORDER BY archived ASC, name ASC`
      : `SELECT * FROM container_types WHERE archived = false ORDER BY name ASC`
    const result = await query(q)
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/container-types/:id', auth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM container_types WHERE id = $1`, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Container type not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/container-types', auth, async (req, res) => {
  try {
    const { name, code, is_candle, is_pure_oil, default_unit, notes } = req.body
    if (!name?.trim() || !code?.trim()) return res.status(400).json({ error: 'name and code required' })
    const result = await query(
      `INSERT INTO container_types (name, code, is_candle, is_pure_oil, default_unit, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), code.trim().toUpperCase(), !!is_candle, !!is_pure_oil, default_unit || 'ml', notes || null]
    )
    await auditLog(req.user.id, 'container_type_created', 'container_type', result.rows[0].id, name, { code, is_candle, is_pure_oil })
    res.status(201).json(result.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Container type code already exists' })
    res.status(500).json({ error: e.message })
  }
})

router.put('/container-types/:id', auth, async (req, res) => {
  try {
    const { name, code, is_candle, is_pure_oil, default_unit, notes } = req.body
    const result = await query(
      `UPDATE container_types
       SET name = COALESCE($1, name),
           code = COALESCE($2, code),
           is_candle = COALESCE($3, is_candle),
           is_pure_oil = COALESCE($4, is_pure_oil),
           default_unit = COALESCE($5, default_unit),
           notes = $6
       WHERE id = $7 RETURNING *`,
      [name, code?.toUpperCase(), is_candle, is_pure_oil, default_unit, notes ?? null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Container type not found' })
    await auditLog(req.user.id, 'container_type_updated', 'container_type', parseInt(req.params.id), result.rows[0].name, req.body)
    res.json(result.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Container type code already exists' })
    res.status(500).json({ error: e.message })
  }
})

// Restore archived container type
router.post('/container-types/:id/restore', auth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE container_types SET archived = false WHERE id = $1 RETURNING *`,
      [req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Container type not found' })
    await auditLog(req.user.id, 'container_type_restored', 'container_type', parseInt(req.params.id), result.rows[0].name, {})
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE — soft (archive) by default, hard delete with ?permanent=1
// Blocks if any active master uses it. Permanent delete also requires no archived references.
router.delete('/container-types/:id', auth, async (req, res) => {
  try {
    const permanent = req.query.permanent === '1'

    // Check usage by any product (including archived ones for permanent delete)
    const usage = await query(
      permanent
        ? `SELECT COUNT(*) as c FROM products WHERE container_type_id = $1`
        : `SELECT COUNT(*) as c FROM products WHERE container_type_id = $1 AND archived = false`,
      [req.params.id]
    )
    if (parseInt(usage.rows[0].c) > 0) {
      return res.status(400).json({ error: permanent
        ? `Cannot delete: ${usage.rows[0].c} product(s) reference this container type (including archived). Detach them first.`
        : `Cannot archive: ${usage.rows[0].c} master(s) still use this container type` })
    }

    if (permanent) {
      // Must be already archived to hard delete (2-step safety)
      const check = await query(`SELECT name, archived FROM container_types WHERE id = $1`, [req.params.id])
      if (!check.rows[0]) return res.status(404).json({ error: 'Container type not found' })
      if (!check.rows[0].archived) return res.status(400).json({ error: 'Archive first, then delete permanently' })
      await query(`DELETE FROM container_types WHERE id = $1`, [req.params.id])
      await auditLog(req.user.id, 'container_type_deleted', 'container_type', parseInt(req.params.id), check.rows[0].name, { permanent: true })
      return res.json({ success: true, deleted: true })
    }

    // Soft delete (archive)
    const result = await query(
      `UPDATE container_types SET archived = true WHERE id = $1 RETURNING name`,
      [req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Container type not found' })
    await auditLog(req.user.id, 'container_type_archived', 'container_type', parseInt(req.params.id), result.rows[0].name, {})
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
