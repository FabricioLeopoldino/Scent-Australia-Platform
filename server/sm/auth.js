const { query } = require('./db')

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM PORT (Phase 3a, FR-SM-2): the legacy unsigned-token auth
// (alg:'none' + base64 payload — forgeable by anyone) is DELETED.
// The platform's requireAuth middleware verifies the signed JWT app-wide
// and sets req.user before any SM route runs; requireModule('SM') gates the
// mount. The `auth` export keeps its per-route call sites untouched and
// simply asserts the platform populated req.user.
// makeToken was removed — SM has no login path anymore (routes/auth.js is
// intentionally NOT mounted; users live in platform.users, mirrored into
// sm.users for FK integrity).
// ═══════════════════════════════════════════════════════════════════════

function auth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'Forbidden' })
    next()
  }
}

async function auditLog(userId, action, entityType, entityId, entityName, details) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, action, entityType || null, entityId || null, entityName || null, details ? JSON.stringify(details) : null]
    )
  } catch (e) {
    console.error('[audit]', e.message)
  }
}

module.exports = { auth, requireRole, auditLog }
