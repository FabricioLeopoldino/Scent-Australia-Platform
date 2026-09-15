// Proves no refurbished machine is left without somewhere to record its BOM.
//
// WHY THIS EXISTS (2026-09-15). Six refurbished machines are registered as
// products. The BOM page knew two refurb variants, both written into its own
// source, and the ScentPro 700 Medium (SA_RF00005, SA_RF00006) matched neither.
// The page offers no way to create a variant — so there was nowhere at all to
// record what that machine ships with, and no error anywhere said so. The owner
// found it the only way it could be found: "notei que tem uma máquina que virou
// refurb e não está lá, queria adicionar mas não é possível."
//
// The hardcoded list is not really the fault. The fault is that nothing ever
// compared it against the machines that exist, so registering a seventh refurb
// tomorrow would fail the same silent way. This compares them.
//
// It deliberately checks the DIRECTION THAT BITES: every refurb machine must be
// covered. The reverse — a variant naming a machine that no longer exists — is
// checked too, because a stale entry is how the list quietly stops describing
// reality.
//
// NOT CHECKED, and worth knowing: whether the bottle on each variant is the
// RIGHT bottle. That is a fact about physical products that only the owner
// holds. What is asserted is that the bottle named exists, is active, and is
// the one the BOM actually carries — so the file and the database cannot drift.
//
// READ-ONLY. Writes nothing.
//
// Run: node scripts/regression-refurb-bom-coverage.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
import { REFURB_MACHINE_COVERAGE, refurbVariantFor } from '../shared/refurb-machines.js';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  // Refurbished machines as the catalogue defines them: a scent machine whose
  // name says Refurb. Matching on the name rather than the SA_RF prefix on
  // purpose — the prefix is a convention, the word is the meaning.
  const machines = (await pool.query(`
    SELECT "productCode" AS code, name, ("currentStock"::float) AS stock
    FROM products
    WHERE category = 'SCENT_MACHINES' AND status = 'active' AND name ILIKE '%refurb%'
    ORDER BY "productCode"`)).rows;

  console.log(`\n(${machines.length} active refurbished machines in the catalogue)`);
  for (const m of machines) {
    console.log(`   ${m.code.padEnd(12)} ${String(m.name).slice(0, 44).padEnd(45)} ${m.stock} un`);
  }

  console.log('\n1. Every refurbished machine has a BOM variant to belong to');
  // The check that would have caught the 700 Medium on the day it was created.
  const orphans = machines.filter((m) => !refurbVariantFor(m.code));
  check(orphans.length === 0,
    `all ${machines.length} are claimed by a refurb variant`,
    orphans.map((m) => `${m.code} (${String(m.name).slice(0, 30)})`).join(', '));

  console.log('\n2. And no variant claims a machine that is not there any more');
  const codes = new Set(machines.map((m) => m.code));
  for (const [variant, cfg] of Object.entries(REFURB_MACHINE_COVERAGE)) {
    const missing = cfg.machines.filter((c) => !codes.has(c));
    check(missing.length === 0, `${variant} covers only live machines`, missing.join(', '));
  }

  console.log('\n3. The bottle each variant names is a real, active product');
  for (const [variant, cfg] of Object.entries(REFURB_MACHINE_COVERAGE)) {
    const r = (await pool.query(
      `SELECT name, status FROM products WHERE "productCode" = $1`, [cfg.bottle])).rows[0];
    check(!!r && r.status === 'active',
      `${variant} → ${cfg.bottle} ${r ? `(${String(r.name).slice(0, 34)})` : ''}`,
      r ? `status=${r.status}` : 'no such product');
  }

  console.log('\n4. The file agrees with the BOM rows actually stored');
  // Two ways to drift: a variant documented here with nothing recorded against
  // it, or a recorded line that names a different bottle from the one here.
  const rows = (await pool.query(
    `SELECT variant, component_code, quantity::float q FROM bom
     WHERE variant LIKE 'REFURB%' ORDER BY variant, seq`)).rows;
  for (const [variant, cfg] of Object.entries(REFURB_MACHINE_COVERAGE)) {
    const lines = rows.filter((r) => r.variant === variant);
    if (lines.length === 0) {
      // Not a failure: a variant can legitimately exist before anybody has
      // filled it in — that is the state REFURB_SCENTPRO_700 ships in, waiting
      // for the owner to add its line through the screen. Saying so is the
      // point; being silent about it is what caused this whole finding.
      console.log(`  note  ${variant} has no BOM line yet — add ${cfg.bottle} on the BOM page`);
      continue;
    }
    check(lines.some((l) => l.component_code === cfg.bottle),
      `${variant} records ${cfg.bottle}`,
      `records ${lines.map((l) => l.component_code).join(', ')}`);
  }

  console.log('\n5. Nothing stored refers to a refurb variant nobody documented');
  const stored = [...new Set(rows.map((r) => r.variant))];
  const undocumented = stored.filter((v) => !REFURB_MACHINE_COVERAGE[v]);
  check(undocumented.length === 0,
    `all ${stored.length} stored refurb variants are described in shared/refurb-machines.js`,
    undocumented.join(', '));

  console.log('\n6. The screen can pick everything a BOM is allowed to hold');
  // The picker offered RAW_MATERIALS and nothing else — narrower than the data
  // it edits, in two directions at once. A machine's parts are MACHINES_SPARES,
  // so the owner could not add one at all ("os componentes que vão lá são
  // spare parts e só consigo adicionar raw material"); and the stored BOMs
  // already hold 113 different OILS across 354 lines, put there by import
  // because this screen could never have added them either.
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/sa/pages/BOMViewer.jsx'), 'utf8');
  const offered = (page.match(/\['RAW_MATERIALS'[^\]]*\]/) || [''])[0];
  for (const cat of ['RAW_MATERIALS', 'MACHINES_SPARES', 'OILS']) {
    check(offered.includes(`'${cat}'`), `the picker offers ${cat}`, offered || 'list not found');
  }
  // The one that keeps it honest as the data moves, rather than a list that was
  // right on the day somebody wrote it: whatever the BOMs actually contain must
  // be selectable on the screen that edits them.
  const used = (await pool.query(`
    SELECT DISTINCT pr.category c FROM bom b JOIN products pr ON pr."productCode" = b.component_code
    WHERE pr.category IS NOT NULL`)).rows.map((r) => r.c);
  const cannotPick = used.filter((c) => !offered.includes(`'${c}'`));
  check(cannotPick.length === 0,
    `every category already used in a BOM (${used.join(', ')}) can be picked`,
    cannotPick.join(', '));

  console.log(failed === 0
    ? '\n✅ refurb-bom-coverage: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
