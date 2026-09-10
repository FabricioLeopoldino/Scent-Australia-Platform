import express from 'express';
import bcrypt from 'bcryptjs';
import { platformPool, saPool, smPool } from '../db.js';
import {
  makeToken,
  loginLimiter,
  requireRole,
  auditLog,
  getUserModules,
  generateTempPassword,
} from './auth.js';

const router = express.Router();

const VALID_ROLES = ['root', 'admin', 'user', 'technician'];
const VALID_MODULES = ['SA', 'SM', 'MUSE'];

function sanitizeModules(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((m) => VALID_MODULES.includes(m)))];
}

async function setUserModules(userId, modules) {
  await platformPool.query(`DELETE FROM platform.user_modules WHERE user_id = $1`, [userId]);
  for (const m of modules) {
    await platformPool.query(
      `INSERT INTO platform.user_modules (user_id, module) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, m]
    );
  }
}

// ID-alignment mirror (audit finding 2026-07-08): sa.audit_log/transactions/
// purchase_orders/scented_product_groups have FKs to sa.users(id), and SA
// routes write req.user.id (platform id). Every platform user must therefore
// exist in sa.users under the SAME id. Best-effort: before the SA migration
// runs, sa.users doesn't exist yet — warn and continue (SA module has no
// data to operate on in that state anyway).
async function mirrorUserToSa(user, passwordHash) {
  try {
    await saPool.query(
      `INSERT INTO users (id, name, password, role, must_change_password)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`,
      [user.id, user.name, passwordHash, user.role]
    );
    await saPool.query(
      `SELECT setval(pg_get_serial_sequence('users','id'),
                     GREATEST((SELECT COALESCE(MAX(id),1) FROM users), $1))`,
      [user.id]
    );
  } catch (e) {
    console.warn('[users] sa.users mirror skipped:', e.message);
  }
}

async function removeUserFromSa(userId) {
  try {
    await saPool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  } catch (e) {
    console.warn('[users] sa.users mirror-delete skipped:', e.message);
  }
}

// Same invariant for the SM schema (sm.audit_log/transactions/... FK sm.users)
async function mirrorUserToSm(user, passwordHash) {
  try {
    await smPool.query(
      `INSERT INTO users (id, name, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`,
      [user.id, user.name, passwordHash, user.role]
    );
    await smPool.query(
      `SELECT setval(pg_get_serial_sequence('users','id'),
                     GREATEST((SELECT COALESCE(MAX(id),1) FROM users), $1))`,
      [user.id]
    );
  } catch (e) {
    console.warn('[users] sm.users mirror skipped:', e.message);
  }
}

async function removeUserFromSm(userId) {
  try {
    await smPool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  } catch (e) {
    console.warn('[users] sm.users mirror-delete skipped:', e.message);
  }
}

function publicUser(row, modules) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    active: row.active,
    must_change_password: row.must_change_password === true,
    modules,
    is_warehouse_operator: row.is_warehouse_operator === true,
  };
}

// ════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════

// POST /api/platform/auth/login — public (exempted in server/index.js)
router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

    const result = await platformPool.query(
      `SELECT * FROM platform.users WHERE name = $1 AND active = true`,
      [name]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const modules = await getUserModules(user.id);
    const token = makeToken(user, modules);
    await auditLog(user.id, 'login', 'user', user.id, null);
    res.json({ token, user: publicUser(user, modules) });
  } catch (e) {
    console.error('[auth/login]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/platform/auth/change-password — self; re-issues token so the
// must_change_password gate unblocks without a re-login (FR-AUTH-4).
router.post('/auth/change-password', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (password.toLowerCase() === '#scent2026') {
      return res.status(400).json({ error: 'Please choose a different password' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const result = await platformPool.query(
      `UPDATE platform.users SET password_hash = $1, must_change_password = false
       WHERE id = $2 RETURNING *`,
      [hash, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    const modules = await getUserModules(user.id);
    await auditLog(user.id, 'password_changed', 'user', user.id, null);
    res.json({ success: true, token: makeToken(user, modules), user: publicUser(user, modules) });
  } catch (e) {
    console.error('[auth/change-password]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/platform/me
router.get('/me', async (req, res) => {
  try {
    const result = await platformPool.query(
      `SELECT * FROM platform.users WHERE id = $1 AND active = true`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const modules = await getUserModules(req.user.id);
    res.json(publicUser(result.rows[0], modules));
  } catch (e) {
    console.error('[me]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// USERS (root only — FR-USER)
// ════════════════════════════════════════════════════════════════════════

router.get('/users', requireRole('root'), async (_req, res) => {
  try {
    const users = await platformPool.query(
      `SELECT u.*, COALESCE(json_agg(um.module ORDER BY um.module)
              FILTER (WHERE um.module IS NOT NULL), '[]') AS modules,
              COALESCE(bool_or(wo.active), false) AS is_warehouse_operator
       FROM platform.users u
       LEFT JOIN platform.user_modules um ON um.user_id = u.id
       LEFT JOIN sa.warehouse_operators wo ON wo.user_id = u.id
       GROUP BY u.id
       ORDER BY u.id`
    );
    res.json(users.rows.map((r) => publicUser(r, r.modules)));
  } catch (e) {
    console.error('[users/list]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users', requireRole('root'), async (req, res) => {
  try {
    const { name, role, modules, is_warehouse_operator } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const tempPassword = generateTempPassword();
    const hash = bcrypt.hashSync(tempPassword, 10);
    const result = await platformPool.query(
      `INSERT INTO platform.users (name, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [name.trim(), hash, role]
    );
    const user = result.rows[0];

    // Default module access: technician → SA only (PRD §4); others as chosen.
    const requested = sanitizeModules(modules);
    const finalModules = role === 'technician' && requested.length === 0 ? ['SA'] : requested;
    await setUserModules(user.id, finalModules);

    // Keep sa.users + sm.users id-aligned (FK integrity for module audit/transactions)
    await mirrorUserToSa(user, hash);
    await mirrorUserToSm(user, hash);

    // Warehouse operator, from the same form (2026-09-02). "Who did this return"
    // used to need a separate, undiscoverable step — a name typed straight into
    // sa.warehouse_operators by hand, which is how a new hire's first day ran
    // into a dead end today. ON CONFLICT (name) links rather than duplicates:
    // Gustavo and Wanderson are already in that table with no login, by name
    // only, and the day either of them gets an account here, ticking this same
    // box attaches it to their existing record instead of creating a second
    // "Gustavo".
    if (is_warehouse_operator) {
      await platformPool.query(
        `INSERT INTO sa.warehouse_operators (name, user_id, active)
         VALUES ($1, $2, true)
         ON CONFLICT (name) DO UPDATE SET user_id = EXCLUDED.user_id, active = true`,
        [user.name, user.id]
      );
    }

    await auditLog(req.user.id, 'user_created', 'user', user.id, { name: user.name, role, modules: finalModules, is_warehouse_operator: !!is_warehouse_operator });
    res.status(201).json({ user: publicUser(user, finalModules), tempPassword });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A user with this name already exists' });
    console.error('[users/create]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/users/:id/modules', requireRole('root'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const target = await platformPool.query(`SELECT * FROM platform.users WHERE id = $1`, [userId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const finalModules = sanitizeModules(req.body?.modules);
    await setUserModules(userId, finalModules);
    await auditLog(req.user.id, 'module_access_changed', 'user', userId, {
      name: target.rows[0].name,
      modules: finalModules,
    });
    res.json({ success: true, modules: finalModules });
  } catch (e) {
    console.error('[users/modules]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ticking the box after account creation — the gap surfaced 2026-09-10:
// "Warehouse operator" only ever existed on the CREATE form, so an existing
// login had no self-service path at all, the exact dead end the checkbox was
// built to close, just for the case of an account made before this existed.
//
// Same linking rule as creation, so re-ticking someone never duplicates them:
// if this account is already linked to a sa.warehouse_operators row, flip
// its `active` flag; otherwise upsert by NAME, which is what catches a
// pre-existing no-login row sharing this person's name (Gustavo, Wanderson)
// instead of creating a second one.
//
// Turning it OFF deactivates, never deletes — their past picks in Returns
// must stay attributable to them.
router.put('/users/:id/warehouse-operator', requireRole('root'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const active = !!req.body?.active;
    const target = await platformPool.query(`SELECT id, name FROM platform.users WHERE id = $1`, [userId]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = target.rows[0];

    const existing = await platformPool.query(
      `SELECT id FROM sa.warehouse_operators WHERE user_id = $1`, [userId]);
    if (existing.rows.length) {
      await platformPool.query(
        `UPDATE sa.warehouse_operators SET active = $1 WHERE user_id = $2`, [active, userId]);
    } else if (active) {
      await platformPool.query(
        `INSERT INTO sa.warehouse_operators (name, user_id, active)
         VALUES ($1, $2, true)
         ON CONFLICT (name) DO UPDATE SET user_id = EXCLUDED.user_id, active = true`,
        [user.name, userId]);
    }
    // active:false with no existing row: already off, nothing to write.

    await auditLog(req.user.id, 'warehouse_operator_changed', 'user', userId, { name: user.name, active });
    res.json({ success: true, active });
  } catch (e) {
    console.error('[users/warehouse-operator]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Self or root (PRD §9)
router.put('/users/:id/password', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (req.user.id !== userId && req.user.role !== 'root') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { password } = req.body || {};
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const result = await platformPool.query(
      `UPDATE platform.users SET password_hash = $1, must_change_password = false WHERE id = $2 RETURNING id, name`,
      [hash, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.user.id, 'password_changed', 'user', userId, { name: result.rows[0].name });
    res.json({ success: true });
  } catch (e) {
    console.error('[users/password]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/reset-password', requireRole('root'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const tempPassword = generateTempPassword();
    const hash = bcrypt.hashSync(tempPassword, 10);
    const result = await platformPool.query(
      `UPDATE platform.users SET password_hash = $1, must_change_password = true WHERE id = $2 RETURNING id, name`,
      [hash, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.user.id, 'password_reset', 'user', userId, { name: result.rows[0].name });
    res.json({ tempPassword });
  } catch (e) {
    console.error('[users/reset]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', requireRole('root'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });

    const target = await platformPool.query(`SELECT * FROM platform.users WHERE id = $1`, [userId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    if (target.rows[0].role === 'root') {
      const roots = await platformPool.query(
        `SELECT COUNT(*) FROM platform.users WHERE role = 'root' AND active = true`
      );
      if (parseInt(roots.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last root user' });
      }
    }

    // History preserved: audit_log/transfers reference via ON DELETE SET NULL (FR-USER-4)
    await platformPool.query(`DELETE FROM platform.users WHERE id = $1`, [userId]);
    await removeUserFromSa(userId); // sa-side FKs nullify history, same as production SA
    await removeUserFromSm(userId); // sm-side FKs are ON DELETE SET NULL — history preserved
    await auditLog(req.user.id, 'user_deleted', 'user', userId, { name: target.rows[0].name });
    res.json({ success: true });
  } catch (e) {
    console.error('[users/delete]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
