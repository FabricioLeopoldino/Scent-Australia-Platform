import bcrypt from 'bcryptjs';
import { platformPool } from '../db.js';

// Platform schema — idempotent startup migrations (PRD §8).
// Creates the 3 module schemas and every platform.* table. Safe to run on
// every boot; CREATE ... IF NOT EXISTS throughout.
//
// NOTE: schema `sa` is POPULATED only by the migration script
// (scripts/migrate-sa.js — pg_dump restore + schema rename, PRD §11).
// Schema `sm` is populated by the SM module's own startup migrations (Phase 3a).
export async function runPlatformMigrations() {
  const q = (text) => platformPool.query(text);

  console.log('[platform-db] Running startup migrations...');

  // ── Module schemas ────────────────────────────────────────────────────
  await q(`CREATE SCHEMA IF NOT EXISTS platform`);
  await q(`CREATE SCHEMA IF NOT EXISTS sa`);
  await q(`CREATE SCHEMA IF NOT EXISTS sm`);

  // ── Users (imported from sa.users at Phase 2a; SA stores bcrypt in "password") ──
  await q(`
    CREATE TABLE IF NOT EXISTS platform.users (
      id                    SERIAL PRIMARY KEY,
      name                  VARCHAR(100) UNIQUE NOT NULL,
      password_hash         TEXT NOT NULL,
      role                  VARCHAR(20) NOT NULL DEFAULT 'user',
      must_change_password  BOOLEAN DEFAULT false,
      active                BOOLEAN DEFAULT true,
      sa_user_id            TEXT,
      created_at            TIMESTAMP DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS platform.user_modules (
      user_id  INTEGER NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
      module   VARCHAR(10) NOT NULL,
      PRIMARY KEY (user_id, module)
    )
  `);

  // ── Fragrance links SA <-> SM (phase 1: fragrance category only) ──────
  await q(`
    CREATE TABLE IF NOT EXISTS platform.product_links (
      id             SERIAL PRIMARY KEY,
      sa_product_id  TEXT NOT NULL,
      sm_product_id  INTEGER NOT NULL,
      sa_code        TEXT,
      sa_name        TEXT,
      sm_code        TEXT,
      sm_name        TEXT,
      category       VARCHAR(30) NOT NULL DEFAULT 'FRAGRANCE',
      created_by     INTEGER REFERENCES platform.users(id) ON DELETE SET NULL,
      created_at     TIMESTAMP DEFAULT NOW(),
      UNIQUE (sa_product_id),
      UNIQUE (sm_product_id)
    )
  `);

  // ── Two-step stock transfers ──────────────────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS platform.stock_transfers (
      id                  SERIAL PRIMARY KEY,
      product_link_id     INTEGER REFERENCES platform.product_links(id) ON DELETE SET NULL,
      direction           VARCHAR(10) NOT NULL DEFAULT 'SA_TO_SM',
      sa_product_id       TEXT NOT NULL,
      sm_product_id       INTEGER NOT NULL,
      quantity_ml         NUMERIC(14,3) NOT NULL,
      received_qty_ml     NUMERIC(14,3),
      status              VARCHAR(15) NOT NULL DEFAULT 'in_transit',
      discrepancy_reason  TEXT,
      notes               TEXT,
      sent_by             INTEGER REFERENCES platform.users(id) ON DELETE SET NULL,
      sent_at             TIMESTAMP DEFAULT NOW(),
      received_by         INTEGER REFERENCES platform.users(id) ON DELETE SET NULL,
      received_at         TIMESTAMP,
      sa_tx_out_id        TEXT,
      sm_tx_in_id         INTEGER
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_transfers_status ON platform.stock_transfers(status)`);

  // ── Shopify store config (secrets stay in env vars) ──────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS platform.shopify_stores (
      key          VARCHAR(20) PRIMARY KEY,
      domain       VARCHAR(120) NOT NULL,
      api_version  VARCHAR(15) NOT NULL DEFAULT '2025-01',
      topics       JSONB NOT NULL DEFAULT '[]',
      enabled      BOOLEAN DEFAULT true,
      updated_at   TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Platform-level audit ──────────────────────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS platform.audit_log (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES platform.users(id) ON DELETE SET NULL,
      action       VARCHAR(50) NOT NULL,
      entity_type  VARCHAR(50),
      entity_id    INTEGER,
      details      JSONB,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Seed root user if none exist (SA pattern: default password + forced change) ──
  // Replaced by the real SA user import at Phase 2a (scripts/migrate-sa.js).
  const userCount = await q(`SELECT COUNT(*) FROM platform.users`);
  if (parseInt(userCount.rows[0].count) === 0) {
    const hash = bcrypt.hashSync('#scent2026', 10);
    const seeded = await platformPool.query(
      `INSERT INTO platform.users (name, password_hash, role, must_change_password)
       VALUES ('Root', $1, 'root', true) RETURNING id`,
      [hash]
    );
    await platformPool.query(
      `INSERT INTO platform.user_modules (user_id, module) VALUES ($1, 'SA'), ($1, 'SM')
       ON CONFLICT DO NOTHING`,
      [seeded.rows[0].id]
    );
    console.log('[platform-db] Seeded root user — login: Root / #scent2026 (password change required)');
  }

  console.log('[platform-db] Migrations complete.');
}

// ── Cross-schema migrations (run AFTER runSaStartupMigrations) ──────────
// FR-XFER-9: sa.transactions carries a closed CHECK allowlist on `type`
// (and SA's own startup migration recreates it with only ITS list on every
// boot — so this must run after it, every boot, and also at the end of each
// SA re-migration). Adds the two transfer types. This is the one sanctioned
// exception to guardrail #7, scoped to exactly this constraint.
export async function runCrossSchemaMigrations() {
  await platformPool.query(`
    DO $$
    BEGIN
      ALTER TABLE sa.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
      ALTER TABLE sa.transactions ADD CONSTRAINT transactions_type_check
        CHECK (type IN (
          'add', 'remove', 'adjust', 'incoming', 'return',
          'shopify_sale', 'shopify_reversal',
          'formula_ready_used', 'formula_ready_restored',
          'tech_transfer_out', 'tech_transfer_in',
          'tech_remove',
          'tech_return_from_tech', 'tech_return_to_main',
          'tech_return_input',
          'transfer_out', 'transfer_cancel_return'
        ));
    END$$;
  `);
  console.log('[platform-db] Cross-schema migrations complete (transfer types in sa CHECK).');
}
