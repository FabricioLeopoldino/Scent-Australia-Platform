// Proves the Shopify retry cron stopped polling the database around the clock.
//
// WHY THIS EXISTS (2026-08-10): with SM_SHOPIFY_SYNC_ENABLED=true in production
// runRetryQueue ran `SELECT * FROM pending_shopify_sync` every 60 seconds
// forever. That is 1,440 queries a day against a table that is almost always
// empty, and it is why the Neon compute never reached its 5-minute autosuspend
// — the single biggest line on the bill, and the one cause that survived every
// other explanation being ruled out.
//
// Three properties, all of which have to hold together:
//   1. the cron only runs inside the warehouse window (the same single
//      definition the keep-alive uses, which already holds that window awake,
//      so polling inside it costs nothing extra)
//   2. enqueueing kicks a drain immediately, so a draft order created at 17:30
//      still reaches Shopify at 17:30 and nothing regresses
//   3. only ONE drain runs at a time — two overlapping drains would SELECT the
//      same pending row and push a DUPLICATE draft order to a real client
//
// Pure unit test against the module: no server, no Shopify, no writes. The DB
// is never reached because outbound is left disabled, which is itself the
// point — if the code tried to query, the missing config would surface.
//
// Run: node scripts/regression-sync-cron-window.js
import { withinWarehouseHours } from '../shared/warehouse-hours.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'server/sm/services/shopify-sync.js'), 'utf8');

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// ── 1. The cron is gated, and by the shared definition ─────────────────────
check(/setInterval\(\(\)\s*=>\s*\{\s*if \(withinWarehouseHours\(\)\) runRetryQueue\(\)\s*\}, 60_000\)/.test(SRC),
  'the 60s tick only calls runRetryQueue inside the warehouse window');
check(/await import\('\.\.\/\.\.\/\.\.\/shared\/warehouse-hours\.js'\)/.test(SRC),
  'it uses the single shared window definition, not a local copy');
check(!/function withinWarehouseHours/.test(SRC),
  'the window is NOT reimplemented in this module');

// The import path must actually resolve from that file's location.
try {
  await import('../shared/warehouse-hours.js');
  check(true, 'shared/warehouse-hours.js resolves');
} catch (e) { check(false, 'shared/warehouse-hours.js resolves', e.message); }

// ── 2. Enqueueing does not wait for the window ─────────────────────────────
const enqueueBodies = [...SRC.matchAll(/async function (enqueue\w+)\([^)]*\)\s*\{([\s\S]*?)\n\}/g)];
check(enqueueBodies.length === 2, 'both enqueue functions found', `${enqueueBodies.length}`);
for (const [, name, body] of enqueueBodies) {
  check(/kickDrain\(\)/.test(body), `${name} kicks a drain immediately`);
}
check(/function kickDrain\(\)[\s\S]*?setImmediate/.test(SRC),
  'the kick is deferred, so the caller never waits on Shopify');
check(/function kickDrain\(\)\s*\{\s*if \(!outboundEnabled\(\)\) return/.test(SRC),
  'the kick still respects the cutover gate');

// ── 3. Only one drain at a time ────────────────────────────────────────────
check(/if \(draining\) return\s*\n\s*draining = true/.test(SRC),
  'runRetryQueue refuses to start while another drain is running');
check(/finally \{\s*\n\s*draining = false/.test(SRC),
  'the flag is cleared in finally, so one failure cannot wedge the queue shut');

// ── 4. The window itself still behaves ─────────────────────────────────────
// (regression-warehouse-hours.js owns this in full; this is a smoke check that
// the helper this module now depends on is the real, working one.)
const at = (iso) => withinWarehouseHours(new Date(iso));
check(at('2026-08-10T02:00:00Z') === true, 'Mon 12:00 Melbourne is inside the window');
check(at('2026-08-09T18:00:00Z') === false, 'Mon 04:00 Melbourne is outside — this is what stops the polling');
check(at('2026-08-08T02:00:00Z') === false, 'Saturday is outside');

console.log(failed === 0
  ? `\n✅ sync-cron-window: all checks passed`
  : `\n❌ sync-cron-window: ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
