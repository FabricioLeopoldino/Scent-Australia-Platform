// Applies the diffuser stocktake Payal emailed on 28 August, the same day and
// method as the fragrance count.
//
// WHY (2026-09-03). Payal counted the diffuser range on 28/08, updated
// Shopify's inventory from it, and emailed the result. It was never applied to
// the platform — the owner's words: "acho que recebi essa lista na sexta mas
// devo ter esquecido de atualizar devido a minha agenda apertada". A partial,
// undocumented correction WAS made by hand on 31/08 (a +7 / -5 on the two Pro
// Wifi colours, landing exactly on Friday's counted figures) — but it wrote
// the count straight in on Monday, silently erasing the real sales that had
// already happened between Friday and then. That is the same mistake the
// first fragrance stock-take attempt made; this uses the same fix.
//
// SEVEN products, mapped by hand from the email (no fuzzy text matching needed
// — there are only seven and the owner named each one directly):
//
//   ScentLite White / "Black" (the owner confirmed this is a colour-naming
//     slip on the stocktake sheet — the only ScentLite variants in the
//     platform are White and Grey, and there is no separate live Black SKU)
//   HVAC — the email gives one combined total. The platform holds two HVAC
//     models; the owner confirmed the count is for the one that already
//     carried stock (SCENT_MACHINES_00004, WITH the air-pressure switch). The
//     other (SCENT_MACHINES_00003, no switch, already at 0) is untouched.
//   Tower White/Black, Pro Wifi White/Black
//
// SAME METHOD as the fragrance count: proposed = counted + whatever the ledger
// recorded moving between the Friday cutoff and now. Counted-straight-in would
// erase the real sales in between, including the 31/08 correction itself,
// which this treats as just another ledger movement to carry forward, not as
// a trusted fact — the whole point of computing from the cutoff balance rather
// than trusting an intermediate entry.
//
// SA IS A PRODUCTION SYSTEM. Dry run by default. One transaction, every figure
// re-read and asserted before COMMIT.
//
// Run:  node scripts/stock-take/apply-diffusers.cjs           (dry run)
//       node scripts/stock-take/apply-diffusers.cjs --apply   (writes)
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const COUNT_DATE = '28/08/2026';
const COUNT_CUTOFF_SYDNEY = '2026-08-28 00:00:00';
const NOTE = `Stock take ${COUNT_DATE} (diffusers, ex. Payal)`;

// counted = the physical count from Payal's email, in units.
const COUNTED = {
  SCENT_MACHINES_00008: { name: 'ScentLite - Bathroom Diffuser (White)', counted: 52 },
  SCENT_MACHINES_00007: { name: 'ScentLite - Bathroom Diffuser (Grey — labelled "Black" on the sheet)', counted: 456 },
  SCENT_MACHINES_00004: { name: 'ScentLux - HVAC Diffuser + Air-pressure Switch', counted: 42 },
  SCENT_MACHINES_00011: { name: 'ScentTower - Standalone Diffuser (White)', counted: 0 },
  SCENT_MACHINES_00010: { name: 'ScentTower - Standalone Diffuser (Black)', counted: 34 },
  SCENT_MACHINES_00002: { name: 'ScentPro - Wifi Medium Diffuser (White)', counted: 0 },
  SCENT_MACHINES_00001: { name: 'ScentPro - Wifi Medium Diffuser (Black)', counted: 240 },
};

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true },
  options: '-c search_path=sa,public',
});

const log = (s = '') => console.log(s);

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const codes = Object.keys(COUNTED);
    const products = (await client.query(
      `SELECT id, "productCode" AS code, name, "currentStock"::float AS stock, unit
         FROM sa.products WHERE "productCode" = ANY($1::text[]) FOR UPDATE`, [codes])).rows;

    const missing = codes.filter((c) => !products.some((p) => p.code === c));
    if (missing.length) throw new Error(`product code(s) not found: ${missing.join(', ')} — refusing`);

    const atCutoff = new Map((await client.query(
      `SELECT DISTINCT ON (product_code) product_code, balance_after::float AS bal
         FROM sa.transactions
        WHERE product_code = ANY($1::text[]) AND balance_after IS NOT NULL
          AND created_at <= ($2::timestamp AT TIME ZONE 'Australia/Sydney' AT TIME ZONE 'UTC')
        ORDER BY product_code, id DESC`, [codes, COUNT_CUTOFF_SYDNEY]))
      .rows.map((r) => [r.product_code, r.bal]));

    const movedOnCountDay = new Set((await client.query(
      `SELECT DISTINCT product_code FROM sa.transactions
        WHERE product_code = ANY($1::text[])
          AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date = $2::date`,
      [codes, COUNT_CUTOFF_SYDNEY])).rows.map((r) => r.product_code));

    const plan = products.map((p) => {
      const meta = COUNTED[p.code];
      // If nothing moved before the cutoff at all, the current balance is the
      // only figure available to carry forward from — same fallback the
      // fragrance script uses, and equally rare (this dataset has none).
      const balAtCutoff = atCutoff.has(p.code) ? atCutoff.get(p.code) : p.stock;
      const movedSince = p.stock - balAtCutoff;
      const proposed = meta.counted + movedSince;
      return { p, meta, balAtCutoff, movedSince, proposed, delta: proposed - p.stock,
        onCountDay: movedOnCountDay.has(p.code) };
    });

    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — diffuser stocktake of ${COUNT_DATE}\n`);
    log(`  products               ${plan.length}`);
    log(`  cutoff                 ${COUNT_CUTOFF_SYDNEY} Sydney`);

    const changed = plan.filter((x) => x.delta !== 0);
    log(`  already correct        ${plan.length - changed.length}`);
    log(`  needs an adjustment    ${changed.length}\n`);

    for (const x of plan) {
      const mark = x.delta === 0 ? 'ok  ' : (x.delta > 0 ? '+++ ' : '--- ');
      log(`  ${mark}${x.p.code.padEnd(22)} ${x.meta.name.padEnd(58)} `
        + `${String(x.p.stock).padStart(5)} -> ${String(x.proposed).padStart(5)}`
        + `  (counted ${x.meta.counted}, ${x.movedSince >= 0 ? '+' : ''}${x.movedSince} since)`
        + (x.onCountDay ? '  [moved on count day itself]' : ''));
    }

    const negatives = changed.filter((x) => x.proposed < 0);
    if (negatives.length) {
      log(`\n  ${negatives.length} would land BELOW ZERO — more sold after the count than was counted:`);
      negatives.forEach((x) => log(`    ${x.p.code}  ${x.meta.name}  -> ${x.proposed}`));
      log('    Written as they fall. No figure is invented to tidy them up.');
    }

    let written = 0;
    for (const x of changed) {
      await client.query(`UPDATE sa.products SET "currentStock" = $1, updated_at = NOW() WHERE id = $2`,
        [x.proposed, x.p.id]);
      await client.query(
        `INSERT INTO sa.transactions
           (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id, reason)
         VALUES ($1,$2,$3,'SCENT_MACHINES','adjust',$4,$5,$6,$7,NULL,'correction')`,
        [x.p.id, x.p.code, x.p.name, Math.abs(x.delta), x.p.unit, x.proposed,
         `${NOTE} — counted ${x.meta.counted}; ledger held ${x.balAtCutoff} at the cutoff`
         + (x.movedSince ? `, ${x.movedSince > 0 ? '+' : ''}${x.movedSince} moved since` : '')
         + (x.onCountDay ? ', moved on the count day itself so the cutoff is approximate' : '')
         + `; ${x.p.stock} → ${x.proposed} ${x.p.unit}`]);
      written++;
    }

    // Prove it before deciding whether to keep it.
    const after = new Map((await client.query(
      `SELECT id, "currentStock"::float AS stock FROM sa.products WHERE "productCode" = ANY($1::text[])`,
      [codes])).rows.map((r) => [r.id, r.stock]));
    const wrong = changed.filter((x) => after.get(x.p.id) !== x.proposed);
    if (wrong.length) throw new Error(`${wrong.length} product(s) did not land on the proposed figure`);
    const untouched = plan.filter((x) => x.delta === 0);
    const drifted = untouched.filter((x) => after.get(x.p.id) !== x.p.stock);
    if (drifted.length) throw new Error(`${drifted.length} product(s) that needed no change were changed anyway`);

    log(`\n  ledger rows written    ${written}`);
    log(`  verified               every figure matches the plan; untouched products stayed untouched`);

    if (APPLY) { await client.query('COMMIT'); log('\n✅ committed\n'); }
    else { await client.query('ROLLBACK'); log('\n↩  rolled back — re-run with --apply to keep it\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\n❌ rolled back: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
