const express = require('express')
const { sanitizeError } = require('../errors')
const bcrypt = require('bcryptjs')
const router = express.Router()
const { query } = require('../db')
const { auth, requireRole, makeToken, auditLog } = require('../auth')

function randomPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  let pw = ''
  for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)]
  return pw
}

router.post('/auth/login', async (req, res) => {
  try {
    const { name, password } = req.body
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' })
    const result = await query(
      `SELECT * FROM users WHERE LOWER(name) = LOWER($1)`,
      [name]
    )
    const user = result.rows[0]
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) return res.status(401).json({ error: 'Invalid credentials' })
    const token = makeToken(user)
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, must_change_password: user.must_change_password } })
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }) }
})

router.post('/auth/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
    const result = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id])
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (current_password) {
      const match = await bcrypt.compare(current_password, user.password_hash)
      if (!match) return res.status(401).json({ error: 'Current password incorrect' })
    }
    const hash = await bcrypt.hash(new_password, 10)
    await query(`UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`, [hash, req.user.id])
    res.json({ success: true })
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }) }
})

router.get('/users', auth, requireRole('root', 'admin'), async (req, res) => {
  try {
    const result = await query(`SELECT id, name, role, must_change_password, created_at FROM users ORDER BY name`)
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/users', auth, requireRole('root'), async (req, res) => {
  try {
    const { name, role } = req.body
    if (!name || !role) return res.status(400).json({ error: 'Name and role required' })
    const pw = randomPassword()
    const hash = await bcrypt.hash(pw, 10)
    const result = await query(
      `INSERT INTO users (name, password_hash, role, must_change_password) VALUES ($1,$2,$3,true) RETURNING id, name, role, must_change_password`,
      [name.trim(), hash, role]
    )
    await auditLog(req.user.id, 'user_created', 'user', result.rows[0].id, name, { role })
    res.status(201).json({ ...result.rows[0], temp_password: pw })
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Name already exists' })
    res.status(500).json({ error: sanitizeError(e) })
  }
})

router.put('/users/:id', auth, requireRole('root'), async (req, res) => {
  try {
    const { name, role } = req.body
    await query(
      `UPDATE users SET name = COALESCE($1, name), role = COALESCE($2, role) WHERE id = $3`,
      [name, role, req.params.id]
    )
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/users/:id/reset-password', auth, requireRole('root'), async (req, res) => {
  try {
    const pw = randomPassword()
    const hash = await bcrypt.hash(pw, 10)
    await query(`UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2`, [hash, req.params.id])
    res.json({ success: true, temp_password: pw })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/users/:id', auth, requireRole('root'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' })
    await query(`DELETE FROM users WHERE id = $1`, [req.params.id])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
