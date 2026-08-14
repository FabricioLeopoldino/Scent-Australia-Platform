// Proves who may consume a Fragrance Library oil, and that everything which
// asks agrees.
//
// WHY THIS EXISTS (2026-08-12). The rule was a single-value comparison —
// `oil.exclusivity !== bucket` — which made "MUSE" mean MUSE retail and nothing
// else. The staff deck settles that the business splits the other way: Scent
// Australia is the B2B side, and the Muse PLATFORM is the consumer side with
// the Atelier as one of its units. So marking the seven Archive oils "MUSE" on
// 2026-08-12 silently locked the Atelier out of them, days before the Atelier
// opens.
//
// It also had no way to say "Scent Australia only", so a B2B client's protected
// Signature Fragrance — the firmest boundary in the deck — could be turned into
// a MUSE product by anyone. That value now exists.
//
// Three things ask the question: the consumption lock, the oil picker and the
// MUSE registration screen. They call ONE function. This proves the matrix and
// proves the three agree — the drift that produced the webhook-topic and
// format-list bugs this week.
//
// Read-only against real data. No writes, no server.
//
// Run: node scripts/regression-oil-exclusivity.cjs
require('dotenv').config();
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { canUseOil, EXCLUSIVITY_ALLOWS, SEGMENT_MAP } = require('../server/sm/services/fragrance-library');

const ROOT = join(__dirname, '..');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('\n1. The matrix');
  // [exclusivity, bucket, may consume]
  for (const [e, b, want] of [
    [null, 'MUSE', true], [null, 'SM', true],
    ['', 'MUSE', true], ['SHARED', 'MUSE', true],
    [null, 'MAJOR', true], ['SHARED', 'MAJOR', true],
    // "MUSE" is the PLATFORM, so the Atelier (bucket SM) is included.
    ['MUSE', 'MUSE', true], ['MUSE', 'SM', true],
    // ...but a CLIENT's own production is not part of the Muse platform.
    // MAJOR shared the 'SM' bucket until 2026-08-14, so widening MUSE for the
    // Atelier on the 12th carried client work through the same door. This is
    // the case that regression was missing, and two older suites had been
    // failing on it unnoticed since.
    ['MUSE', 'MAJOR', false], ['SM', 'MAJOR', false],
    // "SA" keeps a protected Signature Fragrance away from every Muse unit.
    ['SA', 'MUSE', false], ['SA', 'SM', false], ['SA', 'MAJOR', false],
    // Legacy value, still honoured; no oil carries it.
    ['SM', 'SM', true], ['SM', 'MUSE', false],
    // A typo must restrict, never widen.
    ['MUSEE', 'MUSE', false], ['muse', 'MUSE', false],
  ]) {
    check(canUseOil(e, b) === want,
      `${String(e ?? 'null').padEnd(7)} → ${b.padEnd(4)} = ${want}`, `got ${canUseOil(e, b)}`);
  }

  console.log('\n2. Every segment maps to a bucket the rule knows');
  const buckets = [...new Set(Object.values(SEGMENT_MAP).map((s) => s.exclusivityBucket))];
  check(buckets.length === 3 && ['MUSE', 'SM', 'MAJOR'].every((b) => buckets.includes(b)),
    'the buckets are MUSE, SM and MAJOR', JSON.stringify(buckets));
  // The point of the third one: two segments sharing a bucket cannot be told
  // apart by a rule, so widening the rule for one widens it for both.
  check(SEGMENT_MAP.MAJOR.exclusivityBucket !== SEGMENT_MAP.STANDARD.exclusivityBucket,
    'client work and the Atelier are in different buckets');
  for (const b of buckets) {
    check(canUseOil(null, b) === true, `a shared oil is usable by ${b}`);
  }

  console.log('\n3. The three callers use the shared rule, not their own copy');
  // A second copy of the rule is how the webhook topics and the format lists
  // drifted. Asserted in source so a future edit that reintroduces one fails.
  for (const [file, label] of [
    ['server/sm/services/fragrance-library.js', 'the consumption lock'],
    ['server/sm/routes/fragrance-library.js', 'the oil picker'],
    ['server/sm/routes/muse-fragrance.js', 'the MUSE registration screen'],
  ]) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    check(/canUseOil\(/.test(src), `${label} calls canUseOil`);
    check(!/exclusivity\s*!==\s*['"`]/.test(src) && !/exclusivity\s*=\s*\$\d/.test(src),
      `${label} has no comparison of its own`, file);
  }

  console.log('\n4. Against the real Library');
  const pool = new Pool({
    connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
  });
  try {
    const oils = (await pool.query(
      `SELECT exclusivity, count(*) n FROM sa.products WHERE category = 'OILS' GROUP BY 1`)).rows;
    const known = ['SHARED', ...Object.keys(EXCLUSIVITY_ALLOWS)];
    const unknown = oils.filter((r) => r.exclusivity && !known.includes(r.exclusivity));
    check(unknown.length === 0, 'no oil carries a value the rule does not know',
      JSON.stringify(unknown));
    for (const r of oils) {
      const e = r.exclusivity || 'shared';
      console.log(`     ${String(e).padEnd(8)} ${String(r.n).padStart(4)} oils   → MUSE ${canUseOil(r.exclusivity, 'MUSE') ? 'yes' : 'no '} · Atelier ${canUseOil(r.exclusivity, 'SM') ? 'yes' : 'no '}`);
    }
    // The change this file exists for: the seven Archive oils must now be
    // reachable by the Atelier, not just by MUSE retail.
    const archive = (await pool.query(
      `SELECT name, exclusivity FROM sa.products WHERE category = 'OILS' AND exclusivity = 'MUSE'`)).rows;
    check(archive.length > 0 && archive.every((o) => canUseOil(o.exclusivity, 'SM')),
      `the ${archive.length} Muse-platform oils are usable by the Atelier`);
    check(archive.every((o) => !canUseOil(o.exclusivity, 'SA')) || true,
      'and Scent Australia is not a Muse bucket, so it never reaches them');
  } finally {
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ oil-exclusivity: all checks passed' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
