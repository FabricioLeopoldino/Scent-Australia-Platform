// Register The Archive in the platform: its three formats and its thirty
// products (PRD_MUSE_ARCHIVE.md, owner decisions of 13 Nov 2026).
//
// WHY. The MUSE store already sells The Archive — ten fragrances, each as a
// Reed Diffuser, a Candle and a Room Spray — and the platform knew none of the
// thirty codes, so a sale would arrive as "SKU not found".
//
// What it applies:
//   · The store's codes are kept as they are (MUSE-ARC-<xx>-RD | -CA | -RS).
//   · The Archive's bottle, box and label are all its own, so it gets its own
//     three masters. Their recipes start WITHOUT packaging: the Reed Diffuser
//     and the Room Spray carry only the ethanol line, copied from The Library's
//     master; the candle carries nothing (it is filled outside, D17). The owner
//     adds the packaging on the BOM page once those components are registered.
//   · Each product is born in the unit "archive", under its commercial name,
//     on the oil the owner mapped (MASTER_PLAN §10.6). A candle names the
//     ORDINARY oil; where a candle version exists (Santal, FRAG_0337) the
//     platform pours that one by itself.
//   · Every oil is registered for MUSE as used by The Archive.
//
// ASSUMED, to be confirmed by the owner: the Archive's Reed Diffuser and Room
// Spray take 25% oil, like The Library's. The candle's 12% and 300 g are his.
//
// It creates only what is missing and never changes a row that exists, so it
// can be run again. One transaction: all of it or none of it.
//
//   node scripts/archive-register.mjs                         # dry run on the test copy
//   node scripts/archive-register.mjs --apply                 # writes, test copy
//   node scripts/archive-register.mjs --production            # dry run on live
//   node scripts/archive-register.mjs --production --apply    # writes on live
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

const PRICE = 58;
const MASTERS = [
  { code: 'ARC_RD200', name: 'Archive Reed Diffuser 200ml', suffix: 'RD', volume: 200, unit: 'ml', oilPct: 25, candle: false, ethanolFrom: 'RD200' },
  { code: 'ARC_RS100', name: 'Archive Room Spray 100ml', suffix: 'RS', volume: 100, unit: 'ml', oilPct: 25, candle: false, ethanolFrom: 'RS100' },
  { code: 'ARC_CA300', name: 'Archive Candle 300g', suffix: 'CA', volume: 300, unit: 'g', oilPct: 12, candle: true, ethanolFrom: null },
];
// Commercial name → the store's two letters → the oil (its Fragrance Library code).
const FRAGRANCES = [
  { xx: 'AG', title: 'Afterglow', oil: 'FRAG_0137' },
  { xx: 'MA', title: 'Morning Air', oil: 'FRAG_0047' },
  { xx: 'GP', title: 'Garden Path', oil: 'FRAG_0083' },
  { xx: 'FB', title: 'From the Bookcase', oil: 'FRAG_0118' },
  { xx: 'KS', title: 'The Keepsake', oil: 'FRAG_0331' },
  { xx: 'SD', title: 'Slow Dancing', oil: 'FRAG_0332' },
  { xx: 'TT', title: 'Through the Trees', oil: 'FRAG_0333' },
  { xx: 'SF', title: 'Sitting Fireside', oil: 'FRAG_0334' },
  { xx: 'SR', title: 'Saved Room', oil: 'FRAG_0335' },
  { xx: 'PS', title: 'Poolside', oil: 'FRAG_0336' },
];
// A candle-grade oil poured instead of its ordinary oil: registered for MUSE too.
const CANDLE_OILS = [{ oil: 'FRAG_0337', title: 'Afterglow (candle)' }];
const NOTE = 'script archive-register.mjs (PRD_MUSE_ARCHIVE.md)';

const client = new pkg.Client({ connectionString: url.replace(/[?&]channel_binding=require/, ''), ssl: { rejectUnauthorized: true } });
await client.connect();
const q = (sql, p) => client.query(sql, p);
const did = { masters: 0, recipes: 0, products: 0, registrations: 0, widened: 0 };
const say = (s) => console.log(s);

try {
  await q('BEGIN');
  say(`${LIVE ? 'LIVE' : 'TEST COPY'} — ${APPLY ? 'APPLYING' : 'dry run, nothing is written'}\n`);

  // ── The oils, read first: a wrong code stops everything before any write.
  const oils = new Map();
  for (const code of [...new Set([...FRAGRANCES, ...CANDLE_OILS].map((f) => f.oil))]) {
    const r = (await q(`SELECT id, "productCode" AS code, name, status, exclusivity FROM sa.products WHERE "productCode" = $1 AND category = 'OILS'`, [code])).rows;
    if (r.length !== 1) throw new Error(`expected exactly one oil with code ${code}, found ${r.length}`);
    if ((r[0].status || 'active') !== 'active') throw new Error(`oil ${code} "${r[0].name}" is not active`);
    if (r[0].exclusivity && !['MUSE', 'SM', 'SHARED'].includes(r[0].exclusivity)) throw new Error(`oil ${code} is restricted to ${r[0].exclusivity} and cannot be sold as MUSE`);
    oils.set(code, r[0]);
  }

  // ── The three formats.
  say('FORMATS');
  const masterId = new Map();
  for (const m of MASTERS) {
    let row = (await q(`SELECT id, name, is_candle, volume_ml, default_oil_pct, business_unit FROM sm.products WHERE product_code = $1`, [m.code])).rows[0];
    if (row) {
      say(`  = ${m.code}  already there ("${row.name}")`);
    } else {
      row = (await q(
        `INSERT INTO sm.products (name, product_code, category, segment, is_master, volume_ml, volume_unit, default_oil_pct,
                                  is_pure_oil, is_candle, unit, current_stock, price, business_unit, notes)
         VALUES ($1,$2,'FINISHED_GOOD','MUSE',true,$3,$4,$5,false,$6,'units',0,$7,'archive',$8) RETURNING id`,
        [m.name, m.code, m.volume, m.unit, m.oilPct, m.candle, PRICE, NOTE])).rows[0];
      await q(`INSERT INTO sm.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'master_created','product',$1,$2,$3)`,
        [row.id, m.name, JSON.stringify({ product_code: m.code, segment: 'MUSE', business_unit: 'archive', is_candle: m.candle, note: NOTE })]);
      did.masters++;
      say(`  + ${m.code}  "${m.name}"  ${m.volume} ${m.unit}, ${m.oilPct}% oil${m.candle ? ', candle (filled outside)' : ''}, $${PRICE}`);
    }
    masterId.set(m.code, row.id);

    // The ethanol line only — no bottle, box or label until the Archive's own are registered.
    if (m.ethanolFrom) {
      const has = (await q(`SELECT 1 FROM sm.product_bom WHERE product_type = $1 AND is_active`, [m.code])).rows.length;
      const eth = (await q(
        `SELECT b.component_product_id, b.quantity_formula, b.quantity_per_unit, p.product_code, p.name
           FROM sm.product_bom b JOIN sm.products p ON p.id = b.component_product_id
          WHERE b.product_type = $1 AND b.is_active AND b.quantity_formula = 'ethanol_pct' ORDER BY b.sort_order LIMIT 1`, [m.ethanolFrom])).rows[0];
      if (has) say(`      recipe already has lines — left as it is`);
      else if (!eth) say(`      ! ${m.ethanolFrom} has no ethanol line to copy — the recipe stays empty`);
      else {
        await q(`INSERT INTO sm.product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
                 VALUES ($1,$2,'ethanol_pct',$3,0,'core',true)`, [m.code, eth.component_product_id, eth.quantity_per_unit]);
        did.recipes++;
        say(`      recipe: ethanol only (${eth.product_code} "${eth.name}"), as on ${m.ethanolFrom}. No packaging yet.`);
      }
    } else say(`      recipe: empty. No jar, box or label is registered for a 300 g candle yet.`);
  }

  // ── The thirty products.
  say('\nPRODUCTS');
  for (const f of FRAGRANCES) {
    const oil = oils.get(f.oil);
    const line = [];
    for (const m of MASTERS) {
      const sku = `MUSE-ARC-${f.xx}-${m.suffix}`;
      const code = `${m.code}-${f.xx}`;
      const there = (await q(`SELECT id, sku, product_code, oil_id, business_unit, master_product_id FROM sm.products WHERE sku = $1 OR product_code = $2`, [sku, code])).rows;
      if (there.length) {
        const t = there[0];
        if (there.length > 1 || t.sku !== sku || t.product_code !== code || t.oil_id !== oil.id || t.business_unit !== 'archive' || t.master_product_id !== masterId.get(m.code)) {
          throw new Error(`${sku} / ${code} exists but not as this script would create it (oil ${t.oil_id}, unit ${t.business_unit}) — stopping, nothing changed`);
        }
        line.push(`= ${sku}`);
        continue;
      }
      const row = (await q(
        `INSERT INTO sm.products (name, product_code, sku, barcode, category, unit, current_stock, segment,
                                  master_product_id, oil_id, fragrance_id, volume_ml, default_oil_pct, price, business_unit)
         VALUES ($1,$2,$3,$3,'FINISHED_GOOD','units',0,'MUSE',$4,$5,NULL,$6,$7,$8,'archive') RETURNING id`,
        [`${m.name} — ${f.title}`, code, sku, masterId.get(m.code), oil.id, m.volume, m.oilPct, PRICE])).rows[0];
      await q(`INSERT INTO sm.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'muse_fragrance_registered','product',$1,$2,$3)`,
        [row.id, sku, JSON.stringify({ oil_id: oil.id, oil: oil.code, title: f.title, master: m.code, business_unit: 'archive', note: NOTE })]);
      did.products++;
      line.push(`+ ${sku}`);
    }
    say(`  ${f.title.padEnd(18)} ${oil.code} ${oil.name.trim().slice(0, 34).padEnd(34)}  ${line.join('  ')}`);
  }

  // ── Every oil registered for MUSE, used by The Archive.
  say('\nOILS REGISTERED FOR MUSE');
  for (const f of [...FRAGRANCES, ...CANDLE_OILS]) {
    const oil = oils.get(f.oil);
    const reg = (await q(`SELECT id, commercial_name, used_by, active FROM sa.fragrance_registrations WHERE product_id = $1 AND company = 'MUSE' FOR UPDATE`, [oil.id])).rows[0];
    if (!reg) {
      await q(`INSERT INTO sa.fragrance_registrations (product_id, company, commercial_name, used_by, active) VALUES ($1,'MUSE',$2,ARRAY['MUSE_ARCHIVE'],true)`, [oil.id, f.title]);
      await q(`INSERT INTO sa.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'fragrance_registered','product',$1,$2,$3)`,
        [oil.id, oil.name, JSON.stringify({ company: 'MUSE', commercial_name: f.title, used_by: ['MUSE_ARCHIVE'], active: true, note: NOTE })]);
      did.registrations++;
      say(`  + ${oil.code}  registered for MUSE as "${f.title}", used by The Archive`);
    } else if (!reg.used_by.includes('MUSE_ARCHIVE')) {
      // Already MUSE's (a Library fragrance too): The Archive is added, the name it has is kept.
      await q(`UPDATE sa.fragrance_registrations SET used_by = array_append(used_by, 'MUSE_ARCHIVE'), updated_at = NOW() WHERE id = $1`, [reg.id]);
      await q(`INSERT INTO sa.audit_log (user_id, action, entity_type, entity_id, entity_name, details) VALUES (NULL,'fragrance_registration_updated','product',$1,$2,$3)`,
        [oil.id, oil.name, JSON.stringify({ company: 'MUSE', changes: { used_by: { from: reg.used_by, to: [...reg.used_by, 'MUSE_ARCHIVE'] } }, note: NOTE })]);
      did.widened++;
      say(`  ~ ${oil.code}  already MUSE's (${reg.used_by.join(', ') || 'no unit'}) → The Archive added; its name there is kept`);
    } else say(`  = ${oil.code}  already used by The Archive`);
  }

  say(`\n${did.masters} format(s), ${did.recipes} recipe line(s), ${did.products} product(s), ${did.registrations} new MUSE registration(s), ${did.widened} widened.`);
  if (APPLY) { await q('COMMIT'); say('Committed.'); }
  else { await q('ROLLBACK'); say('DRY RUN: nothing changed. Add --apply to write.'); }
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error('\nSTOPPED, nothing changed:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
