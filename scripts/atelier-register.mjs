// Register The Atelier in the platform: its four formats and its 348 products
// (PRD_MUSE_ATELIER.md, owner decisions of 16 Nov 2026).
//
// WHY. The MUSE store sells The Atelier — 87 Library fragrances, each as a Room
// Spray, a Reed Diffuser, a Travel Spray and a Candle, under the customer's own
// label. The store's variants got their codes on 16 Nov 2026
// (MUSE-ATL-<RS|RD|TS|CA>-<Library number>); the platform knew none of them, so
// a sale would arrive as "SKU not found".
//
// What it applies:
//   · Four masters in the unit "atelier". An Atelier product is the Library's
//     product with the customer's label instead of the MUSE one (owner, 16
//     Nov), so each recipe is the Library master's active recipe WITHOUT its
//     MUSE labels. The customer's label is printed per order and is not stock.
//   · The candle is 200 g, 12% oil, filled outside (D17). Its recipe is the
//     jar only: the customer picks a black or a white box and the store does
//     not ask which yet, so whoever produces picks the box (owner, 16 Nov).
//   · 348 products, each on the oil of the Library product with the same
//     number. A candle names the ORDINARY oil; where a candle version exists
//     the platform pours that one by itself.
//   · Every oil's MUSE registration also names The Atelier as a user.
//   · The 46 old "MUSE- Atelier Candle 250G" products and their master are
//     archived — only if none holds stock or has any movement or production.
//
// It creates only what is missing and never changes a row that exists, so it
// can be run again. One transaction: all of it or none of it.
//
//   node scripts/atelier-register.mjs                         # dry run on the test copy
//   node scripts/atelier-register.mjs --apply                 # writes, test copy
//   node scripts/atelier-register.mjs --production            # dry run on live
//   node scripts/atelier-register.mjs --production --apply    # writes on live
//
// The test copy is read from SECTORS_DEV_DATABASE_URL; live from PLATFORM_DATABASE_URL.
import 'dotenv/config';
import pkg from 'pg';

const APPLY = process.argv.includes('--apply');
const LIVE = process.argv.includes('--production');
const url = (LIVE ? process.env.PLATFORM_DATABASE_URL : process.env.SECTORS_DEV_DATABASE_URL) || '';
if (LIVE ? !url.includes('ep-cold-fog-') : !url.includes('ep-old-water-')) {
  console.error(`Refusing: the ${LIVE ? 'live' : 'test copy'} database URL is not the expected one.`);
  process.exit(1);
}

// Prices are the store's (read 16 Nov 2026). `from` is the Library master whose recipe is copied.
const MASTERS = [
  { code: 'ATL_RS100', name: 'Atelier Room Spray 100ml', suffix: 'RS', volume: 100, unit: 'ml', oilPct: 25, candle: false, price: 24.2, from: 'RS100' },
  { code: 'ATL_RD200', name: 'Atelier Reed Diffuser 200ml', suffix: 'RD', volume: 200, unit: 'ml', oilPct: 25, candle: false, price: 33, from: 'RD200' },
  { code: 'ATL_TS10', name: 'Atelier Travel Spray 10ml', suffix: 'TS', volume: 10, unit: 'ml', oilPct: 25, candle: false, price: 12.1, from: 'TS10' },
  { code: 'ATL_CA200', name: 'Atelier Candle 200g', suffix: 'CA', volume: 200, unit: 'g', oilPct: 12, candle: true, price: 29.15, from: null },
];
const CANDLE_JAR = 'COMP_00020'; // MUSE 200g Matte Black Candle Jar
// The Library numbers of the 87 fragrances the store offers in The Atelier.
const NUMBERS = [1, 2, 3, 4, 7, 8, 10, 11, 12, 13, 14, 16, 17, 18, 20, 22, 23, 24, 25, 26, 28, 30, 31, 32, 33, 35, 36, 37, 39, 40, 42, 43, 44,
  45, 46, 47, 49, 51, 52, 53, 54, 56, 59, 61, 62, 64, 67, 68, 69, 72, 73, 74, 75, 76, 78, 81, 82, 83, 85, 86, 87, 88, 90, 91, 93, 94, 96, 97,
  101, 103, 105, 106, 107, 109, 110, 111, 112, 114, 115, 116, 117, 119, 120, 121, 122, 123, 124];
const OLD_CANDLE = 'MUSE00001'; // "MUSE- Atelier Candle 250G"
const NOTE = 'script atelier-register.mjs (PRD_MUSE_ATELIER.md)';
const pad = (n) => String(n).padStart(5, '0');

const client = new pkg.Client({ connectionString: url.replace(/[?&]channel_binding=require/, ''), ssl: { rejectUnauthorized: true } });
await client.connect();
const q = (sql, p) => client.query(sql, p);
const did = { masters: 0, recipes: 0, products: 0, registrations: 0, widened: 0, retired: 0 };
const say = (s) => console.log(s);

try {
  await q('BEGIN');
  say(`${LIVE ? 'LIVE' : 'TEST COPY'} — ${APPLY ? 'APPLYING' : 'dry run, nothing is written'}\n`);

  // ── The fragrances, read first: a number with no usable Library product stops everything before any write.
  const fragrances = [];
  for (const n of NUMBERS) {
    const lib = (await q(
      `SELECT v.name, v.oil_id, o."productCode" AS oil_code, o.name AS oil_name, o.status, o.exclusivity
         FROM sm.products v LEFT JOIN sa.products o ON o.id = v.oil_id
        WHERE v.sku = $1 AND NOT COALESCE(v.archived, false)`, [`Muse_RS${pad(n)}`])).rows[0];
    if (!lib) throw new Error(`no live Library product Muse_RS${pad(n)} to take the fragrance from`);
    if (!lib.oil_id || !lib.oil_code) throw new Error(`Muse_RS${pad(n)} "${lib.name}" has no oil`);
    if ((lib.status || 'active') !== 'active') throw new Error(`oil ${lib.oil_code} "${lib.oil_name}" (Muse_RS${pad(n)}) is not active`);
    if (lib.exclusivity && !['MUSE', 'SM', 'SHARED'].includes(lib.exclusivity)) throw new Error(`oil ${lib.oil_code} is restricted to ${lib.exclusivity} and cannot be sold as MUSE`);
    fragrances.push({ n, title: lib.name.split(' — ').slice(1).join(' — ') || lib.name, oilId: lib.oil_id, oilCode: lib.oil_code, oilName: lib.oil_name });
  }

  // ── The four formats and their recipes.
  say('FORMATS');
  const masterId = new Map();
  for (const m of MASTERS) {
    let row = (await q(`SELECT id, name, business_unit FROM sm.products WHERE product_code = $1`, [m.code])).rows[0];
    if (row) {
      if (row.business_unit !== 'atelier') throw new Error(`${m.code} exists but is not in the unit atelier`);
      say(`  = ${m.code}  already there ("${row.name}")`);
    } else {
      row = (await q(
        `INSERT INTO sm.products (name, product_code, category, segment, is_master, volume_ml, volume_unit, default_oil_pct,
                                  is_pure_oil, is_candle, unit, current_stock, price, business_unit, notes)
         VALUES ($1,$2,'FINISHED_GOOD','MUSE',true,$3,$4,$5,false,$6,'units',0,$7,'atelier',$8) RETURNING id`,
        [m.name, m.code, m.volume, m.unit, m.oilPct, m.candle, m.price, NOTE])).rows[0];
      await q(`INSERT INTO sm.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'master_created','product',$1,$2,$3)`,
        [row.id, m.name, JSON.stringify({ product_code: m.code, segment: 'MUSE', business_unit: 'atelier', is_candle: m.candle, note: NOTE })]);
      did.masters++;
      say(`  + ${m.code}  "${m.name}"  ${m.volume} ${m.unit}, ${m.oilPct}% oil${m.candle ? ', candle (filled outside)' : ''}, $${m.price}`);
    }
    masterId.set(m.code, row.id);

    if ((await q(`SELECT 1 FROM sm.product_bom WHERE product_type = $1 AND is_active`, [m.code])).rows.length) {
      say(`      recipe already has lines — left as it is`);
      continue;
    }
    // The Library's recipe without its MUSE labels; the candle, its jar.
    const lines = m.from
      ? (await q(
        `SELECT b.component_product_id, b.quantity_formula, b.quantity_per_unit, b.sort_order, b.component_group, p.product_code, p.category
           FROM sm.product_bom b JOIN sm.products p ON p.id = b.component_product_id
          WHERE b.product_type = $1 AND b.is_active ORDER BY b.sort_order, b.id`, [m.from])).rows
      : (await q(
        `SELECT id AS component_product_id, 'fixed' AS quantity_formula, 1 AS quantity_per_unit, 0 AS sort_order, 'core' AS component_group, product_code, category
           FROM sm.products WHERE product_code = $1 AND NOT COALESCE(archived, false)`, [CANDLE_JAR])).rows;
    const kept = lines.filter((l) => l.category !== 'LABEL');
    if (!kept.length) { say(`      ! nothing to build the recipe from (${m.from || CANDLE_JAR}) — it stays empty`); continue; }
    for (const l of kept) {
      await q(`INSERT INTO sm.product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
               VALUES ($1,$2,$3,$4,$5,$6,true)`, [m.code, l.component_product_id, l.quantity_formula, l.quantity_per_unit, l.sort_order, l.component_group]);
      did.recipes++;
    }
    const left = lines.filter((l) => l.category === 'LABEL').map((l) => l.product_code);
    say(`      recipe: ${kept.map((l) => l.product_code).join(', ')}${m.from ? ` (as ${m.from}${left.length ? `, without the MUSE labels ${left.join(', ')}` : ''})` : ' (the jar only; the box is picked when producing)'}`);
  }

  // ── The 348 products.
  say('\nPRODUCTS');
  for (const f of fragrances) {
    const line = [];
    for (const m of MASTERS) {
      const sku = `MUSE-ATL-${m.suffix}-${pad(f.n)}`;
      const code = `${m.code}-FRAG_${pad(f.n)}`;
      const there = (await q(`SELECT id, sku, product_code, oil_id, business_unit, master_product_id FROM sm.products WHERE sku = $1 OR product_code = $2`, [sku, code])).rows;
      if (there.length) {
        const t = there[0];
        if (there.length > 1 || t.sku !== sku || t.product_code !== code || t.oil_id !== f.oilId || t.business_unit !== 'atelier' || t.master_product_id !== masterId.get(m.code)) {
          throw new Error(`${sku} / ${code} exists but not as this script would create it (oil ${t.oil_id}, unit ${t.business_unit}) — stopping, nothing changed`);
        }
        line.push('=');
        continue;
      }
      const row = (await q(
        `INSERT INTO sm.products (name, product_code, sku, barcode, category, unit, current_stock, segment,
                                  master_product_id, oil_id, fragrance_id, volume_ml, default_oil_pct, price, business_unit)
         VALUES ($1,$2,$3,$3,'FINISHED_GOOD','units',0,'MUSE',$4,$5,NULL,$6,$7,$8,'atelier') RETURNING id`,
        [`${m.name} — ${f.title}`, code, sku, masterId.get(m.code), f.oilId, m.volume, m.oilPct, m.price])).rows[0];
      await q(`INSERT INTO sm.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'muse_fragrance_registered','product',$1,$2,$3)`,
        [row.id, sku, JSON.stringify({ oil_id: f.oilId, oil: f.oilCode, title: f.title, master: m.code, business_unit: 'atelier', note: NOTE })]);
      did.products++;
      line.push('+');
    }
    say(`  ${pad(f.n)} ${f.title.slice(0, 40).padEnd(40)} ${f.oilCode.padEnd(10)} RS RD TS CA: ${line.join(' ')}`);
  }

  // ── Every oil's MUSE registration also names The Atelier.
  say('\nOILS REGISTERED FOR MUSE');
  const seen = new Set();
  for (const f of fragrances) {
    if (seen.has(f.oilId)) continue;
    seen.add(f.oilId);
    const reg = (await q(`SELECT id, used_by FROM sa.fragrance_registrations WHERE product_id = $1 AND company = 'MUSE' FOR UPDATE`, [f.oilId])).rows[0];
    if (!reg) {
      await q(`INSERT INTO sa.fragrance_registrations (product_id, company, commercial_name, used_by, active) VALUES ($1,'MUSE',$2,ARRAY['MUSE_ATELIER'],true)`, [f.oilId, f.title]);
      await q(`INSERT INTO sa.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'fragrance_registered','product',$1,$2,$3)`,
        [f.oilId, f.oilName, JSON.stringify({ company: 'MUSE', commercial_name: f.title, used_by: ['MUSE_ATELIER'], active: true, note: NOTE })]);
      did.registrations++;
      say(`  + ${f.oilCode}  registered for MUSE as "${f.title}", used by The Atelier`);
    } else if (!reg.used_by.includes('MUSE_ATELIER')) {
      await q(`UPDATE sa.fragrance_registrations SET used_by = array_append(used_by, 'MUSE_ATELIER'), updated_at = NOW() WHERE id = $1`, [reg.id]);
      await q(`INSERT INTO sa.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'fragrance_registration_updated','product',$1,$2,$3)`,
        [f.oilId, f.oilName, JSON.stringify({ company: 'MUSE', changes: { used_by: { from: reg.used_by, to: [...reg.used_by, 'MUSE_ATELIER'] } }, note: NOTE })]);
      did.widened++;
    }
  }
  say(`  ${seen.size} oil(s): ${did.registrations} newly registered for MUSE, ${did.widened} had The Atelier added, ${seen.size - did.registrations - did.widened} already named it`);

  // ── The old 250 g candle: archived, only if nothing ever happened on it.
  say('\nOLD "ATELIER CANDLE 250G"');
  const old = (await q(`SELECT id, name, COALESCE(archived, false) AS archived FROM sm.products WHERE product_code = $1 AND is_master`, [OLD_CANDLE])).rows[0];
  if (!old) say(`  no ${OLD_CANDLE} master here — nothing to retire`);
  else {
    const facts = (await q(
      `SELECT (SELECT COUNT(*) FROM sm.products v WHERE v.master_product_id = $1 AND NOT COALESCE(v.archived, false))::int AS live,
              (SELECT COUNT(*) FROM sm.products v WHERE v.master_product_id = $1 AND v.current_stock <> 0)::int AS with_stock,
              (SELECT COUNT(*) FROM sm.transactions t JOIN sm.products v ON v.id = t.product_id WHERE v.master_product_id = $1)::int AS movements,
              (SELECT COUNT(*) FROM sm.production_order_lines l WHERE l.product_type = $2)::int AS production_lines`, [old.id, OLD_CANDLE])).rows[0];
    if (old.archived && !facts.live) say(`  = already archived`);
    else if (facts.with_stock || facts.movements || facts.production_lines) {
      say(`  ! left as it is: ${facts.with_stock} product(s) with stock, ${facts.movements} movement(s), ${facts.production_lines} production line(s). Tell the owner.`);
    } else {
      await q(`UPDATE sm.products SET archived = true WHERE master_product_id = $1 AND NOT COALESCE(archived, false)`, [old.id]);
      await q(`UPDATE sm.products SET archived = true WHERE id = $1`, [old.id]);
      await q(`INSERT INTO sm.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'master_archived','product',$1,$2,$3)`,
        [old.id, old.name, JSON.stringify({ segment: 'MUSE', variants_archived: facts.live, replaced_by: 'ATL_CA200', note: NOTE })]);
      did.retired = facts.live;
      say(`  - "${old.name}" and its ${facts.live} product(s) archived (no stock, no movement, no production). Replaced by ATL_CA200.`);
    }
  }

  say(`\n${did.masters} format(s), ${did.recipes} recipe line(s), ${did.products} product(s), ${did.registrations} new MUSE registration(s), ${did.widened} widened, ${did.retired} old candle(s) archived.`);
  if (APPLY) { await q('COMMIT'); say('Committed.'); }
  else { await q('ROLLBACK'); say('DRY RUN: nothing changed. Add --apply to write.'); }
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error('\nSTOPPED, nothing changed:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
