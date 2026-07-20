// SM schema integrity battery — read-only, exit 1 on any failure.
require('dotenv').config();
const { Pool } = require('pg');
const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const sm = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sm' });
const plat = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false } });
const sa = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sa' });

let pass = 0, fail = 0;
const check = async (name, sql, pool = sm, expectZero = true) => {
  try {
    const r = await pool.query(sql);
    const n = parseInt(r.rows[0].n);
    if ((n === 0) === expectZero) { pass++; console.log(`PASS  ${name}${n ? ' — ' + n : ''}`); }
    else { fail++; console.log(`FAIL  ${name} — ${n}`); }
    return n;
  } catch (e) { fail++; console.log(`FAIL  ${name} — query error: ${e.message}`); }
};

(async () => {
  // ── identity invariant ──
  await check('user-id alignment: sm.users ids ⊇ platform.users ids',
    `SELECT COUNT(*) n FROM platform.users pu WHERE NOT EXISTS (SELECT 1 FROM sm.users su WHERE su.id = pu.id)`, plat);
  await check('user-id alignment: names match on shared ids',
    `SELECT COUNT(*) n FROM platform.users pu JOIN sm.users su ON su.id = pu.id WHERE su.name <> pu.name`, plat);

  // ── products ──
  // Negative stock is a hard invariant for raw materials / components (production
  // guards them). MUSE finished-good retail variants are EXEMPT: a Shopify sale
  // already shipped may legitimately drive them negative (D13 allow-negative,
  // 2026-07-20) — that is a permitted "investigate the physical count" state, not
  // a data-integrity failure. Identify a MUSE finished-good by its master's segment.
  await check('no negative stock (raw materials / components; MUSE retail finished goods exempt)',
    `SELECT COUNT(*) n FROM products v
     WHERE v.current_stock < 0
       AND NOT (v.master_product_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM products m WHERE m.id = v.master_product_id AND m.segment = 'MUSE'))`);
  await check('no duplicate product_code (active)', `SELECT COUNT(*) n FROM (SELECT product_code FROM products WHERE COALESCE(archived,false)=false GROUP BY product_code HAVING COUNT(*)>1) d`);
  await check('no duplicate sku (active, non-null)', `SELECT COUNT(*) n FROM (SELECT sku FROM products WHERE sku IS NOT NULL AND COALESCE(archived,false)=false GROUP BY sku HAVING COUNT(*)>1) d`);
  await check('variants: master exists & is_master', `SELECT COUNT(*) n FROM products v WHERE v.master_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products m WHERE m.id = v.master_product_id AND m.is_master = true)`);
  await check('variants: fragrance exists', `SELECT COUNT(*) n FROM products v WHERE v.fragrance_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products f WHERE f.id = v.fragrance_id)`);
  await check('active variants of archived masters', `SELECT COUNT(*) n FROM products v JOIN products m ON m.id = v.master_product_id WHERE COALESCE(v.archived,false)=false AND COALESCE(m.archived,false)=true`);
  // Regression-suite fixtures (FRAG-SANTAL/FRAG-OUD) seed lowercase 'ml' — excluded.
  await check('fragrances use mL unit', `SELECT COUNT(*) n FROM products WHERE category='FRAGRANCE' AND COALESCE(archived,false)=false AND unit <> 'mL' AND product_code NOT IN ('FRAG-SANTAL','FRAG-OUD')`);
  await check('MUSE masters have volume_ml', `SELECT COUNT(*) n FROM products WHERE is_master AND segment='MUSE' AND COALESCE(archived,false)=false AND (volume_ml IS NULL OR volume_ml <= 0)`);

  // ── muse master↔fragrance↔variant coherence ──
  await check('muse_master_fragrances: master exists', `SELECT COUNT(*) n FROM muse_master_fragrances mmf WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = mmf.master_product_id)`);
  await check('muse_master_fragrances: fragrance exists', `SELECT COUNT(*) n FROM muse_master_fragrances mmf WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = mmf.fragrance_id)`);
  await check('every MUSE master link has its variant', `SELECT COUNT(*) n FROM muse_master_fragrances mmf JOIN products m ON m.id = mmf.master_product_id WHERE COALESCE(m.archived,false)=false AND NOT EXISTS (SELECT 1 FROM products v WHERE v.master_product_id = mmf.master_product_id AND v.fragrance_id = mmf.fragrance_id AND COALESCE(v.archived,false)=false)`);
  await check('every active MUSE variant has its master link', `SELECT COUNT(*) n FROM products v JOIN products m ON m.id = v.master_product_id WHERE m.segment='MUSE' AND COALESCE(v.archived,false)=false AND NOT EXISTS (SELECT 1 FROM muse_master_fragrances mmf WHERE mmf.master_product_id = v.master_product_id AND mmf.fragrance_id = v.fragrance_id)`);

  // ── BOM ──
  await check('product_bom: product_type resolves to a product', `SELECT COUNT(*) n FROM product_bom b WHERE is_active AND NOT EXISTS (SELECT 1 FROM products p WHERE p.product_code = b.product_type)`);
  await check('product_bom: component exists (when product ref)', `SELECT COUNT(*) n FROM product_bom b WHERE is_active AND b.component_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = b.component_product_id)`);

  // ── transactions ──
  await check('transactions: product exists', `SELECT COUNT(*) n FROM transactions t WHERE t.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = t.product_id)`);
  await check('transactions: user exists (when set)', `SELECT COUNT(*) n FROM transactions t WHERE t.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id)`);

  // ── production orders ──
  await check('order lines: product/master resolves', `SELECT COUNT(*) n FROM production_order_lines l WHERE l.product_type IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.product_code = l.product_type)`);
  await check('order lines: order exists', `SELECT COUNT(*) n FROM production_order_lines l WHERE NOT EXISTS (SELECT 1 FROM production_orders o WHERE o.id = l.production_order_id)`);

  // ── client stock ──
  await check('client_stock: no negatives', `SELECT COUNT(*) n FROM client_stock WHERE quantity < 0`);
  await check('client_stock: client exists', `SELECT COUNT(*) n FROM client_stock cs WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = cs.client_id)`);

  // ── platform links & transfers ──
  await check('links: sm product exists', `SELECT COUNT(*) n FROM platform.product_links l WHERE NOT EXISTS (SELECT 1 FROM sm.products p WHERE p.id = l.sm_product_id)`, plat);
  await check('links: sa product exists', `SELECT COUNT(*) n FROM platform.product_links l WHERE NOT EXISTS (SELECT 1 FROM sa.products p WHERE p.id = l.sa_product_id)`, plat);
  await check('links: sm side is FRAGRANCE', `SELECT COUNT(*) n FROM platform.product_links l JOIN sm.products p ON p.id = l.sm_product_id WHERE p.category <> 'FRAGRANCE'`, plat);
  await check('transfers: link exists (when set)', `SELECT COUNT(*) n FROM platform.stock_transfers t WHERE t.product_link_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform.product_links l WHERE l.id = t.product_link_id)`, plat);
  await check('transfers: no stuck negative/zero qty', `SELECT COUNT(*) n FROM platform.stock_transfers WHERE quantity_ml <= 0`, plat);

  console.log(`\n══════ INTEGRITY: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end(); await plat.end(); await sa.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
