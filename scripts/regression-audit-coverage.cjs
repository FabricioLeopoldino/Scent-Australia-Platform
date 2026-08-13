// Proves the accountability page can actually answer "who changed this, when".
//
// WHY THIS EXISTS (2026-08-13, Block G). Two holes were found by checking the
// audit against events we knew had happened:
//
//   1. The Activity page queried saPool and smPool and never platformPool, so
//      515 rows were invisible — every sign-in, every module-access grant, every
//      password change, every SA↔SM fragrance transfer — on the one page whose
//      stated purpose is "who used what, when".
//
//   2. PUT /products/:id wrote no audit row at all. Name, SKU, price, segment
//      could all change leaving nothing behind. Not one `product_updated` row
//      existed in 2,761 SM audit entries. That is the hole the eleven wrong MUSE
//      SKUs of 2026-08-10 fell through: no author, no timestamp.
//
// Both are omissions, not logic errors, and an omission comes back the moment
// someone adds a fourth schema or a new write route. Hence source assertions.
//
// Read-only. No server, no writes.
//
// Run: node scripts/regression-audit-coverage.cjs
require('dotenv').config();
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');

const ROOT = join(__dirname, '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('\n1. The Activity page reaches every schema that keeps an audit');
  const reports = src('server/platform/reports.js');
  for (const pool of ['saPool', 'smPool', 'platformPool']) {
    check(new RegExp(`${pool}\\.query\\(\\s*auditFilters`).test(reports),
      `fetchActivity queries ${pool}`);
  }
  check(/import \{[^}]*platformPool[^}]*\} from '\.\.\/db\.js'/.test(reports),
    'platformPool is imported, not just referenced');

  console.log('\n2. platform.audit_log has no entity_name — the projection supplies one');
  // Asserting the workaround exists, because dropping it makes the search filter
  // throw 42703 at runtime rather than fail loudly here.
  check(/PF_NAME\s*=/.test(reports) && /\$\{PF_NAME\}\s+AS entity_name/.test(reports),
    'a derived entity_name is selected for platform rows');
  check(/auditFilters\([^)]*,\s*PF_NAME\)/.test(reports),
    'and the search filter is pointed at it, not at the missing column');

  console.log('\n3. Editing a product leaves a trail');
  const products = src('server/sm/routes/products.js');
  const put = products.slice(products.indexOf("router.put('/products/:id'"));
  const putBody = put.slice(0, put.indexOf('router.', 10));
  check(/auditLog\(\s*req\.user\.id,\s*'product_updated'/.test(putBody),
    'PUT /products/:id writes a product_updated row');
  check(/SELECT \* FROM products WHERE id = \$1/.test(putBody),
    'it reads the row first, so the audit can say what the value WAS');
  check(/AUDITED_FIELDS/.test(products) && /product_code/.test(products.slice(products.indexOf('AUDITED_FIELDS'), products.indexOf('AUDITED_FIELDS') + 400)),
    'product_code is among the audited fields (the eleven-wrong-SKUs case)');
  check(!/AUDITED_FIELDS = \[[^\]]*'image_data'/.test(products),
    'image_data is NOT audited — a base64 blob would bury the real change');

  console.log('\n4. The changed-field diff is not fooled by numeric formatting');
  // 49 from the request vs '49.00' from a numeric column must not read as a
  // change, or every save would log a phantom price edit.
  check(/String\(before\[f\]\)/.test(products) && /String\(after\[f\]\)/.test(products),
    'both sides are stringified before comparison');

  console.log('\n5. Against the live database');
  const pool = new Pool({
    connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false },
  });
  try {
    for (const s of ['platform', 'sa', 'sm']) {
      const n = (await pool.query(`SELECT count(*) c FROM ${s}.audit_log`)).rows[0].c;
      check(Number(n) > 0, `${s}.audit_log has rows (${n})`);
    }
    // The derived label must never come back empty, or the page shows a blank row.
    const blank = (await pool.query(
      `SELECT count(*) c FROM platform.audit_log al
        WHERE COALESCE(al.details->>'name', al.details->>'fragrance', al.details->>'sm',
                       al.entity_type || ' #' || al.entity_id) IS NULL`)).rows[0].c;
    check(Number(blank) === 0, 'every platform row resolves to a readable name', `${blank} blank`);
  } finally {
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ audit-coverage: all checks passed' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
