// Produces the list the warehouse should count, and nothing else.
//
// WHY (2026-08-18). A container is arriving and the warehouse said they will
// adjust stock while it is open. That is the moment the numbers get fixed, and
// it is worth walking in knowing exactly what matters.
//
// Fourteen MUSE components have only ever been CONSUMED — not one receipt in the
// ledger — so the system believes nothing in the range can be built, which is
// almost certainly false: there are bottles and lids in the warehouse, they were
// just never entered. The labels are different and are trusted: 500 of each was
// entered once and they have been drawing down since.
//
// `ever_received` is the column that matters. NEVER means the system has no idea
// what is there and a counted number is the first real information it will get.
//
// The regression fixtures CMP-RB200 / CMP-RLID / RM-ETHANOL are excluded: they
// belong to the test suites, not to the warehouse, and asking someone to count
// them would waste their time.
//
// Read-only. Writes a CSV to the workspace root.
//
// Run: node scripts/make-count-sheet.cjs
require('dotenv').config();
const { Pool } = require('pg');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const sm = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

(async () => {
  const rows = (await sm.query(`
    SELECT p.product_code, p.name, p.category, p.current_stock::float s, p.unit,
           string_agg(DISTINCT pb.product_type, ' + ' ORDER BY pb.product_type) AS used_by,
           count(*) FILTER (WHERE t.type IN ('add','transfer_in','incoming')) AS receipts
      FROM products p
      LEFT JOIN product_bom pb ON pb.component_product_id = p.id AND pb.is_active
      LEFT JOIN transactions t ON t.product_id = p.id
     WHERE p.category IN ('COMPONENT','RAW_MATERIAL','LABEL')
       AND COALESCE(p.archived, false) = false
       AND p.product_code NOT IN ('CMP-RB200','CMP-RLID','RM-ETHANOL')
     GROUP BY 1,2,3,4,5
     ORDER BY (count(*) FILTER (WHERE t.type IN ('add','transfer_in','incoming'))) ASC,
              p.category, p.product_code`)).rows;

  const head = ['Code', 'What it is', 'Used by', 'System says', 'Unit', 'Ever received?', 'COUNTED'];
  const csv = [head.join(',')];
  for (const r of rows) {
    csv.push([
      r.product_code,
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.used_by || '-'}"`,
      r.s,
      r.unit,
      Number(r.receipts) > 0 ? 'yes' : 'NEVER',
      '',
    ].join(','));
  }
  const out = join(__dirname, '../../MUSE_Stock_Count_Sheet.csv');
  writeFileSync(out, csv.join('\r\n') + '\r\n');

  const never = rows.filter((r) => Number(r.receipts) === 0);
  console.log(`\n  ${rows.length} items to count · ${never.length} the system has NEVER seen received\n`);
  console.log('  ' + 'Code'.padEnd(12) + 'Used by'.padEnd(22) + 'System'.padStart(9) + '   Ever received?');
  for (const r of rows) {
    console.log('  ' + String(r.product_code).padEnd(12) + String(r.used_by || '-').padEnd(22)
      + String(r.s).padStart(9) + '   ' + (Number(r.receipts) > 0 ? 'yes' : 'NEVER'));
  }
  console.log(`\n  written to MUSE_Stock_Count_Sheet.csv\n`);
  await sm.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
