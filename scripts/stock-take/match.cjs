// Matches a stock-take sheet to the Fragrance Library, and changes nothing.
//
// WHY (2026-08-27). The warehouse counted 168 fragrances. Before a single
// balance moves, every line has to be tied to the right product — by the
// supplier's code where there is one, by name only where there is not. Names are
// the unreliable key: "Saffron & Oakmoss" exists twice under two supplier names,
// and matching on a name is how eleven products came to sell under the wrong
// code in the first place (PRD locked decision 1).
//
// So this only reports. It answers three questions and stops:
//
//   Can the transcription be trusted?  The sheet carries what the system said at
//     the time. If that column disagrees with the database on many rows, the
//     transcription or the reading of it is wrong, and nothing should be applied.
//   Which lines can be tied to a product with confidence, and which cannot?
//   What is on the shelf that nobody counted?
//
// READ-ONLY. It writes one CSV for review and touches no stock.
//
// Run: node scripts/stock-take/match.cjs [sheet.txt]
require('dotenv').config();
const { Pool } = require('pg');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SHEET = process.argv[2] || join(__dirname, '2026-08-28-fragrances.txt');
const OUT = join(__dirname, 'match-report.csv');

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true },
  // search_path is REQUIRED, not tidiness. sa.products carries a trigger that
  // writes the second ledger, sa.direct_stock_changes, and it names that table
  // unqualified — without this every UPDATE fails with "relation does not
  // exist" and the whole stock take rolls back.
  options: '-c search_path=sa,public',
});

// Lower case, strip punctuation and collapse spaces. Deliberately mild: it must
// not turn two genuinely different fragrances into the same string.
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[()[\]]/g, ' ').replace(/[&+]/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

function parseSheet(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d{3})\.\s*(.*)$/);
    if (!m) continue;
    const parts = m[2].split('|').map((x) => x.trim());
    // Row 039 carries two supplier codes and so has an extra pipe. The four
    // fields that matter are the first three and the LAST, never "the fifth".
    if (parts.length < 4) { rows.push({ no: m[1], bad: line.trim() }); continue; }
    rows.push({
      no: m[1],
      name: parts[0],
      aliases: parts[1] === '-' ? [] : parts[1].split(',').map((a) => a.trim()).filter(Boolean),
      sheetSystem: num(parts[2]),
      counted: num(parts[3]),
      supplierCode: parts.slice(4).join(' ').trim(),
    });
  }
  return rows;
}

(async () => {
  const rows = parseSheet(readFileSync(SHEET, 'utf8'));
  const bad = rows.filter((r) => r.bad);
  const good = rows.filter((r) => !r.bad);

  const oils = (await pool.query(
    `SELECT "productCode" AS code, name, supplier_code, unit,
            "currentStock"::float AS stock, exclusivity
       FROM sa.products WHERE category = 'OILS'`)).rows;

  const byCode = new Map();
  const byName = new Map();
  for (const o of oils) {
    const sc = norm(o.supplier_code);
    if (sc) { if (!byCode.has(sc)) byCode.set(sc, []); byCode.get(sc).push(o); }
    const n = norm(o.name);
    if (!byName.has(n)) byName.set(n, []); byName.get(n).push(o);
  }

  const results = [];
  for (const r of good) {
    let hit = [], how = '';
    const sc = norm(r.supplierCode);
    if (sc && sc !== '-' && byCode.has(sc)) { hit = byCode.get(sc); how = 'supplier code'; }
    // Three supplier codes are shared by two fragrances each - FIA231877,
    // LUX0710 and LUX0637 - on the sheet AND in the library. The code is the
    // stronger key when it is unique and useless when it is not, so where it
    // points at several, the name decides between THOSE and no others.
    if (hit.length > 1) {
      const narrowed = hit.filter((h) => norm(h.name) === norm(r.name));
      if (narrowed.length === 1) { hit = narrowed; how = 'supplier code + name'; }
    }
    if (!hit.length && byName.has(norm(r.name))) { hit = byName.get(norm(r.name)); how = 'name'; }
    if (!hit.length) {
      for (const a of r.aliases) {
        if (byName.has(norm(a))) { hit = byName.get(norm(a)); how = `alias "${a}"`; break; }
      }
    }
    results.push({ ...r, hit, how });
  }

  const one = results.filter((r) => r.hit.length === 1);
  const many = results.filter((r) => r.hit.length > 1);
  const none = results.filter((r) => r.hit.length === 0);

  console.log(`\nSHEET: ${rows.length} line(s) read, ${bad.length} unreadable`);
  console.log(`LIBRARY: ${oils.length} oils in the system\n`);
  console.log(`  matched to exactly one product   ${one.length}`);
  console.log(`  matched to MORE than one         ${many.length}`);
  console.log(`  matched to nothing               ${none.length}`);

  // ── Can the transcription be trusted? ──────────────────────────────────────
  // The sheet records what the system said. If that agrees with the database
  // the transcription is sound and the counted column can be read the same way.
  const agree = one.filter((r) => r.sheetSystem === r.hit[0].stock);
  const differ = one.filter((r) => r.sheetSystem !== r.hit[0].stock);
  console.log(`\nTRANSCRIPTION CHECK — the sheet's "current stock" against the database:`);
  console.log(`  identical   ${agree.length} of ${one.length}`);
  console.log(`  different   ${differ.length}`);
  if (differ.length) {
    console.log('\n  the ones that differ (sheet vs database):');
    differ.slice(0, 20).forEach((r) => console.log(
      `    ${r.no}  ${r.name.padEnd(38).slice(0, 38)}  sheet ${String(r.sheetSystem).padStart(9)}   db ${String(r.hit[0].stock).padStart(9)}   ${r.hit[0].code}`));
    if (differ.length > 20) console.log(`    ... and ${differ.length - 20} more, all in the CSV`);
  }

  if (many.length) {
    console.log('\nMATCHED MORE THAN ONE — must be resolved by hand:');
    many.forEach((r) => console.log(
      `  ${r.no}  ${r.name}  → ${r.hit.map((h) => `${h.code} (${h.name})`).join('  |  ')}`));
  }
  if (none.length) {
    console.log('\nMATCHED NOTHING — on the sheet, not found in the library:');
    none.forEach((r) => console.log(
      `  ${r.no}  ${r.name.padEnd(40).slice(0, 40)}  supplier code: ${r.supplierCode || '(none)'}`));
  }
  if (bad.length) {
    console.log('\nCOULD NOT BE READ:');
    bad.forEach((r) => console.log(`  ${r.bad}`));
  }

  const counted = new Set(one.map((r) => r.hit[0].code));
  const missed = oils.filter((o) => !counted.has(o.code) && o.stock !== 0)
    .sort((a, b) => b.stock - a.stock);
  console.log(`\nIN THE LIBRARY BUT NOT ON THE SHEET, holding stock: ${missed.length}`);
  missed.slice(0, 15).forEach((o) => console.log(
    `  ${o.code.padEnd(12)} ${String(o.name).padEnd(42).slice(0, 42)} ${String(o.stock).padStart(10)} ${o.unit}`));
  if (missed.length > 15) console.log(`  ... and ${missed.length - 15} more, all in the CSV`);

  const csv = [['line', 'sheet_name', 'match', 'product_code', 'db_name', 'db_unit',
    'sheet_says_system_has', 'db_actually_has', 'counted_as_written', 'supplier_code'].join(',')];
  const q = (v) => `"${String(v ?? '').split('"').join('""')}"`;
  for (const r of results) {
    csv.push([r.no, q(r.name), r.hit.length === 1 ? q(r.how) : q(r.hit.length ? 'AMBIGUOUS' : 'NOT FOUND'),
      q(r.hit.length === 1 ? r.hit[0].code : ''), q(r.hit.length === 1 ? r.hit[0].name : ''),
      q(r.hit.length === 1 ? r.hit[0].unit : ''), r.sheetSystem, r.hit.length === 1 ? r.hit[0].stock : '',
      r.counted, q(r.supplierCode)].join(','));
  }
  for (const o of missed) {
    csv.push(['', q(''), q('NOT COUNTED'), q(o.code), q(o.name), q(o.unit), '', o.stock, '', q(o.supplier_code)].join(','));
  }
  writeFileSync(OUT, csv.join('\n'), 'utf8');
  console.log(`\nFull detail written to ${OUT}\n`);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
