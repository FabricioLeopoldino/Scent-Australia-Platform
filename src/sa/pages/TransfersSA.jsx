import { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';

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
    setSending(true);
    try {
      const res = await fetch('/api/platform/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_link_id: parseInt(linkId), quantity_ml: parseFloat(qty), notes }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(`Transfer sent — ${qty} mL now in transit to Scented Merchandise`, 'success');
        setQty(''); setNotes(''); setLinkId('');
        loadAll();
        setTab('history');
      } else {
        showToast(data.error || 'Transfer failed', 'error');
      }
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
    setLinking(true);
    try {
      const res = await fetch('/api/platform/product-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sa_product_id: saId, sm_product_id: parseInt(smId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { showToast('Products linked', 'success'); setSaPick(''); setSmPick(''); loadAll(); loadPickers(searchQ); }
      else showToast(data.error || 'Link failed', 'error');
    } catch {
      showToast('Connection error — link not saved, please try again', 'error');
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
    </div>
  );
}
