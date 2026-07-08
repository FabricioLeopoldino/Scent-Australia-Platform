const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth, requireRole } = require('../auth')

router.get('/audit', auth, requireRole('root', 'admin'), async (req, res) => {
  try {
    const { user_id, action, from, to } = req.query
    let q = `SELECT al.*, u.name as user_name FROM audit_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`
    const params = []
    if (user_id) { params.push(user_id); q += ` AND al.user_id = $${params.length}` }
    if (action) { params.push(action); q += ` AND al.action = $${params.length}` }
    if (from) { params.push(from); q += ` AND al.created_at >= $${params.length}` }
    if (to) { params.push(to); q += ` AND al.created_at <= $${params.length}` }
    q += ` ORDER BY al.created_at DESC LIMIT 1000`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
