// Proves the SM reset script cannot be fired at production.
//
// WHY THIS EXISTS (2026-08-11). reset-sm-data.cjs TRUNCATEs every table in the
// sm schema plus the platform link tables. Its only barrier was `--confirm`,
// and it took its target from PLATFORM_DATABASE_URL in .env — so one command
// destroyed the live MUSE catalogue, every order and transaction, the audit
// history and the SA↔SM oil links. Counted on the live database the day this
// was found: 3,937 rows across 31 tables. sm.users survives, so the app still
// lets you in; it is simply empty.
//
// The script was not wrong when it was written — D3 said SM was resettable, and
// it was, until MUSE went retail on 2026-08-10. Nobody came back to change the
// file, and its own header went on telling readers the operation was safe.
//
// The remaining legitimate use is rehearsing on a Neon branch, which is a copy
// of production: no data-shaped test can tell them apart, only the connection
// string. So the guards are about the target, not the contents.
//
// This test NEVER runs the destructive path. It only proves the refusals, by
// spawning the script and reading its exit code. A refusal is exit 2.
//
// Run: node scripts/regression-reset-guard.cjs
require('dotenv').config();
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const SCRIPT = join(__dirname, 'reset-sm-data.cjs');
const PROD = process.env.PLATFORM_DATABASE_URL;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Always with the most dangerous flags on: if a guard leaks, it leaks here.
const run = (env) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--commit', '--confirm'], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

if (!PROD) { console.error('PLATFORM_DATABASE_URL required to prove the production guard.'); process.exit(1); }

console.log('\n1. No RESET_DATABASE_URL — .env alone must not arm it');
{
  const r = run({ RESET_DATABASE_URL: '' });
  check(r.code === 2, 'refuses with exit 2', `exit=${r.code}`);
  check(/REFUSING TO RUN/.test(r.out), 'and says so');
  check(!/TRUNCATE|Applying/.test(r.out), 'nothing was applied');
}

console.log('\n2. Pointed at production — the accident this exists to prevent');
{
  const r = run({ RESET_DATABASE_URL: PROD });
  check(r.code === 2, 'refuses with exit 2', `exit=${r.code}`);
  check(/PRODUCTION database/.test(r.out), 'names production as the reason', r.out.split('\n')[0]);
  check(!/Applying/.test(r.out), 'nothing was applied');
}

console.log('\n3. Production in disguise — direct host instead of the pooled one');
{
  // The two hosts differ by one substring and are the SAME database. A plain
  // string compare would wave this through.
  const disguised = PROD.includes('-pooler.') ? PROD.replace('-pooler.', '.') : PROD.replace('.', '-pooler.');
  const r = run({ RESET_DATABASE_URL: disguised });
  check(r.code === 2, 'still refuses with exit 2', `exit=${r.code}`);
  check(/PRODUCTION database/.test(r.out), 'recognises it as the same database');
}

console.log('\n4. The header no longer tells the reader it is safe');
{
  const src = require('node:fs').readFileSync(SCRIPT, 'utf8');
  check(/NO LONGER RESETTABLE/.test(src), 'the file says SM is no longer resettable');
  check(!/^\/\/ SM DATA RESET.*D3: SM is resettable/m.test(src), 'the old "SM is resettable" claim is gone');
}

console.log('\n5. A non-production target gets PAST the guards');
{
  // Without this the suite could pass for the wrong reason: a script that
  // refuses everything satisfies checks 1-3 perfectly and is also useless.
  //
  // The usual proof — break the guard, watch the test fail — is not available
  // here. Removing the production guard and running with --commit --confirm IS
  // the accident. So the discrimination is proved from the other side: a target
  // that is not production must reach the connection attempt, and fail there.
  // No --commit, so even a reachable host would only count rows.
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, RESET_DATABASE_URL: 'postgresql://u:p@zz-not-a-real-host.invalid/branchdb?sslmode=require' },
    encoding: 'utf8', timeout: 60000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check(!/REFUSING TO RUN/.test(out), 'it is NOT refused — the guards target production, not everything');
  check(/TARGET\s+host=zz-not-a-real-host/.test(out), 'it prints the target host before doing anything',
    out.split('\n')[0]);
  check(/FATAL|ENOTFOUND|getaddrinfo/.test(out), 'and gets as far as the connection', out.trim().split('\n').pop());
}

console.log(failed === 0
  ? '\n✅ reset-guard: all checks passed'
  : `\n❌ reset-guard: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
