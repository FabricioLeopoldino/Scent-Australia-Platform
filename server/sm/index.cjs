// ═══════════════════════════════════════════════════════════════════════
// SM (Scented Merchandise / MUSE) module assembler — Phase 3a.
//
// CommonJS on purpose: this subtree keeps the original SM code byte-intact
// (see package.json {"type":"commonjs"} — PRD Appendix A step 9b). The ESM
// platform server imports THIS file via default-import interop.
//
// NOT mounted (deliberate):
//   - routes/auth.js       → login/users superseded by the platform (FR-SM-2)
//   - routes/reset.js      → destructive; stays unmounted (FR-SM-5)
//   - routes/shopify-oauth.js → token comes from env; OAuth flow is Phase 5
// Not started here: shopify-sync cron + webhook auto-registration (Phase 5).
// ═══════════════════════════════════════════════════════════════════════

const express = require('express')
const { query, runStartupMigrations } = require('./db')
const { smWebhookHandler } = require('./routes/webhooks')
const { startSyncCron, registerWebhooks } = require('./services/shopify-sync')

const smRouter = express.Router()

smRouter.use(require('./routes/suppliers'))
smRouter.use(require('./routes/products'))
smRouter.use(require('./routes/stock'))
smRouter.use(require('./routes/bom'))
smRouter.use(require('./routes/clients'))
smRouter.use(require('./routes/production-orders'))
smRouter.use(require('./routes/manufacturing'))
smRouter.use(require('./routes/dashboard'))
smRouter.use(require('./routes/audit'))
smRouter.use(require('./routes/packing'))
smRouter.use(require('./routes/shipping'))
smRouter.use(require('./routes/webhooks')) // draft-order + sync-status routes; its own /webhook path is dead behind auth (platform receiver owns webhooks)
smRouter.use(require('./routes/container-types'))
smRouter.use(require('./routes/masters'))
smRouter.use(require('./routes/major-clients'))
smRouter.use(require('./routes/fragrance-library')) // D14: the Cold Room oil picker for the BOM editor

// Router-scoped error handler (mirrors SA guardrail; sanitized in Phase 3b)
// eslint-disable-next-line no-unused-vars
smRouter.use((err, req, res, next) => {
  console.error('[sm] Unhandled route error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ── User mirror (same audit finding as SA, 2026-07-08) ──────────────────
// sm.audit_log / sm.transactions / sm.production_orders(created_by) /
// sm.client_*_transactions carry FKs to sm.users(id), and SM routes write
// req.user.id — the PLATFORM id. Every platform user is therefore mirrored
// into sm.users under the SAME id. Idempotent; runs at every boot after the
// SM migrations, and the platform Users API repeats it on create/delete.
async function syncPlatformUsersToSm() {
  await query(`
    INSERT INTO users (id, name, password_hash, role, must_change_password)
    SELECT p.id, p.name, p.password_hash, p.role, false
    FROM platform.users p
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
  `)
  await query(`
    SELECT setval(pg_get_serial_sequence('users','id'),
                  GREATEST((SELECT COALESCE(MAX(id),1) FROM users),
                           (SELECT COALESCE(MAX(id),1) FROM platform.users)))
  `)
  const broken = await query(`
    SELECT p.id, p.name FROM platform.users p
    LEFT JOIN users s ON s.id = p.id
    WHERE s.id IS NULL
  `)
  if (broken.rows.length > 0) {
    throw new Error('[sm] users id-alignment invariant broken: ' + JSON.stringify(broken.rows))
  }
  console.log('[sm] ✅ platform.users mirrored into sm.users (id-aligned).')
}

module.exports = {
  smRouter,
  runSmStartupMigrations: runStartupMigrations,
  syncPlatformUsersToSm,
  smWebhookHandler,
  smStartSyncCron: startSyncCron,
  smRegisterWebhooks: registerWebhooks,
}
