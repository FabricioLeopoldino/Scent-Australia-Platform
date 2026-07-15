const { Pool, types } = require('pg')
const bcrypt = require('bcryptjs')

// Treat TIMESTAMP WITHOUT TIME ZONE columns as UTC (prevent double-shift from process.env.TZ)
types.setTypeParser(1114, val => new Date(val + 'Z'))

// PLATFORM PORT (Phase 3a): pool targets the platform DB with
// search_path=sm,public — unqualified SM queries resolve to schema sm with
// zero SQL changes (PRD §7.3). Direct endpoint required: Neon's pooler
// rejects the search_path startup option. Tuning per NFR-7.
const PLATFORM_URL = (process.env.PLATFORM_DATABASE_URL || '').replace('-pooler.', '.')

const pool = new Pool({
  connectionString: PLATFORM_URL,
  ssl: PLATFORM_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  options: '-c search_path=sm,public',
  max: 10,
  min: 0,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true,
})
pool.on('error', (err) => console.error('[sm-db] Pool error (non-fatal):', err.message))

async function query(text, params) {
  const client = await pool.connect()
  try {
    return await client.query(text, params)
  } finally {
    client.release()
  }
}

async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function runStartupMigrations() {
  console.log('[DB] Running startup migrations...')

  await query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password_hash TEXT NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'user', must_change_password BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS suppliers (id SERIAL PRIMARY KEY, name VARCHAR(150) NOT NULL, lead_time INTEGER, notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, product_code VARCHAR(50) UNIQUE NOT NULL, category VARCHAR(30) NOT NULL, sub_category VARCHAR(50), unit VARCHAR(20) NOT NULL DEFAULT 'units', current_stock DECIMAL DEFAULT 0, min_stock_level DECIMAL DEFAULT 0, supplier VARCHAR(150), supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, supplier_code VARCHAR(50), bin_location VARCHAR(50), barcode VARCHAR(100), shopify_variant_id BIGINT, lead_time INTEGER, notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, shopify_customer_id BIGINT, name VARCHAR(200) NOT NULL, email VARCHAR(150), phone VARCHAR(50), address TEXT, is_large_client BOOLEAN DEFAULT false, notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS client_labels (id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, label_name VARCHAR(200) NOT NULL, artwork_version VARCHAR(50) NOT NULL DEFAULT 'v1', supplier VARCHAR(150), quantity DECIMAL DEFAULT 0, is_obsolete BOOLEAN DEFAULT false, notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS client_label_transactions (id SERIAL PRIMARY KEY, client_label_id INTEGER NOT NULL REFERENCES client_labels(id) ON DELETE CASCADE, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, type VARCHAR(30) NOT NULL, quantity DECIMAL NOT NULL, production_order_id INTEGER, notes TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS client_stock (id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, product_code VARCHAR(50) NOT NULL, product_name VARCHAR(200) NOT NULL, category VARCHAR(30) NOT NULL DEFAULT 'COMPONENTS', barcode VARCHAR(100), unit VARCHAR(20) NOT NULL DEFAULT 'units', quantity DECIMAL DEFAULT 0, received_date DATE, notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS client_stock_transactions (id SERIAL PRIMARY KEY, client_stock_id INTEGER NOT NULL REFERENCES client_stock(id) ON DELETE CASCADE, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, type VARCHAR(30) NOT NULL, quantity DECIMAL NOT NULL, unit VARCHAR(20), production_order_id INTEGER, notes TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS client_product_bom (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, client_stock_id INTEGER REFERENCES client_stock(id) ON DELETE CASCADE, general_product_id INTEGER REFERENCES products(id) ON DELETE CASCADE, quantity_per_unit DECIMAL NOT NULL DEFAULT 1, unit VARCHAR(20) DEFAULT 'units', notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS production_orders (id SERIAL PRIMARY KEY, order_number VARCHAR(20) UNIQUE NOT NULL, shopify_draft_order_id BIGINT, shopify_order_id BIGINT, shopify_order_number VARCHAR(50), client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, order_type VARCHAR(20) NOT NULL DEFAULT 'STANDARD', due_date DATE, status VARCHAR(30) NOT NULL DEFAULT 'draft', notes TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS production_order_lines (id SERIAL PRIMARY KEY, production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE, line_number INTEGER NOT NULL, product_type VARCHAR(50) NOT NULL, fragrance_id INTEGER REFERENCES products(id) ON DELETE SET NULL, oil_pct DECIMAL DEFAULT 25.0, packaging_component_id INTEGER REFERENCES products(id) ON DELETE SET NULL, label_client_label_id INTEGER REFERENCES client_labels(id) ON DELETE SET NULL, quantity INTEGER NOT NULL, unit_price DECIMAL DEFAULT 0, is_candle BOOLEAN DEFAULT false, candle_status VARCHAR(30), sent_for_filling_at TIMESTAMP, filling_supplier TEXT, received_from_filling_at TIMESTAMP, fulfill_from_stock BOOLEAN DEFAULT false, labels_required BOOLEAN DEFAULT false, labels_ordered_at TIMESTAMP, labels_supplier TEXT, labels_eta DATE, labels_received BOOLEAN DEFAULT false, labels_received_at TIMESTAMP, line_status VARCHAR(30) DEFAULT 'pending', line_started_at TIMESTAMP, line_completed_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS production_order_components (id SERIAL PRIMARY KEY, production_order_line_id INTEGER NOT NULL REFERENCES production_order_lines(id) ON DELETE CASCADE, production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_code VARCHAR(50), product_name VARCHAR(200), source VARCHAR(30) NOT NULL DEFAULT 'general_stock', quantity_required DECIMAL NOT NULL, quantity_debited DECIMAL DEFAULT 0, unit VARCHAR(20), was_overridden BOOLEAN DEFAULT false, override_reason TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS stock_reservations (id SERIAL PRIMARY KEY, production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE, production_order_line_id INTEGER REFERENCES production_order_lines(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_code VARCHAR(50), source VARCHAR(30) NOT NULL DEFAULT 'general_stock', quantity_reserved DECIMAL NOT NULL, quantity_consumed DECIMAL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'reserved', created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS production_jobs (id SERIAL PRIMARY KEY, production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE, started_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP, started_by INTEGER REFERENCES users(id) ON DELETE SET NULL, status VARCHAR(30) NOT NULL DEFAULT 'in_production', external_type VARCHAR(30), external_supplier TEXT, external_sent_at TIMESTAMP, external_expected_at DATE, external_received_at TIMESTAMP, assembly_complete BOOLEAN DEFAULT false, labeling_complete BOOLEAN DEFAULT false, leftover_formula_ml DECIMAL, leftover_formula_oil_pct DECIMAL, leftover_labels_qty INTEGER, notes_on_completion TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS fragrance_strength_log (id SERIAL PRIMARY KEY, fragrance_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, fragrance_name VARCHAR(200), production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL, standard_pct DECIMAL NOT NULL DEFAULT 25.0, actual_pct_used DECIMAL NOT NULL, was_adjusted BOOLEAN DEFAULT false, adjustment_reason TEXT, batch_reference TEXT, date_used DATE, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_code VARCHAR(50), product_name VARCHAR(200), category VARCHAR(30), type VARCHAR(30) NOT NULL, quantity DECIMAL NOT NULL, unit VARCHAR(20), balance_after DECIMAL, notes TEXT, production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL, production_order_line_id INTEGER REFERENCES production_order_lines(id) ON DELETE SET NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS purchase_orders (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, order_number VARCHAR(50), quantity DECIMAL NOT NULL, quantity_received DECIMAL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'pending', notes TEXT, supplier VARCHAR(150), estimated_delivery_date DATE, added_by VARCHAR(100), created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS bom_rules (id SERIAL PRIMARY KEY, product_type VARCHAR(50) NOT NULL, component_type VARCHAR(30) NOT NULL, quantity_per_unit DECIMAL NOT NULL, unit VARCHAR(20), notes TEXT, UNIQUE(product_type, component_type))`)
  await query(`CREATE TABLE IF NOT EXISTS product_bom (id SERIAL PRIMARY KEY, product_type VARCHAR(50) NOT NULL, component_product_id INTEGER REFERENCES products(id) ON DELETE CASCADE, quantity_formula VARCHAR(30) NOT NULL DEFAULT 'fixed', quantity_per_unit DECIMAL NOT NULL DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(product_type, component_product_id))`)
  await query(`CREATE TABLE IF NOT EXISTS webhook_processed (id SERIAL PRIMARY KEY, shopify_order_id BIGINT NOT NULL, webhook_type VARCHAR(50) NOT NULL, processed_at TIMESTAMP DEFAULT NOW(), UNIQUE(shopify_order_id, webhook_type))`)
  await query(`CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action VARCHAR(50) NOT NULL, entity_type VARCHAR(50), entity_id INTEGER, entity_name VARCHAR(200), details JSONB, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS shipping_labels (id SERIAL PRIMARY KEY, production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE, carrier VARCHAR(50), service VARCHAR(100), tracking_number VARCHAR(150), label_url TEXT, shipment_id VARCHAR(150), rate DECIMAL, currency VARCHAR(10) DEFAULT 'AUD', status VARCHAR(20) DEFAULT 'active', notes TEXT, shipped_at TIMESTAMP, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS product_attachments (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, filename VARCHAR(255) NOT NULL, content_type VARCHAR(100) NOT NULL, attachment_type VARCHAR(50) NOT NULL DEFAULT 'document', version VARCHAR(50), expires_at DATE, file_size INTEGER, file_data TEXT NOT NULL, notes TEXT, uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS external_processing (id SERIAL PRIMARY KEY, production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, product_name VARCHAR(200) NOT NULL, processing_type VARCHAR(50) NOT NULL DEFAULT 'labels', qty_sent DECIMAL NOT NULL DEFAULT 0, qty_returned DECIMAL NOT NULL DEFAULT 0, sent_date DATE, expected_return DATE, actual_return DATE, status VARCHAR(30) NOT NULL DEFAULT 'sent', supplier VARCHAR(150), notes TEXT, created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS packing_records (id SERIAL PRIMARY KEY, production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE, client_name VARCHAR(200), pallet_count INTEGER NOT NULL DEFAULT 1, boxes_per_pallet INTEGER, products_per_box INTEGER, partial_boxes JSONB DEFAULT '[]', total_boxes INTEGER, total_products_packed INTEGER, packed_by VARCHAR(200), notes TEXT, photos JSONB DEFAULT '[]', created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS customer_sku_mappings (id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, external_sku VARCHAR(100) NOT NULL, external_name VARCHAR(200), notes TEXT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(client_id, product_id))`)
  await query(`CREATE TABLE IF NOT EXISTS product_bom_history (id SERIAL PRIMARY KEY, product_type VARCHAR(100) NOT NULL, component_type VARCHAR(100), component_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, quantity_per_unit DECIMAL, unit VARCHAR(20), component_group VARCHAR(20) DEFAULT 'core', version INTEGER NOT NULL, action VARCHAR(20) NOT NULL, changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, changed_at TIMESTAMP DEFAULT NOW(), snapshot JSONB)`)

  // ADD COLUMN migrations (idempotent)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data TEXT`)
  await query(`ALTER TABLE client_stock ADD COLUMN IF NOT EXISTS image_data TEXT`)
  await query(`ALTER TABLE client_labels ADD COLUMN IF NOT EXISTS image_data TEXT`)
  // MUSE finished-good SKU (MUS0001...) — distinct from product_code
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(20)`)
  // Container fields moved inline to products (was: container_types FK).
  // container_types table kept as deprecated/legacy for safety; nothing reads from it after migration.
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS container_name VARCHAR(100)`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_pure_oil BOOLEAN DEFAULT false`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_candle BOOLEAN DEFAULT false`)
  // Backfill from container_types (idempotent: only updates rows that haven't been migrated yet)
  await query(`
    UPDATE products p
    SET container_name = COALESCE(p.container_name, ct.name),
        is_pure_oil = COALESCE(p.is_pure_oil, ct.is_pure_oil, false),
        is_candle = COALESCE(p.is_candle, ct.is_candle, false)
    FROM container_types ct
    WHERE p.container_type_id = ct.id
      AND p.container_name IS NULL
  `).catch(() => {})
  await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name VARCHAR(150)`)
  await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_email VARCHAR(200)`)
  await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50)`)
  await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website VARCHAR(200)`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS needs_labeling BOOLEAN DEFAULT false`)
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS needs_packing BOOLEAN DEFAULT false`)
  await query(`ALTER TABLE product_bom ADD COLUMN IF NOT EXISTS component_group VARCHAR(20) DEFAULT 'core'`)
  await query(`ALTER TABLE production_order_components ADD COLUMN IF NOT EXISTS client_stock_id INTEGER REFERENCES client_stock(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS client_stock_id INTEGER REFERENCES client_stock(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE packing_records ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]'`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS volume_ml DECIMAL`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS default_oil_pct DECIMAL DEFAULT 25`)
  await query(`ALTER TABLE product_bom ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`)
  await query(`ALTER TABLE product_bom ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`)
  await query(`ALTER TABLE product_bom ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`)
  await query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS external_type VARCHAR(50)`)
  await query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS external_supplier TEXT`)
  await query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS external_expected_at DATE`)
  await query(`ALTER TABLE client_labels ADD COLUMN IF NOT EXISTS applicable_product_type VARCHAR(50)`)
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS labels_order_qty INTEGER`)
  await query(`ALTER TABLE external_processing ADD COLUMN IF NOT EXISTS client_label_id INTEGER REFERENCES client_labels(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE external_processing ADD COLUMN IF NOT EXISTS qty_requested DECIMAL`)
  await query(`ALTER TABLE external_processing ADD COLUMN IF NOT EXISTS short_return_reason TEXT`)
  await query(`ALTER TABLE external_processing ADD COLUMN IF NOT EXISTS production_order_line_id INTEGER REFERENCES production_order_lines(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE external_processing ALTER COLUMN qty_sent DROP NOT NULL`)
  await query(`ALTER TABLE external_processing ALTER COLUMN sent_date DROP NOT NULL`)
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS ready_formula_id INTEGER REFERENCES products(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS use_ready_formula BOOLEAN DEFAULT false`)
  // D14 Fragrance Library: the line's oil component now points at a Cold Room
  // oil (sa.products, a TEXT id like "OIL_175") instead of a separate sm
  // fragrance record. Additive + nullable — old fragrance_id stays for any
  // existing test row; new lines set oil_id and the debit at production
  // start (manufacturing.js) prefers it when present. Cross-schema FK is
  // fine — sa/sm are schemas in the SAME database, not separate databases.
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS oil_id TEXT REFERENCES sa.products(id) ON DELETE SET NULL`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pol_oil_id ON production_order_lines(oil_id)`)
  // Computed once at order creation (bom-builder.js), read once at production
  // start (manufacturing.js) — Fragrance Library oil is NOT reserved via
  // stock_reservations (D14.6: no cross-business reservation, direct debit
  // only), so the mL to debit has to be stored somewhere; the line itself is
  // simplest and avoids recomputing ready-formula scaling inconsistently
  // between order-creation time and start time.
  await query(`ALTER TABLE production_order_lines ADD COLUMN IF NOT EXISTS oil_qty_ml NUMERIC`)
  await query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS shopify_draft_order_number VARCHAR(20)`)
  // Shopify product sync (Diffusers and future finished-good publishing)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price DECIMAL`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_product_id BIGINT`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_inventory_item_id BIGINT`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMP`)

  // Data normalization
  await query(`UPDATE products SET category = 'RAW_MATERIAL' WHERE category = 'RAW_MATERIALS'`)
  await query(`UPDATE products SET category = 'COMPONENT' WHERE category = 'COMPONENTS'`)
  await query(`UPDATE client_stock SET category = 'COMPONENT' WHERE category = 'COMPONENTS'`)

  // Backfill production_order_line_id on EP records — match candle_filling EPs to their candle lines
  await query(`UPDATE external_processing ep
    SET production_order_line_id = pol.id
    FROM production_order_lines pol
    WHERE ep.production_order_line_id IS NULL
      AND ep.production_order_id = pol.production_order_id
      AND ep.processing_type = 'candle_filling'
      AND pol.product_type IN ('CANDLE_240G','CANDLE_400G')`)

  // Advance candle lines that already have a candle_filling EP but never had their line_status updated
  await query(`UPDATE production_order_lines pol
    SET candle_status = 'sent_for_filling', line_status = 'sent_for_filling',
        sent_for_filling_at = COALESCE(sent_for_filling_at, NOW())
    FROM external_processing ep
    WHERE ep.production_order_line_id = pol.id
      AND ep.processing_type = 'candle_filling'
      AND pol.product_type IN ('CANDLE_240G','CANDLE_400G')
      AND (pol.candle_status IS NULL OR pol.candle_status = 'pending')
      AND (pol.line_status IS NULL OR pol.line_status = 'pending')`)

  // EP status correction — records marked 'partial' but actually fully returned (labels use qty_requested as ref, others use qty_sent)
  await query(`UPDATE external_processing
    SET status = 'done', actual_return = COALESCE(actual_return, NOW())
    WHERE status = 'partial'
      AND processing_type = 'labels'
      AND qty_requested IS NOT NULL
      AND qty_returned >= qty_requested`)
  await query(`UPDATE external_processing
    SET status = 'done', actual_return = COALESCE(actual_return, NOW())
    WHERE status = 'partial'
      AND processing_type IN ('candle_filling','other')
      AND qty_sent IS NOT NULL
      AND qty_returned >= qty_sent`)

  // Orphan reservations cleanup — only mark 'consumed' if the order was actually started (has production_job).
  // Otherwise mark 'cancelled' since stock was never debited.
  // This prevents falsely showing reservations as consumed when stock was never actually debited
  // (e.g., orders that bypassed Start Production via waiting_external + Resume).
  await query(`UPDATE stock_reservations sr
    SET status = 'consumed', quantity_consumed = COALESCE(sr.quantity_consumed, sr.quantity_reserved)
    FROM production_orders po
    WHERE sr.production_order_id = po.id
      AND sr.status = 'reserved'
      AND po.status IN ('completed','fulfilled')
      AND EXISTS (SELECT 1 FROM production_jobs pj WHERE pj.production_order_id = po.id)`)
  await query(`UPDATE stock_reservations sr
    SET status = 'cancelled'
    FROM production_orders po
    WHERE sr.production_order_id = po.id
      AND sr.status = 'reserved'
      AND (po.status = 'cancelled'
        OR (po.status IN ('completed','fulfilled')
          AND NOT EXISTS (SELECT 1 FROM production_jobs pj WHERE pj.production_order_id = po.id)))`)

  // Indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_product_id ON transactions(product_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_prod_orders_status ON production_orders(status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_prod_orders_client ON production_orders(client_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_stock_reservations_order ON stock_reservations(production_order_id)`)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_reservations_uniq_general ON stock_reservations(production_order_id, product_id) WHERE product_id IS NOT NULL AND client_stock_id IS NULL`)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_reservations_uniq_client ON stock_reservations(production_order_id, client_stock_id) WHERE client_stock_id IS NOT NULL`)

  await query(`ALTER TABLE product_bom_history ALTER COLUMN quantity_per_unit DROP NOT NULL`)
  // SA-style auth: email becomes optional, login by name
  await query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`).catch(() => {})

  // Shopify retry queue
  await query(`
    CREATE TABLE IF NOT EXISTS pending_shopify_sync (
      id SERIAL PRIMARY KEY,
      action_type VARCHAR(50) NOT NULL,
      payload JSONB NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at TIMESTAMP DEFAULT NOW(),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_shopify_sync_status ON pending_shopify_sync(status, next_retry_at)`)

  // ═══════════════════════════════════════════════════════════════════
  // SEGMENTS REFACTOR (2026-05-15) — MUSE / Standard / Major
  // ═══════════════════════════════════════════════════════════════════

  // Container types — user-managed (Reed Diffuser, Room Spray, Candle, etc.)
  await query(`
    CREATE TABLE IF NOT EXISTS container_types (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      code VARCHAR(40) UNIQUE NOT NULL,
      is_candle BOOLEAN DEFAULT false,
      is_pure_oil BOOLEAN DEFAULT false,
      default_unit VARCHAR(10) DEFAULT 'ml',
      notes TEXT,
      archived BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Products: segment + master/variant hierarchy + container ref + volume unit
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS segment VARCHAR(20)`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_master BOOLEAN DEFAULT false`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS master_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS fragrance_id INTEGER REFERENCES products(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS container_type_id INTEGER REFERENCES container_types(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS volume_unit VARCHAR(10) DEFAULT 'ml'`)
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`)

  // MUSE: junction master ↔ available fragrances
  await query(`
    CREATE TABLE IF NOT EXISTS muse_master_fragrances (
      id SERIAL PRIMARY KEY,
      master_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      fragrance_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(master_product_id, fragrance_id)
    )
  `)

  // Major Client: junction master ↔ available fragrances
  await query(`
    CREATE TABLE IF NOT EXISTS major_client_master_fragrances (
      id SERIAL PRIMARY KEY,
      master_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      fragrance_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(master_product_id, fragrance_id)
    )
  `)

  // Reservation priority — 'high' (Major Client) | 'normal' (MUSE, Standard)
  await query(`ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'`)

  // Dashboard alerts — surface reservation displacements and other system events
  await query(`
    CREATE TABLE IF NOT EXISTS dashboard_alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      alert_type VARCHAR(40) NOT NULL,
      severity VARCHAR(10) DEFAULT 'warning',
      message TEXT NOT NULL,
      related_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE,
      related_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      acknowledged BOOLEAN DEFAULT false,
      acknowledged_at TIMESTAMP,
      acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Indexes for new tables
  await query(`CREATE INDEX IF NOT EXISTS idx_products_segment ON products(segment) WHERE segment IS NOT NULL`)
  await query(`CREATE INDEX IF NOT EXISTS idx_products_master_lookup ON products(segment, product_code, client_id) WHERE is_master = true`)
  await query(`CREATE INDEX IF NOT EXISTS idx_products_variant_lookup ON products(master_product_id, fragrance_id) WHERE master_product_id IS NOT NULL`)
  await query(`CREATE INDEX IF NOT EXISTS idx_products_container ON products(container_type_id) WHERE container_type_id IS NOT NULL`)
  await query(`CREATE INDEX IF NOT EXISTS idx_reservations_priority ON stock_reservations(product_id, priority, status) WHERE status = 'reserved'`)
  await query(`CREATE INDEX IF NOT EXISTS idx_dashboard_alerts_unack ON dashboard_alerts(acknowledged, created_at) WHERE acknowledged = false`)

  // Unique constraint: a master + fragrance combo can only have ONE variant per segment
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_uniq ON products(master_product_id, fragrance_id) WHERE master_product_id IS NOT NULL AND fragrance_id IS NOT NULL`)

  // Unified BOM: product_bom now supports client_stock entries directly (no need for separate client_product_bom table).
  // When client_stock_id is set, this BOM entry represents a client-owned component (instead of general product).
  await query(`ALTER TABLE product_bom ADD COLUMN IF NOT EXISTS client_stock_id INTEGER REFERENCES client_stock(id) ON DELETE SET NULL`)
  // Make component_product_id nullable (it's NULL when client_stock_id is set)
  await query(`ALTER TABLE product_bom ALTER COLUMN component_product_id DROP NOT NULL`).catch(() => {})

  // Migrate legacy client_product_bom rows → product_bom (idempotent: skips if already migrated)
  await query(`
    INSERT INTO product_bom (product_type, component_product_id, client_stock_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active, version)
    SELECT p.product_code, cpb.general_product_id, cpb.client_stock_id, 'fixed', cpb.quantity_per_unit, 0, 'core', true, 1
    FROM client_product_bom cpb
    JOIN products p ON cpb.product_id = p.id
    WHERE NOT EXISTS (
      SELECT 1 FROM product_bom pb
      WHERE pb.product_type = p.product_code
        AND (
          (pb.component_product_id IS NOT NULL AND pb.component_product_id = cpb.general_product_id)
          OR (pb.client_stock_id IS NOT NULL AND pb.client_stock_id = cpb.client_stock_id)
        )
    )
  `).catch((e) => console.warn('[DB] client_product_bom migration skipped:', e.message))

  // Default settings
  await query(`INSERT INTO system_settings (key, value) VALUES ('receiving_tolerance_pct','5') ON CONFLICT (key) DO NOTHING`)
  await query(`INSERT INTO system_settings (key, value) VALUES ('receiving_tolerance_units','0') ON CONFLICT (key) DO NOTHING`)

  // Seed default root user if none exist — name-only login, force password change (SA-style)
  const userCheck = await query(`SELECT COUNT(*) FROM users`)
  if (parseInt(userCheck.rows[0].count) === 0) {
    const hash = await bcrypt.hash('#scent2026', 10)
    await query(
      `INSERT INTO users (name, password_hash, role, must_change_password) VALUES ($1,$2,$3,$4)`,
      ['Root', hash, 'root', true]
    )
    console.log('[DB] Default root user created — login: Root / #scent2026 (will require password change)')
  }

  console.log('[DB] Migrations complete.')
}

module.exports = { pool, query, withTransaction, runStartupMigrations }
