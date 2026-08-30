// Reading a stock-take sheet, and tying each line to a product. ONE definition.
//
// WHY THIS IS SHARED (2026-08-31). The report and the thing that actually writes
// must agree on every single match, or the owner approves one list and a
// different one is applied. Two copies of a matcher is exactly how the two
// webhook topic lists and the two "Returned By" boxes drifted apart.
//
// THE UNIT. The sheet's counted column is LITRES; the system holds mL. Confirmed
// against the 99 lines that had not moved since the sheet was written — counted
// x 1000 lands on the system's figure. Owner confirmed 31/08.
const LITRE = 1000;

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[()[\]]/g, ' ').replace(/[&+]/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

// Name | Aliases | Current Stock | Stock on Hand | Supplier Code
function parseSheet(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d{3})\.\s*(.*)$/);
    if (!m) continue;
    const parts = m[2].split('|').map((x) => x.trim());
    // Line 039 carries two supplier codes and so has an extra pipe. The supplier
    // code is everything from the fifth field on, never "the fifth field".
    if (parts.length < 4) { rows.push({ no: m[1], bad: line.trim() }); continue; }
    rows.push({
      no: m[1],
      name: parts[0],
      aliases: parts[1] === '-' ? [] : parts[1].split(',').map((a) => a.trim()).filter(Boolean),
      sheetSystem: num(parts[2]),          // what the system said when the sheet was made
      counted: num(parts[3]),              // litres, physically counted
      supplierCode: parts.slice(4).join(' ').trim(),
    });
  }
  return rows;
}

// The supplier code is the strong key. Three of them — FIA231877, LUX0710 and
// LUX0637 — are shared by two fragrances each, on the sheet AND in the library,
// so where the code points at several the NAME decides between those and no
// others. Name alone is the last resort: it is the key that put eleven products
// on sale under the wrong code (PRD locked decision 1).
function buildMatcher(oils) {
  const byCode = new Map();
  const byName = new Map();
  for (const o of oils) {
    const sc = norm(o.supplier_code);
    if (sc) { if (!byCode.has(sc)) byCode.set(sc, []); byCode.get(sc).push(o); }
    const n = norm(o.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(o);
  }
  return (row) => {
    let hit = [], how = '';
    const sc = norm(row.supplierCode);
    if (sc && sc !== '-' && byCode.has(sc)) { hit = byCode.get(sc); how = 'supplier code'; }
    if (hit.length > 1) {
      const narrowed = hit.filter((h) => norm(h.name) === norm(row.name));
      if (narrowed.length === 1) { hit = narrowed; how = 'supplier code + name'; }
    }
    if (!hit.length && byName.has(norm(row.name))) { hit = byName.get(norm(row.name)); how = 'name'; }
    if (!hit.length) {
      for (const a of row.aliases) {
        if (byName.has(norm(a))) { hit = byName.get(norm(a)); how = `alias "${a}"`; break; }
      }
    }
    return { hit, how };
  };
}

// What the balance SHOULD be now.
//
// The count is the truth as at the day it was taken, not as at today. Between
// the Friday count and the Monday it was applied there were 91 real movements
// across 39 oils. Writing the counted figure straight in would erase them.
//
//   proposed = counted litres + whatever moved AFTER the count
//
// FIRST ATTEMPT, WRONG, KEPT AS A WARNING. It used the sheet's own "current
// stock" column as the before-figure: proposed = counted + (now - sheet). That
// column turned out to be STALE on 65 of the 68 products that moved - it was
// read when the sheet was PREPARED, not on count day, and one of them (Crossfit)
// was last true on 10 July. Carrying forward from it would have added movements
// that happened BEFORE the count and are therefore already inside the physical
// figure. Double-counted. The sheet's column is now used only to check the
// transcription, never to compute a balance.
//
// The before-figure comes from the ledger instead: the balance the system
// recorded at the cutoff. Read, not replayed - the same rule the statement
// screen follows, because replaying magnitudes is how that screen got four
// successive wrong answers.
//
// THE CUTOFF. The count was taken across Friday 28 August, mixed in with the
// day's work, so no exact moment exists (owner, 31/08). The start of that Friday
// is used: it is the conservative end: it may carry a Friday movement forward
// that the counter had already seen, which keeps a real sale that would
// otherwise be erased. Erring the other way deletes sales. Products that moved
// on the Friday itself are flagged so the choice can be revisited.
const COUNT_CUTOFF_SYDNEY = '2026-08-28 00:00:00';

function proposedFor(row, balanceAtCutoff, currentStock) {
  const movedSince = currentStock - balanceAtCutoff;
  return row.counted * LITRE + movedSince;
}

module.exports = { LITRE, COUNT_CUTOFF_SYDNEY, norm, num, parseSheet, buildMatcher, proposedFor };
