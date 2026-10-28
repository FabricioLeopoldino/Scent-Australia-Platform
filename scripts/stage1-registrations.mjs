// Day-one fragrance registrations — PRD_STAGE_1_FRAGRANCE_LIBRARY.md §5.
//
// Every oil registered in SA, and every oil an sm product points at
// (sm.products.oil_id) registered in MUSE, used by the units of those
// products. All active: a registration is membership of the company, the
// oil's own active/inactive stays on the oil. It is the SAME function the server's startup
// migration runs on an empty table (server/sa/sectors.js seedRegistrations),
// so this dry run is how what a release writes is reviewed before it does.
//
//   PLATFORM_DATABASE_URL=<sectors-dev> node scripts/stage1-registrations.mjs            # dry run
//   PLATFORM_DATABASE_URL=<sectors-dev> node scripts/stage1-registrations.mjs --apply    # writes
//
// Refuses any database but the Neon branch sectors-dev unless --production is
// passed too: production is registered at release, by the owner's go-ahead.
// --apply adds only what is missing (ON CONFLICT DO NOTHING); it never edits
// or removes a registration somebody made.
import 'dotenv/config';

const url = process.env.PLATFORM_DATABASE_URL || '';
const apply = process.argv.includes('--apply');
if (!url.includes('ep-old-water-') && !process.argv.includes('--production')) {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-). Pass --production as well to run it elsewhere.');
  process.exit(1);
}

// Imported only after the check: importing the server code opens its pools on
// whatever PLATFORM_DATABASE_URL says.
const { seedRegistrations } = await import('../server/sa/sectors.js');
const { saPool } = await import('../server/db.js');

try {
  const { plan, inserted } = await seedRegistrations({ apply });
  console.log(`Day-one registrations on ${new URL(url).host} — ${apply ? 'APPLY' : 'dry run'}\n`);
  for (const p of plan) {
    console.log(`  ${p.company.padEnd(4)} ${(p.usedBy.join(' + ') || '—').padEnd(40)} ${String(p.oils).padStart(4)} oils   ${String(p.already).padStart(4)} already registered   ${String(p.oils - p.already).padStart(4)} to write`);
  }
  console.log(apply ? `\nWritten: ${inserted}` : '\nNothing written. Run with --apply to write.');
} finally {
  await saPool.end();
}
process.exit(0);
