// ═══════════════════════════════════════════════════════════════════════════
// MUSE CATALOG IMPORT — from SKU_mapping_MUSE.csv (the real MUSE Shopify store)
// ═══════════════════════════════════════════════════════════════════════════
// Creates, via the system's own API (server must be running on BASE):
//   - 3 MUSE masters:  RD200 (Reed Diffuser 200ml) · RS100 (Room Spray 100ml)
//                      · TS10 (Travel Spray 10ml)
//   - 1 fragrance per CSV row (FRAG_00001.. in CSV order, names cleaned)
//   - 1 variant per fragrance × master, then overrides the auto-assigned
//     MUS#### sku with the store's real SKU (Muse_RD/RS/TS#####); barcode = sku
//   - product links SA↔SM when the CSV has an SA product-code column
//     (auto-detected by header containing "sa" or values matching FRAG_\d+)
//
// Rerun-safe: fragrances matched by name, masters by code, variants upserted
// by the masters route (ON CONFLICT product_code), sku/link passes idempotent.
//
// Flags:
//   --reset-test   delete the pre-import test data first (RD200_TEST + its
//                  variants, test fragrances, their links/transfers/txs)
//   --links-only   skip creation; only (re)apply the SA-link pass
//
// Usage: node scripts/import-muse-catalog.js [--reset-test] [--links-only]
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const CSV = path.join(__dirname, '../../SKU_mapping_MUSE.csv');
const RESET = process.argv.includes('--reset-test');
const LINKS_ONLY = process.argv.includes('--links-only');

// Regression-suite fixtures only. NEVER put FRAG_##### codes here — the real
// catalog uses that sequence now (a past run briefly deleted 2 real
// fragrances; the same run recreated + relinked them, but don't repeat it).
const TEST_CODES = ['RD200_TEST', 'FRAG-SANTAL', 'FRAG-OUD'];
const MASTERS = [
  { code: 'RD200', name: 'Reed Diffuser 200ml', volume_ml: 200, csvCol: 'rd' },
  { code: 'RS100', name: 'Room Spray 100ml', volume_ml: 100, csvCol: 'rs' },
  { code: 'TS10', name: 'Travel Spray 10ml', volume_ml: 10, csvCol: 'ts' },
];

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

const direct = (process.env.PLATFORM_DATABASE_URL || '').replace('-pooler.', '.');
const smPool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sm' });
const saPool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sa' });
const platPool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false } });

const token = jwt.sign(
  { id: 1, name: 'Root', role: 'root', modules: ['SA', 'SM', 'MUSE'], must_change_password: false },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '30m' }
);
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function parseCsv() {
  const raw = fs.readFileSync(CSV, 'latin1');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().replace(/,/g, '').length);
  // Locate the header by CONTENT — a leading commas-only line gets filtered
  // out, so fixed indexes shift (this silently dropped the first fragrance,
  // "Adventure", in the first import run).
  const headerIdx = lines.findIndex((l) => /main fragrance/i.test(l));
  if (headerIdx === -1) { console.error('CSV header row not found'); process.exit(1); }
  const header = lines[headerIdx].split(',');
  // ALL columns resolved from the header by name — the owner reorders/adds
  // columns between versions (v2 put "Product_Code (SA)" first, shifting
  // every fixed index by one).
  const col = (re) => header.findIndex((h) => re.test(h));
  const nameCol = col(/main fragrance/i);
  const rdCol = col(/sku.*reed/i);
  const rsCol = col(/sku.*room/i);
  const tsCol = col(/sku.*travel/i);
  const saCol = col(/product[_ ]?code.*\bsa\b|\bsa\b.*(code|frag)/i);
  if (nameCol === -1 || rdCol === -1 || rsCol === -1 || tsCol === -1) {
    console.error('CSV columns not resolved:', { nameCol, rdCol, rsCol, tsCol });
    process.exit(1);
  }
  const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const rows = lines.slice(headerIdx + 1).map((l) => l.split(','));
  const frags = rows
    .map((r) => ({
      name: clean(r[nameCol]),
      rd: clean(r[rdCol]), rs: clean(r[rsCol]), ts: clean(r[tsCol]),
      saCode: saCol >= 0 ? clean(r[saCol]) : null,
    }))
    .filter((f) => f.name && /^Muse_RD\d+$/.test(f.rd));
  return { frags, saColFound: saCol >= 0 };
}

async function resetTestData() {
  console.log('\n── Reset test data ──');
  const prods = await smPool.query(
    `SELECT id, product_code FROM products
     WHERE product_code = ANY($1)
        OR master_product_id IN (SELECT id FROM products WHERE product_code = ANY($1))`,
    [TEST_CODES]
  );
  const ids = prods.rows.map((r) => r.id);
  if (!ids.length) { ok('reset: nothing to remove'); return; }
  // Test production orders referencing fixture masters must go too — their
  // lines dangle once the master is deleted (found by integrity-sm.cjs).
  const ords = await smPool.query(
    `SELECT DISTINCT production_order_id AS id FROM production_order_lines WHERE product_type = ANY($1)`,
    [TEST_CODES]
  );
  for (const o of ords.rows) {
    await smPool.query(`DELETE FROM production_order_lines WHERE production_order_id = $1`, [o.id]);
    await smPool.query(`DELETE FROM production_orders WHERE id = $1`, [o.id]);
  }
  const xf = await platPool.query(`DELETE FROM platform.stock_transfers WHERE sm_product_id = ANY($1) RETURNING id`, [ids]);
  const lk = await platPool.query(`DELETE FROM platform.product_links WHERE sm_product_id = ANY($1) RETURNING id`, [ids]);
  await smPool.query(`DELETE FROM transactions WHERE product_id = ANY($1)`, [ids]);
  await smPool.query(`DELETE FROM muse_master_fragrances WHERE master_product_id = ANY($1) OR fragrance_id = ANY($1)`, [ids]);
  await smPool.query(`DELETE FROM product_bom WHERE product_type IN (SELECT product_code FROM products WHERE id = ANY($1))`, [ids]);
  await smPool.query(`DELETE FROM products WHERE master_product_id = ANY($1)`, [ids]);
  const del = await smPool.query(`DELETE FROM products WHERE id = ANY($1) RETURNING product_code`, [ids]);
  ok('reset: test data removed', `${del.rowCount} products, ${lk.rowCount} links, ${xf.rowCount} transfers`);
}

async function run() {
  const { frags, saColFound } = parseCsv();
  console.log(`CSV: ${frags.length} fragrances · SA-code column: ${saColFound ? 'FOUND' : 'not present yet'}`);

  const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health || health.status !== 'ok') { console.error('Server not reachable on ' + BASE); process.exit(1); }

  if (!LINKS_ONLY) {
    if (RESET) await resetTestData();

    // ── 1. Fragrances (upsert by cleaned name) ────────────────────────────
    console.log('\n── Fragrances ──');
    const fragIds = new Map(); // name → sm product id
    let created = 0, reused = 0, seq = 0;
    const existing = await smPool.query(
      `SELECT id, name, product_code FROM products WHERE category = 'FRAGRANCE' AND COALESCE(archived,false) = false`
    );
    const byName = new Map(existing.rows.map((r) => [r.name.toLowerCase(), r]));
    const usedCodes = new Set(existing.rows.map((r) => r.product_code));
    for (const f of frags) {
      const hit = byName.get(f.name.toLowerCase());
      if (hit) { fragIds.set(f.name, hit.id); reused++; continue; }
      let code;
      do { seq++; code = `FRAG_${String(seq).padStart(5, '0')}`; } while (usedCodes.has(code));
      usedCodes.add(code);
      const r = await api('POST', '/api/sm/products', {
        name: f.name, product_code: code, category: 'FRAGRANCE', unit: 'mL', current_stock: 0,
      });
      if (r.status !== 201) { bad(`fragrance create: ${f.name}`, JSON.stringify(r.json)); continue; }
      fragIds.set(f.name, r.json.id);
      created++;
    }
    ok('fragrances ready', `${created} created, ${reused} reused`);

    // ── 2. Masters + variants (via the masters route → its own upserts) ───
    console.log('\n── Masters & variants ──');
    const allFragIds = [...fragIds.values()];
    for (const m of MASTERS) {
      const exists = await smPool.query(`SELECT id FROM products WHERE product_code = $1 AND is_master = true`, [m.code]);
      if (exists.rows[0]) {
        // idempotent second run: attach any new fragrances via PUT-less path — reuse POST /masters/:id/fragrances
        let attached = 0;
        for (const fid of allFragIds) {
          const r = await api('POST', `/api/sm/masters/${exists.rows[0].id}/fragrances`, { fragrance_id: fid });
          if (r.status === 201 || r.status === 200) attached++;
        }
        ok(`master ${m.code} existed`, `fragrance attach pass done (${attached} calls)`);
        continue;
      }
      const r = await api('POST', '/api/sm/masters', {
        name: m.name, product_code: m.code, segment: 'MUSE',
        volume_ml: m.volume_ml, volume_unit: 'ml',
        fragrance_ids: allFragIds, generate_variants: true,
      });
      if (r.status !== 201) { bad(`master ${m.code}`, JSON.stringify(r.json)); continue; }
      ok(`master ${m.code} created`, `${r.json.variants_created} variants`);
    }

    // ── 3. SKU override pass — store's real SKUs from the CSV ─────────────
    console.log('\n── Store SKUs ──');
    let skuSet = 0;
    for (const m of MASTERS) {
      const master = await smPool.query(`SELECT id FROM products WHERE product_code = $1 AND is_master = true`, [m.code]);
      if (!master.rows[0]) { bad(`sku pass: master ${m.code} missing`); continue; }
      for (const f of frags) {
        const fid = fragIds.get(f.name);
        const sku = f[m.csvCol];
        if (!fid || !sku) continue;
        const r = await smPool.query(
          `UPDATE products SET sku = $1, barcode = $1 WHERE master_product_id = $2 AND fragrance_id = $3`,
          [sku, master.rows[0].id, fid]
        );
        skuSet += r.rowCount;
      }
    }
    ok('store SKUs applied', `${skuSet} variants`);
  }

  // ── 4. SA link pass (when the CSV carries SA product codes) ─────────────
  if (saColFound) {
    console.log('\n── SA↔SM product links ──');
    let linked = 0, missing = [];
    for (const f of frags) {
      if (!f.saCode) continue;
      const sa = await saPool.query(
        `SELECT id, "productCode" AS code, name FROM products WHERE UPPER("productCode") = UPPER($1) AND category = 'OILS'`,
        [f.saCode]
      );
      if (!sa.rows[0]) { missing.push(`${f.name} → ${f.saCode}`); continue; }
      const sm = await smPool.query(
        `SELECT id, product_code, name FROM products WHERE LOWER(name) = LOWER($1) AND category = 'FRAGRANCE' AND COALESCE(archived,false) = false`,
        [f.name]
      );
      if (!sm.rows[0]) { missing.push(`${f.name} (not in SM)`); continue; }
      const r = await platPool.query(
        `INSERT INTO platform.product_links (sa_product_id, sm_product_id, sa_code, sa_name, sm_code, sm_name, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,1)
         ON CONFLICT DO NOTHING RETURNING id`,
        [sa.rows[0].id, sm.rows[0].id, sa.rows[0].code, sa.rows[0].name, sm.rows[0].product_code, sm.rows[0].name]
      );
      if (r.rowCount) linked++;
    }
    ok('links created', `${linked} new; ${missing.length} unresolved`);
    if (missing.length) console.log('  unresolved:\n   ' + missing.slice(0, 15).join('\n   '));
  } else if (LINKS_ONLY) {
    bad('links-only run but no SA-code column found in the CSV');
  }

  // ── 5. Verification ──────────────────────────────────────────────────────
  console.log('\n── Verification ──');
  const vFrag = await smPool.query(`SELECT COUNT(*) FROM products WHERE category='FRAGRANCE' AND COALESCE(archived,false)=false`);
  const vMast = await smPool.query(`SELECT COUNT(*) FROM products WHERE is_master = true AND segment='MUSE' AND archived = false`);
  const vVar = await smPool.query(`SELECT COUNT(*) FROM products WHERE master_product_id IS NOT NULL AND sku LIKE 'Muse_%'`);
  const vDup = await smPool.query(`SELECT sku, COUNT(*) FROM products WHERE sku LIKE 'Muse_%' GROUP BY sku HAVING COUNT(*) > 1`);
  const vLinks = await platPool.query(`SELECT COUNT(*) FROM platform.product_links`);
  console.log(`fragrances=${vFrag.rows[0].count} muse_masters=${vMast.rows[0].count} variants_with_store_sku=${vVar.rows[0].count} dup_skus=${vDup.rowCount} links=${vLinks.rows[0].count}`);
  if (vDup.rowCount === 0) ok('no duplicate store SKUs'); else bad('duplicate store SKUs', vDup.rows.map((r) => r.sku).join(','));
  const sample = await smPool.query(
    `SELECT v.name, v.sku, v.product_code FROM products v WHERE v.sku IN ('Muse_RD00001','Muse_RS00002','Muse_TS00003')ORDER BY v.sku`
  );
  sample.rows.forEach((s) => console.log(`  sample: ${s.sku} → ${s.name}`));

  console.log(`\n══════════ RESULT: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════════`);
  await smPool.end(); await saPool.end(); await platPool.end();
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
