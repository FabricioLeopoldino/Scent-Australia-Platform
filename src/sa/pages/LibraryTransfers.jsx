import { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import { useToast } from '../components/Toast';
import { GlowingEffect } from '../components/GlowingEffect';
import RegisterFragranceModal from '../components/RegisterFragranceModal';
import { SECTORS, MUSE_STOCKS, sectorLabel } from '../../../shared/sectors.js';
import { REMOVE_REASONS } from '../../../shared/stock-reasons.js';
import { displayStock } from '../utils/unitConversion';

// The Fragrance Library's Transfers page (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.4):
//   Transfer — any stock to any stock but the main store; the total does not change
//   Count    — oil a MUSE stock holds that the system did not know; the total goes up
//              (SA counts on its own Stock page)
//   Use      — a MUSE use entered by hand, always with its order number (S9); the
//              total goes down, taken from the stock, then MUSE (shared), then SA (S4)
// and the recent movements. Everyone with access sees the balances and the list
// (R4); only admin and root move oil (S10) — the server checks it as well.
// A company stock may go negative (shown in red, never blocked, R5); the main
// store may not (D2), and receives only from a purchase order.
const KINDS = [
  { key: 'transfer', label: 'Transfer' },
  { key: 'count', label: 'Count' },
  { key: 'use', label: 'Use' },
];
const MUSE_OPTIONS = SECTORS.filter((s) => MUSE_STOCKS.includes(s.key));
const KIND_LABEL = { receipt: 'Receipt', transfer: 'Transfer', count: 'Count', use: 'Use', production: 'Production', reversal: 'Reversal' };
const oilLabel = (p) => `${p.name} — ${p.productCode}`;

export default function LibraryTransfers({ user }) {
  const showToast = useToast();
  const search = useSearch();
  const isAdmin = ['admin', 'root'].includes(user.role);
  const showCost = user.role !== 'technician'; // S10, as the Shopify POs page

  const [oils, setOils] = useState(null);
  const [oilId, setOilId] = useState(() => new URLSearchParams(search).get('oil') || '');
  const [oilText, setOilText] = useState('');
  const [movements, setMovements] = useState(null);

  const [kind, setKind] = useState('transfer');
  const [from, setFrom] = useState('SA');
  const [to, setTo] = useState('MUSE');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('production');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);     // { error, code, company }
  const [registerFor, setRegisterFor] = useState(null); // company

  const oil = oils?.find((p) => p.id === oilId) || null;
  const isMl = (oil?.unit || 'mL') === 'mL';
  const unitWord = isMl ? 'L' : oil?.unit;
  const toUnit = (v) => (isMl ? Math.round(parseFloat(v) * 1000 * 1000) / 1000 : parseFloat(v));
  const bal = (k) => oil?.sectors?.[k] || 0;

  useEffect(() => {
    fetch('/api/products?category=OILS')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setOils(Array.isArray(d) ? d : []))
      .catch(() => setOils([]));
  }, []);

  // The picked oil's text and a sensible start: out of the main store when it
  // holds some (oil waiting for its split), else out of SA.
  useEffect(() => {
    if (!oil) return;
    setOilText(oilLabel(oil));
    if (kind === 'transfer') changeFrom((oil.sectors?.MAIN || 0) > 0 ? 'MAIN' : 'SA');
  }, [oil?.id]);

  const loadMovements = () => {
    setMovements(null);
    fetch(oilId ? `/api/sectors/${encodeURIComponent(oilId)}/movements?limit=50` : '/api/sectors/movements?limit=50')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setMovements(Array.isArray(d) ? d : []))
      .catch(() => setMovements([]));
  };
  useEffect(loadMovements, [oilId]);

  const pickOil = (text) => {
    setOilText(text);
    const found = (oils || []).find((p) => oilLabel(p) === text);
    setOilId(found ? found.id : '');
    setRefused(null);
  };

  const fromOptions = kind === 'use' ? MUSE_OPTIONS : SECTORS;
  // Never INTO the main store (D2); a count goes into a MUSE stock only.
  const toOptions = kind === 'count' ? MUSE_OPTIONS : SECTORS.filter((s) => s.key !== 'MAIN' && s.key !== from);

  // Every kind leaves From and To valid for it — a Count's To or a Use's From
  // carried back into a Transfer could otherwise make From = To (fix round 1, S2).
  const firstTo = (f) => SECTORS.find((s) => s.key !== 'MAIN' && s.key !== f).key;
  const changeKind = (k) => {
    setKind(k);
    setRefused(null);
    const nextFrom = k === 'use' && !MUSE_STOCKS.includes(from) ? 'MUSE' : from;
    if (nextFrom !== from) setFrom(nextFrom);
    if (k === 'count' && !MUSE_STOCKS.includes(to)) setTo('MUSE');
    if (k === 'transfer' && (to === nextFrom || to === 'MAIN')) setTo(firstTo(nextFrom));
  };
  const changeFrom = (v) => {
    setFrom(v);
    if (kind === 'transfer' && to === v) setTo(firstTo(v));
  };

  const qtyN = parseFloat(qty) || 0;
  const overMain = kind === 'transfer' && from === 'MAIN' && qtyN > 0 && toUnit(qtyN) > bal('MAIN') + 0.001;
  const overFrom = kind !== 'count' && from !== 'MAIN' && qtyN > 0 && toUnit(qtyN) > Math.max(0, bal(from)) + 0.001;

  const submit = async (e) => {
    e.preventDefault();
    if (!oil) return showToast('Choose the oil first', 'warning');
    if (!(qtyN > 0)) return showToast('Enter a quantity', 'warning');
    if (overMain) return;
    setBusy(true);
    setRefused(null);
    try {
      const line = { quantity: toUnit(qtyN) };
      if (kind !== 'count') line.from = from;
      if (kind !== 'use') line.to = to;
      if (kind === 'use') line.reason = reason;
      const res = await fetch('/api/sectors/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: oil.id, kind, reference, notes, lines: [line] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefused({ error: data.error || 'Could not move the oil', code: data.code, company: data.company });
        return;
      }
      showToast('Saved', 'success');
      // The oil's new balances from the server's reply, at once.
      if (data.sectors) {
        setOils((prev) => prev.map((p) => (p.id === oil.id
          ? { ...p, currentStock: data.total, sectors: data.sectors, saStock: data.sectors.SA } : p)));
      }
      setQty('');
      setReference('');
      setNotes('');
      loadMovements();
    } catch (err) {
      showToast('Could not move the oil: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const select = (value, onChange, options) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
    </select>
  );

  const costText = (m) => {
    if (m.costPerUnit == null) return <span style={{ color: '#fbbf24' }}>{m.kind === 'receipt' ? 'No price on the PO' : 'Unpriced'}</span>;
    return `$${(m.costPerUnit * (m.unit === 'mL' ? 1000 : 1)).toFixed(2)}/${m.unit === 'mL' ? 'L' : m.unit}`;
  };

  return (
    <div className="container" style={{ paddingTop: 28 }}>
      <div className="page-header">
        <h2 className="page-title">Transfers</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 13 }}>
          Move oil between the main store, SA and MUSE; count oil MUSE holds; enter a MUSE use with its order number.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 20, position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div className="form-group" style={{ marginBottom: oil ? 14 : 0 }}>
          <label>Oil</label>
          <input className="input" list="library-oils" value={oilText} onChange={(e) => pickOil(e.target.value)}
            placeholder={oils === null ? 'Loading oils…' : 'Type the oil name or code'} />
          <datalist id="library-oils">
            {(oils || []).filter((p) => (p.status || 'active') === 'active').map((p) => <option key={p.id} value={oilLabel(p)} />)}
          </datalist>
        </div>

        {oil && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
            <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Total</div>
              <div style={{ fontWeight: 800, color: oil.currentStock < 0 ? '#f87171' : 'var(--text-primary)' }}>{displayStock(oil.currentStock, oil.unit)}</div>
            </div>
            {SECTORS.map((s) => (
              <div key={s.key} style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.label}</div>
                <div style={{ fontWeight: 700, color: bal(s.key) < 0 ? '#f87171' : s.key === 'MAIN' && bal(s.key) > 0 ? '#38bdf8' : 'var(--text-primary)' }}>
                  {displayStock(bal(s.key), oil.unit)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="card" style={{ marginBottom: 20, position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {KINDS.map((k) => (
              <button key={k.key} type="button" onClick={() => changeKind(k.key)}
                className={kind === k.key ? 'btn btn-primary' : 'btn btn-secondary'} style={{ padding: '6px 14px' }}>
                {k.label}
              </button>
            ))}
          </div>

          <form onSubmit={submit}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {kind !== 'count' && <div className="form-group"><label>From</label>{select(from, changeFrom, fromOptions)}</div>}
              {kind !== 'use' && <div className="form-group"><label>To</label>{select(to, setTo, toOptions)}</div>}
              <div className="form-group">
                <label>Quantity ({unitWord}) *</label>
                <input className="input" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required />
              </div>
              {kind === 'use' && (
                <div className="form-group">
                  <label>Why</label>
                  <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REMOVE_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label>{kind === 'use' ? 'Order number *' : 'Reference (PO or order number)'}</label>
                <input className="input" value={reference} onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. #38637" required={kind === 'use'} />
              </div>
              <div className="form-group">
                <label>Notes{kind === 'use' && reason === 'other' ? ' *' : ''}</label>
                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} required={kind === 'use' && reason === 'other'} />
              </div>
            </div>

            {oil && overMain && (
              <div style={{ color: '#f87171', fontSize: 12, fontWeight: 700, marginBottom: 10 }}>
                The main store holds only {displayStock(bal('MAIN'), oil.unit)} — it never goes below zero.
              </div>
            )}
            {oil && overFrom && (
              <div style={{ color: '#fbbf24', fontSize: 12, marginBottom: 10 }}>
                More than {sectorLabel(from)} holds ({displayStock(bal(from), oil.unit)}).
                {kind === 'use' ? ' The rest is taken as the rule below says.' : ' It will show as negative.'}
              </div>
            )}
            {kind === 'count' && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 }}>
                Oil a MUSE stock holds that the system did not know — the total goes up. SA counts on its own Stock page.
              </div>
            )}
            {kind === 'use' && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 }}>
                {from === 'MUSE'
                  ? 'Takes from MUSE (shared) first, then SA.'
                  : `Takes from ${sectorLabel(from)} first, then MUSE (shared), then SA.`}
              </div>
            )}

            {refused && (
              <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span>{refused.error}</span>
                {refused.code === 'NOT_REGISTERED' && oil && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => setRegisterFor(refused.company || 'MUSE')}>
                    Register now
                  </button>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={busy || !oil || overMain}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>
          {oil ? `Movements — ${oil.name}` : 'Recent movements, every oil'}
        </h3>
        {movements === null ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Loading…</div>
        ) : movements.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {oil ? "No movements yet — all of this oil is SA's." : 'No movements yet.'}
          </div>
        ) : (
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>When</th><th>Who</th>{!oil && <th>Oil</th>}<th>Kind</th><th>From → To</th><th>Qty</th><th>Ref</th>
                  {showCost && <th>Cost (ex GST)</th>}
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.createdAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>{m.user || '—'}</td>
                    {!oil && <td>{m.productName}<div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{m.productCode}</div></td>}
                    <td>{KIND_LABEL[m.kind] || m.kind}</td>
                    <td>{sectorLabel(m.from)}{m.usedFor && ` (for ${sectorLabel(m.usedFor)})`} → {sectorLabel(m.to)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{displayStock(m.quantity, m.unit)}</td>
                    <td>{m.reference || '—'}</td>
                    {showCost && <td style={{ whiteSpace: 'nowrap' }}>{costText(m)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* At the page's top level, outside the cards (backdrop-filter traps a fixed window). */}
      {registerFor && oil && (
        <RegisterFragranceModal
          product={oil}
          company={registerFor}
          fromRefusal
          showToast={showToast}
          onClose={() => setRegisterFor(null)}
          onDone={(regs, active) => {
            setOils((prev) => prev.map((p) => (p.id === oil.id ? { ...p, registrations: regs } : p)));
            setRegisterFor(null);
            // Only an active registration lifts the refusal (S3).
            if (active) { setRefused(null); showToast('Registered — press Save again', 'info'); }
          }}
        />
      )}
    </div>
  );
}
