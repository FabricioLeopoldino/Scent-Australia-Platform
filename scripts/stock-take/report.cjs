// The record of what the stock take changed: before, counted, after.
//
// WHY (2026-08-31). A stock take that moves 830 litres has to be explainable
// afterwards, to the warehouse and to the people who authorised it. The ledger
// holds every line, but reading 165 ledger rows is not an answer — this is the
// one page that says what each fragrance was, what was counted, and what it is
// now, with the difference beside it.
//
// Everything is read from the DATABASE and the LEDGER, never from the plan file.
// A report generated from the plan would say what was intended; this says what
// actually happened, which is the only version worth keeping.
//
// READ-ONLY. Writes a CSV and an HTML page.
//
// Run: node scripts/stock-take/report.cjs
require('dotenv').config();
const { Pool } = require('pg');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { LITRE, HOLD, parseSheet, buildMatcher } = require('./lib.cjs');
const { page } = require('./page.cjs');

const SHEET = join(__dirname, '2026-08-28-fragrances.txt');
const NOTE_PREFIX = 'Stock take 28/08/2026';
const COUNT_DATE = '28 August 2026';
const APPLIED_DATE = '31 August 2026';

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true },
  options: '-c search_path=sa,public',
});

const L = (ml) => (ml / LITRE).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const esc = (s) => String(s ?? '').split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');

(async () => {
  const oils = (await pool.query(
    `SELECT "productCode" AS code, name, supplier_code, unit, "currentStock"::float AS stock
       FROM sa.products WHERE category = 'OILS'`)).rows;
  const matcher = buildMatcher(oils);
  const byCode = new Map(oils.map((o) => [o.code, o]));

  // The ledger is the authority on what changed. balance_after carries the
  // figure after the adjustment; quantity is a magnitude, so the BEFORE is
  // reconstructed from the note, which records it explicitly for this reason.
  const adjust = new Map((await pool.query(
    `SELECT product_code, balance_after::float AS after, notes
       FROM sa.transactions
      WHERE type = 'adjust' AND notes LIKE $1 || '%'`, [NOTE_PREFIX]))
    .rows.map((r) => [r.product_code, r]));

  const techCleared = new Map((await pool.query(
    `SELECT product_code, quantity::float AS ml FROM sa.transactions
      WHERE type = 'tech_remove' AND notes LIKE $1 || '%'`, [NOTE_PREFIX]))
    .rows.map((r) => [r.product_code, r.ml]));

  const techStill = new Map((await pool.query(
    `SELECT p."productCode" AS code, t.quantity::float AS ml
       FROM sa.tech_stock t JOIN sa.products p ON p.id = t.product_id
      WHERE t.quantity <> 0`)).rows.map((r) => [r.code, r.ml]));

  const rows = [];
  for (const r of parseSheet(readFileSync(SHEET, 'utf8')).filter((x) => !x.bad)) {
    const { hit } = matcher(r);
    if (hit.length !== 1) continue;
    const o = byCode.get(hit[0].code);
    const adj = adjust.get(o.code);
    // "Before" is the figure the note recorded at the moment of the change.
    // Parsed from the note rather than recomputed: the note is what a person
    // reading the history will see, so the report must agree with it exactly.
    const m = adj && String(adj.notes).match(/;\s*(-?\d+(?:\.\d+)?)\s*→/);
    const before = m ? parseFloat(m[1]) : o.stock;
    rows.push({
      code: o.code, name: o.name, supplier: o.supplier_code || '',
      before, counted: r.counted * LITRE, after: o.stock,
      change: o.stock - before,
      applied: !!adj,
      held: !!HOLD[o.code],
      techCleared: techCleared.get(o.code) || 0,
      techStill: techStill.get(o.code) || 0,
    });
  }
  rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  // Three states, decided by fact rather than by inference: a ledger row exists,
  // the product is on the hold list, or the count already agreed with the system.
  const applied = rows.filter((r) => r.applied);
  const held = rows.filter((r) => r.held);
  const unchanged = rows.filter((r) => !r.applied && !r.held);
  const totalUp = applied.filter((r) => r.change > 0).reduce((s, r) => s + r.change, 0);
  const totalDown = applied.filter((r) => r.change < 0).reduce((s, r) => s + r.change, 0);
  const totalTech = [...techCleared.values()].reduce((s, v) => s + v, 0);
  const negatives = rows.filter((r) => r.after < 0);

  // ── CSV, for the spreadsheet ───────────────────────────────────────────────
  const q = (v) => `"${String(v ?? '').split('"').join('""')}"`;
  const csv = [['product_code', 'fragrance', 'supplier_code', 'unit',
    'before_ml', 'counted_ml', 'after_ml', 'change_ml',
    'before_L', 'counted_L', 'after_L', 'change_L',
    'technician_stock_cleared_ml', 'status'].join(',')];
  for (const r of rows) {
    csv.push([q(r.code), q(r.name), q(r.supplier), 'mL',
      r.before, r.counted, r.after, r.change,
      (r.before / LITRE).toFixed(1), (r.counted / LITRE).toFixed(1),
      (r.after / LITRE).toFixed(1), (r.change / LITRE).toFixed(1),
      r.techCleared, q(r.applied ? (r.change ? 'adjusted' : 'no change') : 'held for recount')].join(','));
  }
  const csvPath = join(__dirname, 'stock-take-result.csv');
  writeFileSync(csvPath, csv.join('\n'), 'utf8');

  // ── The page ───────────────────────────────────────────────────────────────
  // Presentation lives in page.cjs; this file stays about the numbers.
  const html = page({
    rows, held, negatives, L,
    totals: { up: totalUp, down: totalDown, tech: totalTech },
    meta: { countDate: COUNT_DATE, appliedDate: APPLIED_DATE },
  });

  const htmlPath = join(__dirname, 'stock-take-report.html');
  writeFileSync(htmlPath, html, 'utf8');

  console.log(`\nfragrances       ${rows.length}`);
  console.log(`adjusted         ${applied.length}`);
  console.log(`already correct  ${unchanged.length}`);
  console.log(`held back        ${held.length}`);
  console.log(`below zero       ${negatives.length}`);
  console.log(`\nfound   +${L(totalUp)} L`);
  console.log(`missing ${L(totalDown)} L`);
  console.log(`tech    -${L(totalTech)} L`);
  console.log(`\n  ${csvPath}\n  ${htmlPath}\n`);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
