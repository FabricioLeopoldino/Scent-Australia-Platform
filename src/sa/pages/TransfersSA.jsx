import { useEffect, useState } from 'react';
import { Package, FlaskConical, CheckCircle2, XCircle, Link2 } from 'lucide-react';
import { useToast } from '../components/Toast';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Transfer/Link status modal — adapted from the "file transfer card" pattern
// the owner picked (21st.dev), rebuilt on the SA design system. Our operations
// are atomic, so instead of a fake progress bar it shows: SA → SM devices with
// pulsing dots while the request runs, then a rich confirmation (or error).
function TransferStatusModal({ state, mlLabel, onClose, onViewHistory }) {
  if (!state) return null;
  const { phase, mode, sa, sm, qty, balanceAfter, error } = state;
  const sending = phase === 'sending';
  const isLink = mode === 'link';

  const Side = ({ icon: Icon, label, name, code, accent }) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${accent}18`, color: accent }}>
        <Icon size={26} />
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <p style={{ fontSize: 13, fontWeight: 700, textAlign: 'center', margin: 0, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>{name}</p>
      {code && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{code}</span>}
    </div>
  );

  return (
    <div className="modal-overlay" style={{ zIndex: 9999 }}>
      <div className="modal" style={{ maxWidth: 440, padding: 0 }}>
        <div style={{ padding: '26px 28px 22px' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, textAlign: 'center', marginBottom: 22 }}>
            {sending
              ? (isLink ? 'Linking products...' : 'Sending transfer...')
              : phase === 'done'
                ? (isLink ? 'Products linked' : 'Transfer in transit')
                : (isLink ? 'Link failed' : 'Transfer failed')}
          </h2>

          {/* Devices row (reference layout: source · animated dots · destination) */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 22 }}>
            <Side icon={Package} label="Scent Stock Manager" name={sa.name} code={sa.code} accent="#2563eb" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingTop: 20 }}>
              {sending ? (
                <>
                  <span className="xfer-dot" style={{ animationDelay: '-0.3s' }} />
                  <span className="xfer-dot" style={{ animationDelay: '-0.15s' }} />
                  <span className="xfer-dot" />
                </>
              ) : phase === 'done' ? (
                <span className="xfer-pop" style={{ color: '#4ade80', display: 'flex' }}>
                  {isLink ? <Link2 size={22} /> : <CheckCircle2 size={22} />}
                </span>
              ) : (
                <span style={{ color: '#f87171', display: 'flex' }}><XCircle size={22} /></span>
              )}
            </div>
            <Side icon={FlaskConical} label="Scented Merchandise" name={sm.name} code={sm.code} accent="#b1545a" />
          </div>

          {/* Details card (reference "Transfer Details") */}
          {phase === 'done' && (
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', fontSize: 13 }}>
              {!isLink && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Quantity sent</span>
                    <span style={{ fontWeight: 700 }}>{mlLabel(qty)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>SA stock after</span>
                    <span style={{ fontWeight: 700 }}>{balanceAfter != null ? mlLabel(balanceAfter) : '—'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Status</span>
                    <span style={{ color: '#fbbf24', fontWeight: 700 }}>🚚 In transit</span>
                  </div>
                </>
              )}
              {isLink && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Link</span>
                  <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 12 }}>{sa.code} ⇄ {sm.code}</span>
                </div>
              )}
            </div>
          )}
          {phase === 'error' && (
            <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#f87171', textAlign: 'center' }}>
              {error}
            </div>
          )}
          {phase === 'done' && !isLink && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 12, marginBottom: 0 }}>
              Scented Merchandise must confirm receipt in <strong>Incoming Transfers</strong>.
            </p>
          )}

          {/* Actions */}
          {!sending && (
            <div style={{ display: 'grid', gridTemplateColumns: phase === 'done' && !isLink ? '1fr 1fr' : '1fr', gap: 10, marginTop: 18 }}>
              {phase === 'done' && !isLink && (
                <button className="btn" onClick={onViewHistory}>View History</button>
              )}
              <button className="btn btn-primary" onClick={onClose}>
                {phase === 'error' ? 'Close' : 'Done'}
              </button>
            </div>
          )}
          {sending && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4, marginBottom: 0 }}>
              {isLink ? 'Saving link…' : 'Debiting SA stock and creating the transfer…'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Cross-system transfers — SA side (PRD FR-XFER-6):
// send fragrances to Scented Merchandise, manage product links, history.
// Platform endpoints (/api/platform/*) — the module interceptor leaves them untouched.
export default function TransfersSA({ user }) {
  const { showToast } = useToast();
  const [tab, setTab] = useState('new');
  const [links, setLinks] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [saProducts, setSaProducts] = useState([]);

  // new transfer form
  const [linkId, setLinkId] = useState('');
  const [qty, setQty] = useState('');
  const [notes, setNotes] = useState('');
  const [sending, setSending] = useState(false);

  // link form
  const [pickers, setPickers] = useState({ sa_products: [], sm_products: [], suggestions: [] });
  const [searchQ, setSearchQ] = useState('');
  const [saPick, setSaPick] = useState('');
  const [smPick, setSmPick] = useState('');
  const [linking, setLinking] = useState(false);
  const [statusModal, setStatusModal] = useState(null); // TransferStatusModal state

  const isAdmin = ['root', 'admin'].includes(user?.role);

  async function loadAll() {
    const [l, t, p] = await Promise.all([
      fetch('/api/platform/product-links').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/platform/transfers').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/products').then((r) => (r.ok ? r.json() : [])),
    ]);
    setLinks(Array.isArray(l) ? l : []);
    setTransfers(Array.isArray(t) ? t : []);
    setSaProducts(Array.isArray(p) ? p : []);
  }

  useEffect(() => { loadAll(); }, []);

  async function loadPickers(q = '') {
    const r = await fetch(`/api/platform/product-links/suggest?q=${encodeURIComponent(q)}`);
    if (r.ok) setPickers(await r.json());
  }

  useEffect(() => { if (tab === 'links') loadPickers(searchQ); }, [tab]);

  const stockOf = (saId) => {
    const p = saProducts.find((x) => x.id === saId);
    return p ? parseFloat(p.currentStock) : null;
  };

  async function sendTransfer(e) {
    e.preventDefault();
    const link = links.find((l) => l.id === parseInt(linkId));
    if (!link) return;
    setSending(true);
    setStatusModal({
      phase: 'sending', mode: 'transfer',
      sa: { name: link.sa_name, code: link.sa_code },
      sm: { name: link.sm_name, code: link.sm_code },
      qty: parseFloat(qty),
    });
    try {
      // min 900ms so the sending animation reads as a deliberate step
      const [res] = await Promise.all([
        fetch('/api/platform/transfers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_link_id: parseInt(linkId), quantity_ml: parseFloat(qty), notes }),
        }),
        delay(900),
      ]);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatusModal((prev) => ({ ...prev, phase: 'done', balanceAfter: data.sa_balance_after }));
        setQty(''); setNotes(''); setLinkId('');
        loadAll();
      } else {
        setStatusModal((prev) => ({ ...prev, phase: 'error', error: data.error || 'Transfer failed' }));
      }
    } catch {
      setStatusModal((prev) => ({ ...prev, phase: 'error', error: 'Connection error — the transfer was not sent. Please try again.' }));
    } finally {
      setSending(false);
    }
  }

  async function cancelTransfer(t) {
    const res = await fetch(`/api/platform/transfers/${t.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Cancelled from SA' }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { showToast('Transfer cancelled — stock returned', 'success'); loadAll(); }
    else showToast(data.error || 'Cancel failed', 'error');
  }

  async function createLink(saId, smId) {
    const saP = pickers.sa_products.find((p) => p.id === saId) ||
      pickers.suggestions.map((s) => s.sa).find((p) => p.id === saId) || { name: 'SA oil', code: '' };
    const smP = pickers.sm_products.find((p) => p.id === parseInt(smId)) ||
      pickers.suggestions.map((s) => s.sm).find((p) => p.id === parseInt(smId)) || { name: 'SM fragrance', code: '' };
    setLinking(true);
    setStatusModal({
      phase: 'sending', mode: 'link',
      sa: { name: saP.name, code: saP.code },
      sm: { name: smP.name, code: smP.code },
    });
    try {
      const [res] = await Promise.all([
        fetch('/api/platform/product-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sa_product_id: saId, sm_product_id: parseInt(smId) }),
        }),
        delay(700),
      ]);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatusModal((prev) => ({ ...prev, phase: 'done' }));
        setSaPick(''); setSmPick(''); loadAll(); loadPickers(searchQ);
      } else {
        setStatusModal((prev) => ({ ...prev, phase: 'error', error: data.error || 'Link failed' }));
      }
    } catch {
      setStatusModal((prev) => ({ ...prev, phase: 'error', error: 'Connection error — link not saved, please try again' }));
    } finally {
      setLinking(false);
    }
  }

  async function deleteLink(id) {
    try {
      const res = await fetch(`/api/platform/product-links/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { showToast('Link removed', 'success'); loadAll(); }
      else showToast(data.error || 'Remove failed', 'error');
    } catch {
      showToast('Connection error — please try again', 'error');
    }
  }

  const STATUS_COLORS = { in_transit: '#fbbf24', received: '#4ade80', cancelled: '#f87171' };
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const mlLabel = (v) => `${(parseFloat(v) / 1000).toFixed(parseFloat(v) % 1000 === 0 ? 0 : 2)} L`;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22 }}>Transfers → Scented Merchandise</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {['new', 'history', ...(isAdmin ? ['links'] : [])].map((t) => (
            <button
              key={t}
              className={`btn ${tab === t ? 'btn-primary' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'new' ? '↗ New Transfer' : t === 'history' ? 'History' : 'Product Links'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'new' && (
        <div className="card" style={{ maxWidth: 520 }}>
          <h3 style={{ fontSize: 15, marginBottom: 16 }}>Send fragrance to Scented Merchandise</h3>
          {links.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              No product links yet. {isAdmin ? 'Create one in the Product Links tab first.' : 'Ask an administrator to link products first.'}
            </p>
          ) : (
            <form onSubmit={sendTransfer}>
              <div className="form-group">
                <label>Fragrance (linked)</label>
                <select className="input" value={linkId} onChange={(e) => setLinkId(e.target.value)} required>
                  <option value="">Select fragrance...</option>
                  {links.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.sa_name} ({l.sa_code}) → {l.sm_name}
                      {stockOf(l.sa_product_id) !== null ? ` — ${mlLabel(stockOf(l.sa_product_id))} available` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Quantity (mL)</label>
                <input className="input" type="number" min="1" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} required />
                {qty > 0 && <div style={{ fontSize: 12, color: '#4ade80', marginTop: 4 }}>= {mlLabel(qty)}</div>}
              </div>
              <div className="form-group">
                <label>Notes (optional)</label>
                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. batch reference" />
              </div>
              <button className="btn btn-primary" disabled={sending || !isAdmin} style={{ width: '100%' }}>
                {sending ? 'Sending...' : '↗ Send Transfer'}
              </button>
              {!isAdmin && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Only admin/root can send transfers.</p>}
            </form>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Sent</th><th>Fragrance</th><th>Qty</th><th>Status</th><th>By</th><th>Received</th><th></th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>No transfers yet</td></tr>
              )}
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.sent_at)}</td>
                  <td>{t.sa_name || t.sa_product_id}<div style={{ fontSize: 11, color: 'var(--text-muted)' }}>→ {t.sm_name}</div></td>
                  <td>
                    {mlLabel(t.quantity_ml)}
                    {t.status === 'received' && parseFloat(t.received_qty_ml) < parseFloat(t.quantity_ml) && (
                      <div style={{ fontSize: 11, color: '#fbbf24' }}>received {mlLabel(t.received_qty_ml)}</div>
                    )}
                  </td>
                  <td>
                    <span style={{ color: STATUS_COLORS[t.status] || 'inherit', fontWeight: 700, fontSize: 12 }}>
                      {t.status === 'in_transit' ? '🚚 In transit' : t.status === 'received' ? '✓ Received' : '✕ Cancelled'}
                    </span>
                  </td>
                  <td>{t.sent_by_name || '—'}</td>
                  <td>{t.status === 'received' ? `${t.received_by_name || ''} ${fmtDate(t.received_at)}` : '—'}</td>
                  <td>
                    {t.status === 'in_transit' && isAdmin && (
                      <button className="btn" style={{ fontSize: 11, color: '#f87171' }} onClick={() => cancelTransfer(t)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'links' && isAdmin && (
        <div style={{ display: 'grid', gap: 20, maxWidth: 760 }}>
          <div className="card">
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Link a fragrance (SA oil ↔ SM fragrance)</h3>
            <div className="form-group">
              <label>Search</label>
              <input
                className="input"
                value={searchQ}
                onChange={(e) => { setSearchQ(e.target.value); loadPickers(e.target.value); }}
                placeholder="Filter by name or code..."
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>SA fragrance oil</label>
                <select className="input" value={saPick} onChange={(e) => setSaPick(e.target.value)}>
                  <option value="">Select...</option>
                  {pickers.sa_products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>SM fragrance</label>
                <select className="input" value={smPick} onChange={(e) => setSmPick(e.target.value)}>
                  <option value="">Select...</option>
                  {pickers.sm_products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" disabled={!saPick || !smPick || linking} onClick={() => createLink(saPick, smPick)}>
                {linking ? 'Linking...' : 'Link'}
              </button>
            </div>
            {pickers.sm_products.length === 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
                No matching SM fragrance{searchQ ? ` for "${searchQ}"` : ''}. Create it first in{' '}
                <strong>Scented Merchandise → Stock Management → New Product</strong> (category Fragrance),
                then come back here to link it.
              </div>
            )}
            {pickers.suggestions.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Suggested matches (same name):</div>
                {pickers.suggestions.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', fontSize: 13 }}>
                    <span>{s.sa.name} ↔ {s.sm.name}</span>
                    <button className="btn" style={{ fontSize: 11 }} disabled={linking} onClick={() => createLink(s.sa.id, s.sm.id)}>
                      {linking ? 'Linking...' : 'Link these'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>SA oil</th><th>SM fragrance</th><th></th></tr></thead>
              <tbody>
                {links.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', padding: 18, color: 'var(--text-muted)' }}>No links yet</td></tr>
                )}
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>{l.sa_name} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({l.sa_code})</span></td>
                    <td>{l.sm_name} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({l.sm_code})</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn" style={{ fontSize: 11, color: '#f87171' }} onClick={() => deleteLink(l.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TransferStatusModal
        state={statusModal}
        mlLabel={mlLabel}
        onClose={() => setStatusModal(null)}
        onViewHistory={() => { setStatusModal(null); setTab('history'); }}
      />
    </div>
  );
}
