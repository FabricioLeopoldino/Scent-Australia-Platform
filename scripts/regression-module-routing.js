// Proves every module tile sends its API calls to a base that exists.
//
// WHY THIS EXISTS (2026-09-15). The owner: "Fragrance Library, quando acesso o
// mesmo direto pelo SA ou quando fico alterando o menu, sempre tenho que dar
// Hard Refresh na tela pq ele buga aparecendo spare parts."
//
// Two separate faults behind one complaint.
//
//   1. The Fragrance Library tile stores 'FRAGLIB' as the active module, and
//      apiBase() knew only SA, SM, MUSE and OPS. FRAGLIB fell through to the
//      platform base, so the page's bare fetch('/api/products') became
//      /api/platform/products — a route that does not exist. Opening the
//      library from its own tile 404'd everything on it, and stayed broken
//      because the wrong value lives in localStorage, not in the page.
//
//   2. /sa/products and /sa/fragrance-library render the SAME component with a
//      different prop. Without a key React reconciles one into the other and
//      keeps its state, so the Fragrance Library opened holding the Products
//      page's already-filtered rows — spare parts included — until a hard
//      refresh forced a remount. That is the bug the owner actually saw.
//
// WHAT THIS FILE CAN AND CANNOT CHECK. Fault 1 is pure logic and is asserted
// directly: every tile key, through the real apiBase(), must land on a base the
// server actually mounts. Fault 2 is React reconciliation, which needs a
// renderer — so it is asserted structurally instead: each duplicated component
// in the route table must carry a key. That is weaker than a render test and it
// is the honest limit of it, but it fails if someone deletes the keys, which is
// the regression worth catching.
//
// READ-ONLY. Reads source files and the live route table. Writes nothing.
//
// Run: node scripts/regression-module-routing.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3982;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0, server;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// The real function, not a copy — a copy is how the two drifted apart in the
// first place. api.js touches localStorage only through getActiveModule(),
// which apiBase() skips entirely when given an explicit module.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { apiBase } = await import('../src/shell/api.js');

try {
  console.log('\n1. Every tile the picker offers resolves to a real API base');
  const picker = readFileSync(join(ROOT, 'src/shell/ModulePicker.jsx'), 'utf8');
  const tiles = [...picker.matchAll(/key:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  check(tiles.length >= 6, `found ${tiles.length} tiles in the picker`, tiles.join(', '));
  check(tiles.includes('FRAGLIB'), 'including FRAGLIB, the one that was broken');

  // What the server actually mounts. Anything else is a 404 waiting to happen.
  const index = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  const mounted = ['/api/sa', '/api/sm', '/api/platform']
    .filter((b) => index.includes(`'${b}'`) || index.includes(`"${b}"`));
  check(mounted.length === 3, 'the server mounts all three bases', mounted.join(', '));

  for (const tile of tiles) {
    const base = apiBase(tile);
    check(mounted.includes(base), `${tile} → ${base}`, 'not a mounted base');
  }

  console.log('\n2. FRAGLIB is an SA view, so it must reach the SA API');
  // The specific fault. FRAGLIB opens ProductManagement, which calls
  // fetch('/api/products') — that only exists under /api/sa.
  check(apiBase('FRAGLIB') === '/api/sa',
    'FRAGLIB resolves to /api/sa, not the platform fallback', apiBase('FRAGLIB'));
  check(apiBase('FRAGLIB') === apiBase('SA'),
    'and to the same base as SA itself, because it is the same module');

  console.log('\n3. A tile nobody mapped must not silently become "platform"');
  // The shape of the bug, independent of FRAGLIB: an unknown key falls through
  // to /api/platform and fails only at runtime, on whichever page it opened.
  const unmapped = tiles.filter((t) => apiBase(t) === '/api/platform' && t !== 'REPORTS');
  check(unmapped.length === 0,
    'no tile lands on the platform fallback by accident (REPORTS does so on purpose)',
    unmapped.join(', '));

  console.log('\n4. Routes that share a component carry distinct keys');
  // React reuses a component rendered at the same position, keeping its state.
  // Two routes rendering ProductManagement with different props are two pages,
  // and must say so.
  const sa = readFileSync(join(ROOT, 'src/sa/SAModule.jsx'), 'utf8');
  const routes = [...sa.matchAll(/<Route path="([^"]+)">\s*<(\w+)([^>]*)\/>/g)]
    .map((m) => ({ path: m[1], comp: m[2], attrs: m[3] }));
  const byComp = {};
  for (const r of routes) (byComp[r.comp] ||= []).push(r);
  const shared = Object.entries(byComp).filter(([, rs]) => rs.length > 1);
  check(shared.length > 0, `${shared.length} component(s) render on more than one route`,
    shared.map(([c, rs]) => `${c}×${rs.length}`).join(', '));
  for (const [comp, rs] of shared) {
    const keyed = rs.filter((r) => /\bkey=/.test(r.attrs));
    check(keyed.length === rs.length,
      `${comp} carries a key on all ${rs.length} of its routes`,
      rs.filter((r) => !/\bkey=/.test(r.attrs)).map((r) => r.path).join(', '));
    const keys = new Set(rs.map((r) => (r.attrs.match(/key="([^"]+)"/) || [])[1]));
    check(keys.size === rs.length, `and the keys differ from each other`, [...keys].join(', '));
  }

  console.log('\n5. The oils-locked page really is locked, whatever the filter says');
  // Belt and braces on the symptom itself: the Fragrance Library filters to
  // OILS before the category filter is even consulted, so no stale chip can
  // bring spare parts back.
  const pm = readFileSync(join(ROOT, 'src/sa/pages/ProductManagement.jsx'), 'utf8');
  check(/libraryMode\s*\n?\s*\?\s*filtered\.filter\(p => p\.category === 'OILS'\)/.test(pm),
    'libraryMode hard-filters to OILS');
  const deps = pm.match(/filterProducts\(\);\s*\n\s*\},\s*\[([^\]]+)\]/);
  check(!!deps && deps[1].includes('libraryMode'),
    'and the effect that applies it watches libraryMode',
    deps ? deps[1].replace(/\s+/g, ' ') : 'effect not found');

  console.log('\n6. The bases resolve against a server that is actually running');
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let up = false;
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error('server did not boot');
  const token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SA', 'SM'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
  const hdr = { headers: { Authorization: `Bearer ${token}` } };

  // The exact URL the Fragrance Library builds, and the one it used to build.
  const good = await fetch(`${BASE}${apiBase('FRAGLIB')}/products`, hdr);
  check(good.ok, `${apiBase('FRAGLIB')}/products answers`, `HTTP ${good.status}`);
  const bad = await fetch(`${BASE}/api/platform/products`, hdr);
  check(bad.status === 404,
    '/api/platform/products is still a 404 — which is what the page used to call',
    `HTTP ${bad.status}`);

  console.log(failed === 0
    ? '\n✅ module-routing: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(failed === 0 ? 0 : 1);
}
