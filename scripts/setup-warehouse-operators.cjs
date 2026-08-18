// Turns "who did this" from typed text into something that can be filtered.
//
// WHY (owner decision, 2026-08-18). Finance asks "who used this, and when".
// Every one of the 893 stock returns in SA history names a person only inside
// free text — "Product return | Returned by: Gustavo" — and that text is typed
// by hand, so five people appear under nine spellings and some entries name two
// people separated by a slash. It can be read. It cannot be filtered or counted.
//
// WHY NOT JUST USE THE LOGIN. Because the login does not answer the question.
// Gustavo and Wanderson have no account and do the work through somebody else's
// — the owner confirmed it. So `user_id`, added the same day, records WHICH
// ACCOUNT was used, and for those 81 returns that is not the person. The two
// facts are different and both are kept:
//
//     user_id       which account was used      automatic, certain
//     operator_ids  who actually did the work   was typed, now chosen
//
// WHY A SEPARATE LIST rather than accounts for everyone: the owner chose it —
// these are warehouse people who may never log in, and naming them must not
// require giving them access.
//
// The mapping below is the only judgement in this file, so it is printed in
// full on a dry run for the owner to check before anything is written.
// "Fabricio/Joao" is two people. "Fabricio/Leopoldino" is one — his own
// surname, and his account is FabricioL.
//
// Additive only: a new table and a new column. Nothing existing is altered.
//
// Run:  node scripts/setup-warehouse-operators.cjs            (dry run)
//       node scripts/setup-warehouse-operators.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');

// canonical name → every spelling seen in the history, lower-cased
const PEOPLE = {
  'Joao Gabriel':        ['joao', 'joao g', 'joao gabriel'],
  'Fabricio Leopoldino': ['fabricio', 'fabriciol', 'leopoldino', 'fabricio leopoldino'],
  'Gustavo':             ['gustavo'],
  'Wanderson':           ['wanderson'],
  'Loshan':              ['loshan'],
};

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public',
});
const log = (s = '') => console.log(s);

// A note may name more than one person: "Fabricio/Joao" is both of them working
// together, which is why this returns a list and the column is an array.
const parseNames = (text) => String(text || '')
  .split(/[/,+&]| e /i).map((s) => s.trim().toLowerCase().replace(/[^a-z ]/g, '')).filter(Boolean);

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t, p) => client.query(t, p);
    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — warehouse operators\n`);

    // ── 1. Structure ──────────────────────────────────────────────────────
    await q(`CREATE TABLE IF NOT EXISTS sa.warehouse_operators (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL UNIQUE,
      user_id INTEGER,              -- their login, when they have one
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW())`);
    await q(`ALTER TABLE sa.transactions ADD COLUMN IF NOT EXISTS operator_ids INTEGER[]`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tx_operator_ids ON sa.transactions USING GIN (operator_ids)`);
    log('  1. table sa.warehouse_operators + transactions.operator_ids (additive)');

    // ── 2. The people ─────────────────────────────────────────────────────
    log('\n  2. operators');
    const idByAlias = new Map();
    for (const [name, aliases] of Object.entries(PEOPLE)) {
      // Link to a login where one exists — Gustavo and Wanderson have none, and
      // that is the whole point of this table.
      const u = (await q(
        `SELECT id, name FROM platform.users WHERE lower(name) = ANY($1::text[]) LIMIT 1`,
        [aliases])).rows[0];
      const row = (await q(
        `INSERT INTO sa.warehouse_operators (name, user_id) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET user_id = COALESCE(sa.warehouse_operators.user_id, EXCLUDED.user_id)
         RETURNING id`, [name, u?.id || null])).rows[0];
      aliases.forEach((a) => idByAlias.set(a, row.id));
      log(`     ${String(name).padEnd(22)} login: ${u ? `${u.name} (${u.id})` : 'none — works under someone else’s'}`);
    }

    // ── 3. The history ────────────────────────────────────────────────────
    log('\n  3. backfilling the returns');
    const rows = (await q(
      `SELECT id, notes FROM transactions
        WHERE notes ~* 'by:' AND operator_ids IS NULL`)).rows;
    let done = 0; const unknown = new Map();
    for (const r of rows) {
      const raw = (r.notes.match(/by:\s*(.*)$/i) || [])[1];
      const ids = [...new Set(parseNames(raw).map((n) => idByAlias.get(n)).filter(Boolean))];
      const missed = parseNames(raw).filter((n) => !idByAlias.has(n));
      missed.forEach((m) => unknown.set(m, (unknown.get(m) || 0) + 1));
      if (!ids.length) continue;
      await q(`UPDATE transactions SET operator_ids = $1 WHERE id = $2`, [ids, r.id]);
      done++;
    }
    log(`     ${done} of ${rows.length} rows resolved to a named person`);
    if (unknown.size) {
      log('     names the mapping does not know (left alone, the note still has them):');
      for (const [n, c] of [...unknown].sort((a, b) => b[1] - a[1])) log(`        ${String(n).padEnd(20)} ${c}`);
    }

    // ── 4. What it can now answer ─────────────────────────────────────────
    log('\n  4. the question that could not be answered before:');
    for (const r of (await q(
      `SELECT o.name, count(*) c, sum(t.quantity)::float qty
         FROM transactions t JOIN sa.warehouse_operators o ON o.id = ANY(t.operator_ids)
        GROUP BY o.name ORDER BY c DESC`)).rows) {
      log(`     ${String(r.name).padEnd(22)} ${String(r.c).padStart(4)} returns   ${r.qty} units`);
    }

    if (APPLY) { await client.query('COMMIT'); log('\n✅ committed\n'); }
    else { await client.query('ROLLBACK'); log('\n↩  rolled back — re-run with --apply to keep it\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
