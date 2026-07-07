import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { platformPool } from '../db.js';

// ── JWT secret (FR-AUTH-2: fail fast in production) ─────────────────────
export function getJwtSecret() {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PLATFORM_JWT_SECRET env var not set');
  }
  return 'dev-only-secret-change-in-production';
}

// Payload per PRD FR-AUTH-2: { id, name, role, modules[], must_change_password }
export function makeToken(user, modules) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      role: user.role,
      modules,
      must_change_password: user.must_change_password === true,
    },
    getJwtSecret(),
    { expiresIn: '12h' }
  );
}

// ── requireAuth (FR-AUTH-5) — applied app-level to /api/* ────────────────
// Public exemptions handled by the caller (login, webhooks, health).
export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), getJwtSecret());
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
  }
}

// ── requireModule (FR-AUTH-6) — gate on the module routers ──────────────
// Also enforces FR-AUTH-4 server-side: a pending password change blocks
// every module until resolved (only /api/platform/auth/* stays reachable).
export function requireModule(module) {
  return (req, res, next) => {
    if (req.user?.must_change_password) {
      return res.status(403).json({ error: 'Password change required before accessing modules' });
    }
    if (!Array.isArray(req.user?.modules) || !req.user.modules.includes(module)) {
      return res.status(403).json({ error: 'Module access denied' });
    }
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// ── Login rate limit (FR-AUTH-3) ─────────────────────────────────────────
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please try again in 15 minutes' },
});

// ── Platform audit log ────────────────────────────────────────────────────
export async function auditLog(userId, action, entityType, entityId, details) {
  try {
    await platformPool.query(
      `INSERT INTO platform.audit_log (user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId || null, action, entityType || null, entityId || null, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('[audit]', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
export async function getUserModules(userId) {
  const r = await platformPool.query(
    `SELECT module FROM platform.user_modules WHERE user_id = $1 ORDER BY module`,
    [userId]
  );
  return r.rows.map((row) => row.module);
}

export function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
