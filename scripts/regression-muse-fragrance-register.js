// Proves a new MUSE fragrance gets its store codes FROM the platform.
//
// WHY THIS EXISTS (2026-08-11). The Muse store used to be the source of the
// SKU: marketing created the product and typed the codes. Four products
// launched under the wrong code on 7 August, and eleven more were found
// selling wrong on 11 August — one of them shipping a different fragrance
// than the customer bought. The codes are now minted here and travel outward,
// so there is no second place for them to be typed and drift.
//
// The contract this protects:
//   · the number continues the sequence and is never a gap being refilled
//   · all three formats get the SAME number, differing only by prefix
//   · the codes agree with the format they are sold as (TS/RS/RD) — the exact
//     rule the readiness check enforces against the live store
//   · a variant is born on the OIL model, with no legacy fragrance link: with
//     both links present the BOM builder used to bill the fragrance twice
//   · an oil reserved for SA or SM is refused, instead of becoming a sellable
//     product that cannot be produced
//   · registering a second time allocates the NEXT number, never the same one
//
// Boots its own server on a spare port. It DOES insert into sa.products — two
// disposable oils of its own, deleted in teardown — but never reads, updates or
// deletes a real one. It also creates a temporary root account whose password is
// written in this file; that is cleared at both ends, because a run that dies
// mid-way would otherwise leave a usable root login in production.
//
// Run: node scripts/regression-muse-fragrance-register.js
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = String(Date.now()).slice(-7);
const OIL_OK = `ZZOK${STAMP}`;
const OIL_EXCL = `ZZEX${STAMP}`;

if (!process.env.PLATFORM_DATABASE_URL) { console.error('PLATFORM_DATABASE_URL required.'); process.exit(1); }
const db = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, server, log = '', TOKEN = null, createdIds = [];
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
// Children before parents: sm.users mirrors the platform id, and
// platform.user_modules references it.
const dropTestUser = async () => {
  const u = (await db.query(`SELECT id FROM platform.users WHERE name = '__regression_mf'`)).rows[0];
  if (!u) return;
  await db.query(`DELETE FROM platform.user_modules WHERE user_id = $1`, [u.id]).catch(() => {});
  await db.query(`DELETE FROM users WHERE id = $1`, [u.id]).catch(() => {});
  await db.query(`DELETE FROM platform.users WHERE id = $1`, [u.id]).catch(() => {});
};

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};

try {
  // ── Disposable oils. Never touch a real one. ─────────────────────────────
  for (const [id, excl] of [[OIL_OK, null], [OIL_EXCL, 'SA']]) {
    await db.query(
      `INSERT INTO sa.products (id, tag, name, category, "productCode", "currentStock", unit, status, exclusivity)
       VALUES ($1,$1,$2,'OILS',$1,50000,'mL','active',$3)`,
      [id, `[regression] ${id}`, excl]);
  }

  // Clear any leftover from a run that died before its teardown. While it
  // exists this is a ROOT account whose password is written in this file, and
  // this file is in the repository — so it must not outlive the run. Cleared at
  // both ends rather than only at the end.
  await dropTestUser();

  const hash = bcrypt.hashSync('RegressionMf1!', 10);
  const uid = (await db.query(
    `INSERT INTO platform.users (name, password_hash, role, must_change_password)
     VALUES ('__regression_mf', $1, 'root', false)
     ON CONFLICT (name) DO UPDATE SET password_hash = $1, must_change_password = false RETURNING id`,
    [hash])).rows[0].id;
  await db.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1,'SM') ON CONFLICT DO NOTHING`, [uid]);
  await db.query(`INSERT INTO users (id, name, password_hash, role) VALUES ($1,'__regression_mf',$2,'root') ON CONFLICT (id) DO NOTHING`, [uid, hash]);

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  const login = await api('POST', '/api/platform/auth/login', { name: '__regression_mf', password: 'RegressionMf1!' });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  TOKEN = login.json.token;

  const highest = Number((await db.query(
    `SELECT COALESCE(MAX(substring(sku from '[0-9]+')::int),0) n FROM products WHERE sku LIKE 'Muse\\_%'`)).rows[0].n);

  // ── 1. Preview shows everything and writes nothing ───────────────────────
  console.log('\n1. Preview — what would be created, before anything is');
  const before = Number((await db.query(`SELECT COUNT(*) n FROM products`)).rows[0].n);
  const pv = await api('GET', `/api/sm/muse-fragrance/preview?oil_id=${OIL_OK}`);
  check(pv.status === 200, 'preview answers 200', `${pv.status} ${JSON.stringify(pv.json)}`);
  check(pv.json?.number === highest + 1, `it continues the sequence (${highest} → ${highest + 1})`, `got ${pv.json?.number}`);
  const n = String(pv.json?.number).padStart(5, '0');
  const skus = (pv.json?.lines || []).map((l) => l.sku);
  check(JSON.stringify(skus) === JSON.stringify([`Muse_TS${n}`, `Muse_RS${n}`, `Muse_RD${n}`]),
    'all three formats share the number, differing only by prefix', JSON.stringify(skus));
  const prices = Object.fromEntries((pv.json?.lines || []).map((l) => [l.master, l.price]));
  check(prices.TS10 === 15 && prices.RS100 === 39 && prices.RD200 === 49,
    'prices come from the masters (15 / 39 / 49)', JSON.stringify(prices));
  const after = Number((await db.query(`SELECT COUNT(*) n FROM products`)).rows[0].n);
  check(before === after, 'the preview wrote nothing', `${before} → ${after}`);

  // ── 2. An oil reserved for another business is refused ───────────────────
  console.log('\n2. Exclusivity — refused at registration, not at production');
  const ex = await api('GET', `/api/sm/muse-fragrance/preview?oil_id=${OIL_EXCL}`);
  check(ex.status === 400, 'an SA-exclusive oil is refused', `${ex.status} ${JSON.stringify(ex.json)}`);
  check(/exclusive/i.test(ex.json?.error || ''), 'and the reason says so', ex.json?.error);
  const nf = await api('GET', `/api/sm/muse-fragrance/preview?oil_id=ZZ_NO_SUCH_OIL`);
  check(nf.status === 404, 'an unknown oil is 404', `${nf.status}`);

  // ── 3. Registering creates the three variants ────────────────────────────
  console.log('\n3. Register');
  const cr = await api('POST', '/api/sm/muse-fragrance', { oil_id: OIL_OK, title: `ZZ Test Blossom ${STAMP}` });
  check(cr.status === 201, 'registration answers 201', `${cr.status} ${JSON.stringify(cr.json)}`);
  createdIds = (cr.json?.created || []).map((c) => c.id);
  check(createdIds.length === 3, 'three variants created', `${createdIds.length}`);

  const rows = (await db.query(
    `SELECT sku, barcode, name, oil_id, fragrance_id, segment, current_stock, price, master_product_id, product_code
       FROM products WHERE id = ANY($1::int[]) ORDER BY sku`, [createdIds])).rows;
  // One string identifies the variant to the scanner, to the store and to us.
  check(rows.every((r) => r.barcode === r.sku), 'the barcode is the code',
    JSON.stringify(rows.map((r) => `${r.sku}/${r.barcode}`)));
  check(rows.every((r) => r.oil_id === OIL_OK), 'every variant points at the chosen oil');
  check(rows.every((r) => r.fragrance_id === null),
    'NO legacy fragrance link — the double-charge cannot come back this way',
    JSON.stringify(rows.map((r) => r.fragrance_id)));
  check(rows.every((r) => r.segment === 'MUSE'), 'segment is MUSE');
  check(rows.every((r) => Number(r.current_stock) === 0), 'stock starts at zero (make-to-order)');
  check(rows.every((r) => r.master_product_id !== null), 'each is attached to its master');

  // The rule the readiness check enforces against the live store: the prefix
  // has to agree with the format the variant is sold as.
  const EXPECT = { 'Travel Spray 10ml': 'TS', 'Room Spray 100ml': 'RS', 'Reed Diffuser 200ml': 'RD' };
  const misfit = rows.filter((r) => {
    const fmt = Object.keys(EXPECT).find((k) => r.name.startsWith(k));
    return !fmt || !r.sku.startsWith(`Muse_${EXPECT[fmt]}`);
  });
  check(misfit.length === 0, 'every code agrees with the format it names',
    JSON.stringify(misfit.map((r) => `${r.sku}=${r.name}`)));
  check(rows.every((r) => r.name.endsWith(`ZZ Test Blossom ${STAMP}`)), 'the title is applied to all three',
    JSON.stringify(rows.map((r) => r.name)));

  // ── 4. A second registration takes the NEXT number ───────────────────────
  // One oil may legitimately sell under two commercial names, so this is
  // allowed — but it must never reuse the number, or two products answer to
  // one code and the order matcher picks whichever it finds.
  console.log('\n4. Registering the same oil again — allowed, but a new number');
  const cr2 = await api('POST', '/api/sm/muse-fragrance', { oil_id: OIL_OK, title: `ZZ Second Name ${STAMP}` });
  check(cr2.status === 201, 'the second registration is allowed', `${cr2.status}`);
  createdIds = [...createdIds, ...((cr2.json?.created || []).map((c) => c.id))];
  check(cr2.json?.number === (pv.json?.number ?? 0) + 1, 'it takes the next number, not the same one',
    `${pv.json?.number} → ${cr2.json?.number}`);
  check((cr2.json?.warnings || []).some((w) => /already has/.test(w)),
    'and it warns that the oil already has variants', JSON.stringify(cr2.json?.warnings));

  // ── 5. The publish lookup must actually find the variants ────────────────
  // The first version searched with LIKE 'Muse\__00127'. In SQL `_` matches ONE
  // character and the prefix is two (TS/RS/RD), so it matched nothing: every
  // publish answered "No variants found for number N", and the retry button
  // failed the same way. Publishing is disabled locally, so the proof is that
  // the error is now about Shopify rather than about missing rows.
  console.log('\n5. Publish finds the registration (the LIKE bug)');
  {
    const r = await api('POST', `/api/sm/muse-fragrance/${cr.json.number}/publish`, {});
    check(!/No variants found/i.test(r.json?.error || ''),
      'the lookup finds them — it no longer reports "No variants found"', r.json?.error);
    check(/disabled|not configured|Shopify/i.test(r.json?.error || ''),
      'it fails on Shopify instead, which is expected with publishing off here', r.json?.error);
  }

  // ── 6. A registration can be undone ──────────────────────────────────────
  console.log('\n6. Delete — and only while it is safe to');
  {
    const num = cr2.json.number;
    const one = (cr2.json.created || [])[0];
    await db.query(`UPDATE products SET current_stock = 5 WHERE id = $1`, [one.id]);
    const blocked = await api('DELETE', `/api/sm/muse-fragrance/${num}`);
    check(blocked.status === 409, 'refused while a variant holds stock', `${blocked.status} ${blocked.json?.error}`);
    check(/holds stock/i.test(blocked.json?.error || ''), 'and says which', blocked.json?.error);
    await db.query(`UPDATE products SET current_stock = 0 WHERE id = $1`, [one.id]);

    const del = await api('DELETE', `/api/sm/muse-fragrance/${num}`);
    check(del.status === 200, 'deleted once nothing depends on it', `${del.status} ${JSON.stringify(del.json)}`);
    const left = Number((await db.query(
      `SELECT COUNT(*) n FROM products WHERE substring(sku from '[0-9]+$')::int = $1 AND sku LIKE 'Muse@_%' ESCAPE '@'`,
      [num])).rows[0].n);
    check(left === 0, 'all three variants are gone', `${left} left`);
    createdIds = createdIds.filter((id) => !(cr2.json.created || []).some((c) => c.id === id));

    // Deleting the highest number frees it, so a mistyped registration does not
    // burn a code forever.
    const nextNow = Number((await db.query(
      `SELECT COALESCE(MAX(substring(sku from '[0-9]+')::int),0)+1 n FROM products WHERE sku LIKE 'Muse@_%' ESCAPE '@'`)).rows[0].n);
    check(nextNow === num, 'the number is released for reuse', `next is ${nextNow}, deleted ${num}`);

    const gone = await api('DELETE', `/api/sm/muse-fragrance/${num}`);
    check(gone.status === 404, 'deleting it again is a clean 404', `${gone.status}`);

    // THE ORIGINAL CATALOGUE MUST BE UNREACHABLE FROM HERE. The first version of
    // the button keyed on "no Shopify id and zero stock", which showed it on 358
    // of the 366 live variants — two clicks from deleting a selling product's
    // record and orphaning it on the store. Only codes this screen wrote
    // (MASTER-M#####) may be undone; the catalogue carries MASTER-FRAG_#####.
    const legacyNum = Number((await db.query(
      `SELECT substring(sku from '[0-9]+$')::int n FROM products
        WHERE product_code LIKE '%-FRAG@_%' ESCAPE '@' AND sku LIKE 'Muse@_%' ESCAPE '@'
        LIMIT 1`)).rows[0]?.n);
    if (legacyNum) {
      const refused = await api('DELETE', `/api/sm/muse-fragrance/${legacyNum}`);
      check(refused.status === 403, `a catalogue fragrance (number ${legacyNum}) cannot be deleted here`,
        `${refused.status} ${refused.json?.error}`);
      check(/original catalogue/i.test(refused.json?.error || ''), 'and the refusal says why', refused.json?.error);
      const still = Number((await db.query(
        `SELECT COUNT(*) n FROM products WHERE substring(sku from '[0-9]+$')::int = $1
           AND sku LIKE 'Muse@_%' ESCAPE '@'`, [legacyNum])).rows[0].n);
      check(still > 0, 'and it is still there', `${still} rows`);
    } else {
      check(false, 'could not find a legacy variant to prove the refusal');
    }
  }

  // ── 7. GraphQL ids must be reduced to numbers before they are stored ─────
  // The first real publish created the product on Shopify and then failed to
  // record it: GraphQL returns "gid://shopify/Product/9530063945941" and the
  // columns are BIGINT, so the UPDATE threw 22P02. The store had the product,
  // the platform believed nothing was published, and the delete button was
  // offered on a fragrance that was live.
  console.log('\n7. Shopify GIDs are converted before storage');
  {
    const { gidNumber } = await import('../server/sm/routes/muse-fragrance.js')
      .then((m) => m.default ?? m).catch(() => ({}));
    const gn = gidNumber || require('../server/sm/routes/muse-fragrance.js').gidNumber;
    check(gn('gid://shopify/Product/9530063945941') === '9530063945941', 'a product GID becomes its number');
    check(gn('gid://shopify/ProductVariant/54475012833493') === '54475012833493', 'a variant GID too');
    check(gn(null) === null && gn('') === null, 'nothing in, nothing out');

    // The reason the conversion has to exist, asserted rather than remembered.
    const bad = await db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema='sm' AND table_name='products'
          AND column_name IN ('shopify_product_id','shopify_variant_id','shopify_inventory_item_id')`);
    check(bad.rows.length === 3 && bad.rows.every((r) => r.data_type === 'bigint'),
      'the three shopify id columns are BIGINT — a raw GID cannot be stored',
      JSON.stringify(bad.rows.map((r) => r.data_type)));
  }

  console.log(failed === 0
    ? '\n✅ muse-fragrance-register: all checks passed'
    : `\n❌ muse-fragrance-register: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  failed++;
} finally {
  if (failed > 0) console.log(`\n─── server log (tail) ───\n${log.split('\n').slice(-25).join('\n')}`);
  if (server) server.kill();
  // Audit rows first, keyed on the ids while they still exist to be matched.
  if (createdIds.length) {
    await db.query(`DELETE FROM audit_log WHERE entity_type='product' AND entity_id = ANY($1::int[])`, [createdIds]).catch(() => {});
    await db.query(`DELETE FROM products WHERE id = ANY($1::int[])`, [createdIds]).catch(() => {});
  }
  await db.query(`DELETE FROM sa.products WHERE id = ANY($1::text[])`, [[OIL_OK, OIL_EXCL]]).catch(() => {});
  await dropTestUser().catch(() => {});
  // Say it out loud: a silent teardown is how 33 audit rows and a root account
  // were left in production on earlier runs.
  const left = (await db.query(
    `SELECT (SELECT COUNT(*) FROM products WHERE product_code LIKE 'ZZ%' OR name LIKE 'ZZ %') p,
            (SELECT COUNT(*) FROM sa.products WHERE id LIKE 'ZZ%') o,
            (SELECT COUNT(*) FROM platform.users WHERE name = '__regression_mf') u`)).rows[0];
  console.log(`teardown: products=${left.p} oils=${left.o} testUser=${left.u}` +
    (Number(left.p) + Number(left.o) + Number(left.u) === 0 ? '  ✅ clean' : '  ⚠️  RESIDUE LEFT'));
  await db.end();
}
process.exitCode = failed === 0 ? 0 : 1;
