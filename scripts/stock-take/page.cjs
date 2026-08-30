// The stock-take report as a page. Kept apart from report.cjs so the numbers
// and the presentation can be read, and changed, without wading through each
// other.
//
// DESIGN NOTES, so a later change does not undo the reasoning:
//
//   Palette. A cool paper rather than the warm cream everything defaults to,
//   because this is a reconciliation and it should feel measured, not cosy. One
//   accent only — amber, the colour of the oil itself — and it is spent entirely
//   on the caution state, where it means something. Found and missing are
//   green and red because those are the reader's existing associations for a
//   count, and they are semantic, not decoration.
//
//   Type. Fraunces for the title, IBM Plex Sans for reading and IBM Plex Mono
//   for every figure and product code. A warm serif over an engineered table is
//   the document itself: a craft product, counted by an industrial process.
//   Tabular numerals throughout, because a column of litres that does not line
//   up cannot be scanned.
//
//   Layout. The four totals answer "what did it find" before any detail. Then
//   the caveats, because a reader who acts on the table without them will act
//   wrongly. Then one dense table, searchable, since the common use is looking
//   up a single fragrance rather than reading 168 rows.
const esc = (s) => String(s ?? '')
  .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');

function page({ rows, held, negatives, totals, meta, L }) {
  const tr = (r) => `<tr data-state="${r.held ? 'held' : r.after < 0 ? 'neg' : r.change ? 'moved' : 'same'}"
      data-find="${esc((r.code + ' ' + r.name + ' ' + r.supplier).toLowerCase())}">
    <td class="code">${esc(r.code)}</td>
    <td class="nm">${esc(r.name)}</td>
    <td class="n was">${L(r.before)}</td>
    <td class="n count">${L(r.counted)}</td>
    <td class="n now">${L(r.after)}</td>
    <td class="n ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : 'flat'}">${
      r.change ? (r.change > 0 ? '+' : '') + L(r.change) : '·'}</td>
    <td class="n tech">${r.techCleared ? L(r.techCleared) : ''}</td>
    <td class="tag">${r.held ? '<span class="pill hold">held</span>'
      : r.after < 0 ? '<span class="pill below">below zero</span>'
      : r.change ? '' : '<span class="pill ok">agreed</span>'}</td></tr>`;

  return `<title>Fragrance Stock Take</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root{
    --paper:#f3f4f6; --card:#ffffff; --ink:#16181d; --ink-2:#5b6068; --line:#dfe2e7;
    --amber:#8a5a00; --amber-bg:#fbf1dc; --amber-line:#d9a94a;
    --found:#0f6b45; --found-bg:#e3f2ea;
    --missing:#a52218; --missing-bg:#fbe7e5;
    --shadow:0 1px 2px rgba(20,24,32,.05);
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --paper:#111318; --card:#181b21; --ink:#e8eaee; --ink-2:#969ba5; --line:#282c34;
    --amber:#e0b75f; --amber-bg:#241d0d; --amber-line:#6d5520;
    --found:#5cc894; --found-bg:#0e2a1f;
    --missing:#ef8b81; --missing-bg:#2c1512;
    --shadow:0 1px 2px rgba(0,0,0,.4);
  }}
  :root[data-theme="dark"]{
    --paper:#111318; --card:#181b21; --ink:#e8eaee; --ink-2:#969ba5; --line:#282c34;
    --amber:#e0b75f; --amber-bg:#241d0d; --amber-line:#6d5520;
    --found:#5cc894; --found-bg:#0e2a1f;
    --missing:#ef8b81; --missing-bg:#2c1512;
    --shadow:0 1px 2px rgba(0,0,0,.4);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
       font:16px/1.65 "IBM Plex Sans",ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:1140px;margin:0 auto;padding:56px 24px 100px;display:flex;flex-direction:column;gap:0}
  .eyebrow{font:500 12px/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.16em;
           text-transform:uppercase;color:var(--ink-2);margin:0 0 14px}
  h1{font:600 clamp(32px,5vw,46px)/1.08 Fraunces,Georgia,serif;letter-spacing:-.02em;
     margin:0 0 10px;text-wrap:balance}
  .lede{color:var(--ink-2);margin:0 0 40px;font-size:17px;max-width:62ch}
  h2{font:600 21px/1.3 Fraunces,Georgia,serif;letter-spacing:-.01em;margin:52px 0 4px}
  .h2sub{color:var(--ink-2);font-size:14px;margin:0 0 18px}

  .totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
  .t{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;
     box-shadow:var(--shadow)}
  .t .v{font:600 30px/1.1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:-.03em;
        font-variant-numeric:tabular-nums}
  .t .k{color:var(--ink-2);font-size:13.5px;margin-top:7px;line-height:1.45}
  .found{color:var(--found)} .missing{color:var(--missing)}

  .notes{display:flex;flex-direction:column;gap:12px;margin-top:28px}
  .note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);
        border-radius:8px;padding:16px 20px;font-size:15px;line-height:1.6}
  .note.caution{background:var(--amber-bg);border-left-color:var(--amber-line)}
  .note b{font-weight:600}
  .note.caution b{color:var(--amber)}

  .tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
  input[type=search]{flex:1;min-width:200px;background:var(--card);color:var(--ink);
    border:1px solid var(--line);border-radius:8px;padding:9px 13px;font:400 14px/1.4 inherit}
  input[type=search]:focus-visible,button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
  button{background:var(--card);color:var(--ink-2);border:1px solid var(--line);border-radius:8px;
    padding:9px 15px;font:500 13px/1.4 inherit;cursor:pointer;
    transition:color .15s,border-color .15s,background .15s}
  button:hover{color:var(--ink);border-color:var(--ink-2)}
  button[aria-pressed=true]{color:var(--ink);border-color:var(--ink);background:var(--paper)}

  .scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);
          border-radius:10px;box-shadow:var(--shadow)}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th{position:sticky;top:0;z-index:1;background:var(--card);border-bottom:1px solid var(--line);
     font:600 11px/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.12em;
     text-transform:uppercase;color:var(--ink-2);padding:13px 14px;text-align:left;white-space:nowrap}
  th.r{text-align:right}
  td{padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
  tbody tr:last-child td{border-bottom:0}
  td.n{text-align:right;font-family:"IBM Plex Mono",ui-monospace,monospace;
       font-variant-numeric:tabular-nums;font-size:13px}
  td.code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px;color:var(--ink-2)}
  td.nm{white-space:normal;min-width:210px}
  td.was,td.tech{color:var(--ink-2)}
  td.count{font-weight:600}
  td.up{color:var(--found)} td.down{color:var(--missing)} td.flat{color:var(--ink-2)}
  .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:500;
        border:1px solid transparent}
  .pill.hold{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-line)}
  .pill.below{background:var(--missing-bg);color:var(--missing)}
  .pill.ok{background:transparent;color:var(--ink-2);border-color:var(--line)}
  tr[data-state=held] td{background:color-mix(in srgb,var(--amber-bg) 60%,transparent)}
  tr[data-state=neg] td{background:color-mix(in srgb,var(--missing-bg) 55%,transparent)}
  tr.hidden{display:none}
  .empty{padding:26px;text-align:center;color:var(--ink-2);font-size:14px}

  footer{margin-top:56px;padding-top:22px;border-top:1px solid var(--line);
         color:var(--ink-2);font-size:13.5px;line-height:1.7;max-width:70ch}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>

<div class="wrap">
  <p class="eyebrow">Scent Australia · Fragrance Library</p>
  <h1>Fragrance Stock Take</h1>
  <p class="lede">Counted ${meta.countDate}, applied ${meta.appliedDate}. Every one of the
    ${rows.length} fragrances on the sheet, what the system held, what was found on the shelf,
    and where it stands now.</p>

  <div class="totals">
    <div class="t"><div class="v found">+${L(totals.up)}</div>
      <div class="k">litres found that the system did not have</div></div>
    <div class="t"><div class="v missing">${L(totals.down)}</div>
      <div class="k">litres the system held and the shelf did not</div></div>
    <div class="t"><div class="v missing">−${L(totals.tech)}</div>
      <div class="k">litres of technician stock, retired into the count</div></div>
    <div class="t"><div class="v">${L(totals.up + totals.down - totals.tech)}</div>
      <div class="k">net change to the library</div></div>
  </div>

  <div class="notes">
    <div class="note"><b>The count is the truth as at the day it was taken.</b>
      Between the Friday count and the Monday it went in there were real sales and production,
      so each figure is the counted amount carried forward by whatever moved after the count.
      Writing the counted number straight in would have erased those movements.</div>

    ${held.length ? `<div class="note caution"><b>${held.length} held back and not adjusted.</b>
      The warehouse contradicted the sheet for these: Milagrito has around 180&nbsp;kg in the
      coldroom that the count does not appear to include, and Myrrh &amp; Tonka was reported
      correct in the system. Both keep their existing figures, and their technician stock,
      until somebody recounts them.</div>` : ''}

    ${negatives.length ? `<div class="note caution"><b>${negatives.length} sit below zero.</b>
      More was consumed after the count than the count found. No figure has been invented to
      tidy them away — either the count is wrong or the consumption is:
      ${negatives.map((n) => esc(n.name)).join(', ')}.</div>` : ''}
  </div>

  <h2>Every fragrance</h2>
  <p class="h2sub">Litres. “Was” is the balance before the adjustment, “Tech” the separate
    technician balance folded into the count.</p>

  <div class="tools">
    <input type="search" id="find" placeholder="Find a fragrance, code or supplier code"
           aria-label="Find a fragrance">
    <button type="button" data-filter="all" aria-pressed="true">All ${rows.length}</button>
    <button type="button" data-filter="moved" aria-pressed="false">Changed</button>
    <button type="button" data-filter="attention" aria-pressed="false">Needs a person</button>
  </div>

  <div class="scroll"><table>
    <thead><tr>
      <th>Code</th><th>Fragrance</th><th class="r">Was</th><th class="r">Counted</th>
      <th class="r">Now</th><th class="r">Change</th><th class="r">Tech</th><th></th>
    </tr></thead>
    <tbody id="rows">${rows.map(tr).join('')}</tbody>
  </table>
  <div class="empty" id="none" style="display:none">Nothing matches that.</div></div>

  <footer>
    Read from the platform ledger rather than from the count sheet, so it records what happened
    and not what was planned. Every line here has a matching entry in the fragrance history,
    naming the counted figure and the balance before and after.
  </footer>
</div>

<script>
  const rows = [...document.querySelectorAll('#rows tr')];
  const find = document.getElementById('find');
  const none = document.getElementById('none');
  const buttons = [...document.querySelectorAll('[data-filter]')];
  let mode = 'all';

  function apply() {
    const q = find.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const state = r.dataset.state;
      const passMode = mode === 'all'
        || (mode === 'moved' && (state === 'moved' || state === 'neg'))
        || (mode === 'attention' && (state === 'held' || state === 'neg'));
      const passText = !q || r.dataset.find.includes(q);
      const show = passMode && passText;
      r.classList.toggle('hidden', !show);
      if (show) shown++;
    }
    none.style.display = shown ? 'none' : '';
  }
  find.addEventListener('input', apply);
  for (const b of buttons) {
    b.addEventListener('click', () => {
      mode = b.dataset.filter;
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      apply();
    });
  }
</script>`;
}

module.exports = { page };
