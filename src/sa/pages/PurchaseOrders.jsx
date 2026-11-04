// Purchase Orders — one place for every order (H4, PRD_H4_PURCHASE_ORDERS.md).
//
// Every new order is raised in Shopify (D3, owner 5 Nov). This page lists them
// against what the platform holds. A clean line is accepted by itself when the
// page or Demand Planning reads Shopify (R7). Lines are received, corrected
// and cancelled here (R4, R5), and an order closes when Shopify has it
// Transferred and every line here is finished (R8).
//
// It replaces SA's "Shopify POs" and the Fragrance Library's "Purchase orders".
// The product pages keep showing what is on order and link here (D2).
import { useState, useEffect, useMemo } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Link2, Search, PackageCheck, Info } from 'lucide-react';
import { useToast } from '../components/Toast';
import { GlowingEffect } from '../components/GlowingEffect';
import ReceiveSplitModal from '../components/ReceiveSplitModal';
import RegisterFragranceModal from '../components/RegisterFragranceModal';
import { PO_DESTINATIONS, sectorLabel } from '../../../shared/sectors.js';
import { displayStock, displayUnit } from '../utils/unitConversion';

const STATUS = {
  waiting: { label: 'Waiting to accept', color: '#fbbf24' },
  on_order: { label: 'On order', color: '#60a5fa' },
  part: { label: 'Part received', color: '#60a5fa' },
  received: { label: 'Received', color: '#34d399' },
  closed: { label: 'Closed', color: '#94a3b8' },
  cancelled: { label: 'Cancelled', color: '#94a3b8' },
  info: { label: 'Not tracked here', color: '#94a3b8' },
};
const ALERT = {
  record_here: { text: 'Received in Shopify — record it here', color: '#f87171', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.4)' },
  finish_in_shopify: { text: 'Received here — finish the transfer in Shopify', color: '#fbbf24', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.4)' },
};
const VIEWS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];
const COMPANIES = [{ key: 'ALL', label: 'All companies' }, ...PO_DESTINATIONS.map((d) => ({ key: d.stock, label: d.label }))];
const inView = (o, view) => (view === 'all' ? true
  : view === 'attention' ? o.attention
  : view === 'closed' ? ['closed', 'cancelled'].includes(o.status)
  : !['closed', 'cancelled', 'info'].includes(o.status));
const when = (d) => (d ? new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const qty = (v, unit) => displayStock(v || 0, unit || 'units');

export default function PurchaseOrders({ user }) {
  const showToast = useToast();
  const isAdmin = ['admin', 'root'].includes(user?.role);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false); // a later read failed: what is shown is from the earlier one
  const params = new URLSearchParams(window.location.search);
  const [q, setQ] = useState(params.get('q') || '');
  const [view, setView] = useState(params.get('q') ? 'all' : 'open');
  const [company, setCompany] = useState('ALL');
  const [origin, setOrigin] = useState('all');
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [correcting, setCorrecting] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [registerFor, setRegisterFor] = useState(null);
  const [history, setHistory] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/purchase-orders/overview');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
      setStale(false);
      if (body.autoAccepted?.length) {
        showToast(`${body.autoAccepted.length} line(s) accepted automatically: ${[...new Set(body.autoAccepted.map((a) => a.number))].join(', ')}`, 'success');
      }
    } catch (e) {
      if (data) setStale(true);
      else setData({ ok: false, error: e.message, orders: [] });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const loadHistory = async (o) => {
    const ids = o.lines.map((l) => l.poId).filter(Boolean);
    if (!ids.length) return;
    try {
      const res = await fetch(`/api/purchase-orders/history?ids=${ids.join(',')}`);
      if (res.ok) {
        const h = await res.json();
        setHistory((prev) => ({ ...prev, ...h }));
      }
    } catch { /* the sheet shows the lines without their history */ }
  };
  const toggle = (o) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(o.key)) n.delete(o.key); else { n.add(o.key); loadHistory(o); }
      return n;
    });
  };
  const refresh = async (o) => { await load(); if (o) loadHistory(o); };

  const accept = async (o) => {
    setBusy(o.key);
    try {
      const res = await fetch('/api/shopify-purchase-orders/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopifyId: o.shopifyId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not accept');
      showToast(`${body.number}: ${body.accepted} line(s) accepted${body.held?.length ? ` · held back: ${body.held.map((h) => h.name || h.sku).join(', ')}` : ''}`,
        body.held?.length ? 'warning' : 'success');
      await refresh(o);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const takeNewFigure = async (o, l) => {
    setBusy(l.poId);
    try {
      const res = await fetch(`/api/shopify-purchase-orders/line/${l.poId}`, { method: 'PATCH' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not update');
      showToast(`Now ${qty(body.to, l.unit)} on order`, 'success');
      await refresh(o);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const orders = data?.orders || [];
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => orders.filter((o) => inView(o, view)
    // An unknown destination is an error to see, so it shows under every company.
    && (company === 'ALL' || !o.destinationStock || o.destinationStock === company)
    && (origin === 'all' || o.origin === origin)
    && (!needle || [o.number, o.supplier, ...o.lines.flatMap((l) => [l.productName, l.productCode, l.sku])]
      .some((s) => String(s || '').toLowerCase().includes(needle)))), [orders, view, company, origin, needle]);
  const count = (v) => orders.filter((o) => inView(o, v)).length;

  return (
    <div className="container" style={{ paddingTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h2 className="page-title" style={{ margin: 0 }}>Purchase Orders</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6, maxWidth: 720, lineHeight: 1.6 }}>
            Every order is raised in Shopify. A clean line is accepted here by itself; receive it, correct a receipt or
            cancel a line below. An order closes when Shopify has it Transferred and everything here is finished.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={() => load()} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={14} /> {loading ? 'Reading…' : 'Read again'}
        </button>
      </div>

      {/* The connection status is a real read, never decoration (P1, D5). */}
      {data && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, marginBottom: 16,
          color: stale ? '#fbbf24' : data.ok ? '#34d399' : '#f87171' }}>
          {data.ok && !stale ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          {stale ? `Could not read again — the list below is from ${when(data.readAt)}`
            : data.ok ? `Shopify connected — read at ${when(data.readAt)}`
            : `Could not read Shopify: ${data.error || 'no answer'}. The orders the platform already holds are shown; nothing new can come in until it answers.`}
          {data.attention > 0 && <span style={{ marginLeft: 10, color: '#fbbf24' }}>· {data.attention} need attention</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
        <div role="group" aria-label="Which orders" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {VIEWS.map((v) => (
            <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => setView(v.key)}
              className={view === v.key ? 'btn btn-primary' : 'btn btn-secondary'} style={{ fontSize: 12.5, padding: '7px 14px' }}>
              {v.label} <span style={{ opacity: 0.7, marginLeft: 4 }}>{count(v.key)}</span>
            </button>
          ))}
        </div>
        <select className="input" aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)} style={{ width: 'auto', fontSize: 12.5 }}>
          {COMPANIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select className="input" aria-label="Origin" value={origin} onChange={(e) => setOrigin(e.target.value)} style={{ width: 'auto', fontSize: 12.5 }}>
          <option value="all">Shopify and typed by hand</option>
          <option value="shopify">Shopify</option>
          <option value="manual">Typed by hand (before H4)</option>
        </select>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 340 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input className="input" aria-label="Search orders" placeholder="PO number, supplier or product" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 30, fontSize: 12.5 }} />
        </div>
      </div>

      {loading && !data && <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>Reading Shopify…</div>}
      {data && shown.length === 0 && (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {view === 'attention' ? 'Nothing needs attention.' : 'No purchase orders here.'}
        </div>
      )}

      {shown.map((o) => (
        <OrderCard key={o.key} o={o} isOpen={open.has(o.key)} onToggle={() => toggle(o)} isAdmin={isAdmin} busy={busy}
          history={history} onAccept={() => accept(o)} onTakeNew={(l) => takeNewFigure(o, l)}
          onReceive={(l) => setReceiving({ o, l })} onCorrect={(l) => setCorrecting({ o, l })}
          onCancel={(l) => setCancelling({ o, l })} onRegister={(l) => setRegisterFor({ o, l })} />
      ))}

      {receiving && (
        <ReceiveSplitModal
          poId={receiving.l.poId} orderNumber={receiving.o.number} remaining={receiving.l.due}
          product={{ id: receiving.l.productId, name: receiving.l.productName, unit: receiving.l.unit || 'units', category: receiving.l.category }}
          destinationStock={receiving.o.origin === 'shopify' ? receiving.o.destinationStock : null}
          user={user} showToast={showToast}
          onClose={() => setReceiving(null)}
          onDone={() => { const o = receiving.o; setReceiving(null); refresh(o); }}
        />
      )}
      {correcting && (
        <CorrectReceiptModal line={correcting.l} order={correcting.o} events={history[correcting.l.poId] || []} showToast={showToast}
          onClose={() => setCorrecting(null)} onDone={() => { const o = correcting.o; setCorrecting(null); refresh(o); }} />
      )}
      {cancelling && (
        <CancelLineModal line={cancelling.l} order={cancelling.o} showToast={showToast}
          onClose={() => setCancelling(null)} onDone={() => { const o = cancelling.o; setCancelling(null); refresh(o); }} />
      )}
      {registerFor && (
        <RegisterFragranceModal
          product={{ id: registerFor.l.productId, name: registerFor.l.productName, productCode: registerFor.l.productCode, unit: registerFor.l.unit || 'mL' }}
          company={registerFor.l.registerCompany} fromRefusal showToast={showToast}
          onClose={() => setRegisterFor(null)}
          onDone={(regs, active) => {
            const o = registerFor.o;
            setRegisterFor(null);
            if (active) showToast('Registered — the line can be accepted now', 'success');
            refresh(o);
          }}
        />
      )}
    </div>
  );
}

function OrderCard({ o, isOpen, onToggle, isAdmin, busy, history, onAccept, onTakeNew, onReceive, onCorrect, onCancel, onRegister }) {
  const st = STATUS[o.status] || STATUS.on_order;
  const alert = ALERT[o.alert];
  const waiting = o.lines.filter((l) => l.state === 'waiting').length;
  const tracked = o.lines.filter((l) => l.state !== 'info');
  const done = tracked.filter((l) => ['received', 'closed_short', 'cancelled'].includes(l.state) || (l.state === 'by_hand' && l.handDone)).length;
  const accent = !o.destinationStock ? '#ef4444' : alert ? alert.color : o.attention ? '#fbbf24' : st.color;
  return (
    <div className="card" style={{ marginBottom: 14, position: 'relative', overflow: 'visible', borderLeft: `3px solid ${accent}` }}>
      <GlowingEffect spread={35} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={onToggle} aria-expanded={isOpen}
          style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', flexWrap: 'wrap', textAlign: 'left' }}>
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{o.number}</span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 8px', borderRadius: 20,
            background: o.origin === 'shopify' ? 'rgba(99,102,241,0.15)' : 'rgba(148,163,184,0.15)',
            color: o.origin === 'shopify' ? '#a5b4fc' : '#94a3b8',
            border: `1px solid ${o.origin === 'shopify' ? 'rgba(99,102,241,0.3)' : 'rgba(148,163,184,0.3)'}` }}>
            {o.origin === 'shopify' ? 'SHOPIFY' : 'TYPED BY HAND'}
          </span>
          {o.destinationStock ? (
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
              color: o.destinationStock === 'SA' ? '#60a5fa' : '#d4b574',
              border: `1px solid ${o.destinationStock === 'SA' ? 'rgba(96,165,250,0.4)' : 'rgba(212,181,116,0.45)'}` }}
              title={o.destination ? `Shopify destination: ${o.destination}` : undefined}>
              {o.destinationLabel}
            </span>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={13} /> Unknown destination
            </span>
          )}
          <span style={{ fontSize: 11, fontWeight: 700, color: st.color }}>{st.label}</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {o.supplier || 'no supplier'} · {o.dateLocal}
            {o.transfers?.length > 0 && ` · ${o.transfers.join(', ')}`}
            {tracked.length > 0 && ` · ${done} of ${tracked.length} line${tracked.length > 1 ? 's' : ''} finished`}
          </span>
          {isAdmin && o.origin === 'shopify' && o.inShopify && waiting > 0 && (
            <button className="btn btn-primary" onClick={onAccept} disabled={busy === o.key}
              style={{ fontSize: 12, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Link2 size={13} /> {busy === o.key ? 'Accepting…' : `Accept ${waiting} line${waiting > 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>

      {alert && (
        <div role="alert" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
          color: alert.color, background: alert.bg, border: `1px solid ${alert.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          {o.alert === 'record_here' ? <PackageCheck size={14} /> : <AlertTriangle size={14} />} {alert.text}
        </div>
      )}
      {o.destinationError && <div style={{ fontSize: 12.5, color: '#f87171', marginTop: 10, fontWeight: 600 }}>{o.destinationError}</div>}

      {isOpen && (
        <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
          {o.lines.map((l, i) => (
            <LineRow key={l.lineId || l.poId || i} o={o} l={l} isAdmin={isAdmin} busy={busy} events={l.poId ? history[l.poId] : null}
              onTakeNew={onTakeNew} onReceive={onReceive} onCorrect={onCorrect} onCancel={onCancel} onRegister={onRegister} />
          ))}
        </div>
      )}
    </div>
  );
}

function lineStatus(l) {
  switch (l.state) {
    case 'waiting': return { text: l.autoReady ? 'Waiting — it is accepted by itself on the next read' : 'Waiting to accept', color: '#fbbf24' };
    case 'unmatched': return { text: `Not recognised: ${l.note}`, color: '#fbbf24' };
    case 'not_registered': return { text: `${l.note} — it cannot be accepted yet`, color: '#f87171' };
    case 'unknown_destination': return { text: 'The order\'s destination is not linked to a company', color: '#f87171' };
    case 'by_hand': return { text: `${l.note}${l.handDone ? ' — received there' : ' — not received yet'}`, color: l.handDone ? '#94a3b8' : '#fbbf24' };
    case 'info': return { text: l.note, color: '#94a3b8' };
    case 'on_order': return { text: 'On order', color: '#60a5fa' };
    case 'part': return { text: 'Part received', color: '#60a5fa' };
    case 'received': return { text: 'Received', color: '#34d399' };
    case 'closed_short': return { text: `Closed short${l.closedShortReason ? ` — ${l.closedShortReason}` : ''}`, color: '#94a3b8' };
    case 'cancelled': return { text: `Cancelled${l.cancelReason ? ` — ${l.cancelReason}` : ''}`, color: '#94a3b8' };
    default: return { text: l.state, color: '#94a3b8' };
  }
}

function LineRow({ o, l, isAdmin, busy, events, onTakeNew, onReceive, onCorrect, onCancel, onRegister }) {
  const s = lineStatus(l);
  const isOpenLine = ['on_order', 'part'].includes(l.state);
  const canReceive = isAdmin && isOpenLine && !l.missing && !l.changedInShopify && l.due > 0;
  const canCorrect = isAdmin && l.poId && l.received > 0 && l.state !== 'cancelled';
  const canCancel = isAdmin && isOpenLine;
  const small = { fontSize: 11, padding: '4px 10px' };
  return (
    <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-secondary, rgba(148,163,184,0.06))', border: '1px solid var(--border-color, rgba(148,163,184,0.18))' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{l.productName || '(not recognised)'}</span>
            {l.sku && <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: 'var(--text-muted)' }}>{l.sku}</span>}
          </div>
          <div style={{ fontSize: 11.5, color: s.color, marginTop: 3, fontWeight: 600 }}>
            {s.text}
            {l.missing && isOpenLine && <span style={{ color: '#f87171' }}> · no longer in Shopify — cancel it unless it really is coming</span>}
            {l.automatic && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · accepted automatically</span>}
          </div>
          {l.state === 'not_registered' && isAdmin && (
            <button type="button" onClick={() => onRegister(l)} style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontWeight: 700, cursor: 'pointer', fontSize: 11.5 }}>
              Register now
            </button>
          )}
          {l.changedInShopify && (
            <div style={{ fontSize: 11.5, color: '#fbbf24', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              Changed in Shopify — accepted as {qty(l.ordered, l.unit)}, now {qty(l.incomingQty, l.unit)}
              {isAdmin && (
                <button className="btn btn-secondary" disabled={busy === l.poId} onClick={() => onTakeNew(l)} style={{ fontSize: 10, padding: '2px 8px' }}>
                  {busy === l.poId ? 'Updating…' : `Take ${qty(l.incomingQty, l.unit)}`}
                </button>
              )}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12.5 }}>
          {l.poId ? (
            <>
              <div><span style={{ color: 'var(--text-muted)' }}>Ordered</span> <strong>{qty(l.ordered, l.unit)}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Received</span> <strong>{qty(l.received, l.unit)}</strong>
                {l.due > 0 && <> · <span style={{ color: 'var(--text-muted)' }}>still due</span> <strong style={{ color: '#60a5fa' }}>{qty(l.due, l.unit)}</strong></>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {l.cost != null ? `${l.unit === 'mL' ? `$${(l.cost * 1000).toFixed(2)}/L` : `$${l.cost.toFixed(2)} each`} ex GST` : 'No price on the PO'}
              </div>
            </>
          ) : l.incomingQty != null ? (
            <div><span style={{ color: 'var(--text-muted)' }}>On the order</span> <strong>{qty(l.incomingQty, l.unit)}</strong>
              {l.bottles != null && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{l.bottles} × {l.bottleMl} mL</div>}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>{l.shopifyQty} on the order</div>
          )}
          {isAdmin && (canReceive || canCorrect || canCancel) && (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
              {canReceive && <button className="btn btn-primary" style={{ ...small, background: '#10b981', borderColor: '#10b981' }} onClick={() => onReceive(l)}>Receive</button>}
              {canCorrect && <button className="btn btn-secondary" style={small} onClick={() => onCorrect(l)}>Correct receipt</button>}
              {canCancel && <button className="btn btn-secondary" style={small} onClick={() => onCancel(l)}>Cancel line</button>}
            </div>
          )}
        </div>
      </div>

      {/* The line's history (P3, 5.3): accepted, each receipt and where it went, each correction. */}
      {l.poId && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border-color, rgba(148,163,184,0.25))', fontSize: 11.5, color: 'var(--text-secondary)', display: 'grid', gap: 3 }}>
          <div>{when(l.addedAt)} · {l.automatic ? 'accepted automatically' : `added by ${l.addedBy || 'unknown'}`}</div>
          {(events || []).map((e, i) => (
            <div key={i} style={{ color: e.kind === 'correction' ? '#fbbf24' : 'var(--text-secondary)' }}>
              {when(e.at)} · {e.by || 'unknown'} · {e.kind === 'correction' ? `corrected −${qty(e.quantity, l.unit)}` : `received ${qty(e.quantity, l.unit)}`}
              {e.lines.length > 0 && ` ${e.kind === 'correction' ? 'from' : '→'} ${e.lines.map((x) => `${sectorLabel(x.stock)} ${qty(x.quantity, l.unit)}`).join(' · ')}`}
            </div>
          ))}
          {events == null && <div style={{ color: 'var(--text-muted)' }}>Reading its history…</div>}
          {l.cancelledAt && <div>{when(l.cancelledAt)} · cancelled by {l.cancelledBy || 'unknown'} — {l.cancelReason}</div>}
        </div>
      )}
    </div>
  );
}

// Where this line's receipts went, net of earlier corrections. Before Stage 1
// a receipt went 100 % to SA, and its row carries no movement.
function netByStock(events) {
  const net = {};
  for (const e of events) {
    const lines = e.lines.length ? e.lines : [{ stock: 'SA', quantity: e.quantity }];
    for (const x of lines) net[x.stock] = (net[x.stock] || 0) + (e.kind === 'correction' ? -x.quantity : x.quantity);
  }
  return Object.fromEntries(Object.entries(net).filter(([, v]) => v > 0.001));
}

// Correct receipt (R4, D4): take back part of a receipt that never arrived.
function CorrectReceiptModal({ line, order, events, onClose, onDone, showToast }) {
  const isMl = line.unit === 'mL';
  const isOil = line.category === 'OILS';
  const unitWord = displayUnit(line.unit);
  const toBase = (v) => (isMl ? Math.round(parseFloat(v) * 1000 * 1000) / 1000 : parseFloat(v));
  const fromBase = (v) => Math.round((isMl ? v / 1000 : v) * 1000) / 1000;
  const net = isOil ? netByStock(events) : {};
  const stocks = Object.keys(net);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState('still_due');
  const [split, setSplit] = useState({});
  const [error, setError] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [saving, setSaving] = useState(false);
  const amountBase = toBase(amount) || 0;
  const many = stocks.length > 1;
  const splitTotal = Object.values(split).reduce((s, v) => s + (toBase(v) || 0), 0);
  const splitOff = many && Math.abs(splitTotal - amountBase) > 0.001;

  const submit = async (e) => {
    e.preventDefault();
    if (!(amountBase > 0)) return setError('Enter how much never arrived');
    if (!reason.trim()) return setError('Say why');
    if (splitOff) return setError('The stocks must add up to the correction');
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/purchase-orders/${line.poId}/correct`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: amountBase, reason: reason.trim(), mode,
          ...(many && { lines: stocks.filter((k) => toBase(split[k]) > 0).map((k) => ({ from: k, quantity: toBase(split[k]) })) }),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A stock limit (a MUSE stock or the main store at zero) is refused and
        // recorded: a pop-up says so, as for a refused receipt.
        if (res.status === 400 && /holds/.test(body.error || '')) setRefusal(body.error);
        else setError(body.error || 'Could not correct the receipt');
        return;
      }
      showToast(`${order.number}: ${qty(amountBase, line.unit)} of ${line.productName} taken back${mode === 'close_short' ? ' — the line is closed short' : ' — still due'}`, 'success');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Correct receipt — {order.number} · {line.productName}</h2>
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
          <form onSubmit={submit}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, lineHeight: 1.6 }}>
              Received on this line: <strong style={{ color: 'var(--text-primary)' }}>{qty(line.received, line.unit)}</strong>
              {isOil && stocks.length > 0 && <> — into {stocks.map((k) => `${sectorLabel(k)} ${qty(net[k], line.unit)}`).join(', ')}</>}.
              Take back what never arrived. It comes off the stock it went into, and nothing is deleted.
            </p>
            <div className="form-group">
              <label htmlFor="correct-amount">Never arrived ({unitWord}) *</label>
              <input id="correct-amount" className="input" type="number" min="0" step="any" value={amount}
                max={fromBase(line.received)} onChange={(e) => setAmount(e.target.value)} required autoFocus />
            </div>
            {many && (
              <div className="form-group">
                <label>From which stock ({unitWord})</label>
                <div style={{ display: 'grid', gap: 6 }}>
                  {stocks.map((k) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 150, fontSize: 12.5 }}>{sectorLabel(k)} <span style={{ color: 'var(--text-muted)' }}>({fromBase(net[k])})</span></span>
                      <input className="input" type="number" min="0" step="any" placeholder="0" aria-label={`From ${sectorLabel(k)}`}
                        value={split[k] || ''} onChange={(e) => setSplit((s) => ({ ...s, [k]: e.target.value }))} />
                    </div>
                  ))}
                </div>
                {splitOff && <small style={{ color: '#f87171', fontWeight: 700 }}>The stocks add up to {fromBase(splitTotal)} {unitWord}; the correction is {fromBase(amountBase)} {unitWord}.</small>}
              </div>
            )}
            <div className="form-group">
              <label>And the rest of the line</label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, fontSize: 13 }}>
                <input type="radio" name="mode" checked={mode === 'still_due'} onChange={() => setMode('still_due')} /> It is still coming — show it as still due
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, fontSize: 13 }}>
                <input type="radio" name="mode" checked={mode === 'close_short'} onChange={() => setMode('close_short')} /> The supplier will not send it — close the line short
              </label>
            </div>
            <div className="form-group">
              <label htmlFor="correct-reason">Why *</label>
              <input id="correct-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. short delivery — 95 L arrived, not 100 L" required />
            </div>
            {error && <div role="alert" style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving || splitOff}>{saving ? 'Saving…' : 'Correct the receipt'}</button>
            </div>
          </form>
        </div>
      </div>
      {refusal && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="correct-refused-title" style={{
          position: 'fixed', inset: 0, zIndex: 99998, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg, #151c2c)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 14,
            padding: '26px 30px', maxWidth: 480, width: '92%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <h3 id="correct-refused-title" style={{ margin: '0 0 12px', fontSize: 17, color: '#f87171' }}>Check this correction — nothing was saved</h3>
            <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary, #e2e8f0)' }}>{refusal}</p>
            <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text-muted, #64748b)' }}>This attempt was recorded in Activity.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" autoFocus onClick={() => setRefusal(null)}>Review the correction</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Cancel line (R5): with a reason, and the row kept. With receipts, it closes short.
function CancelLineModal({ line, order, onClose, onDone, showToast }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const short = line.received > 0;
  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return setError('Say why');
    setSaving(true);
    try {
      const res = await fetch(`/api/purchase-orders/${line.poId}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.error || 'Could not cancel the line');
      showToast(`${order.number}: ${line.productName} ${body.status === 'closed_short' ? 'closed short' : 'cancelled'}`, 'success');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{short ? 'Close short' : 'Cancel line'} — {order.number} · {line.productName}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={submit}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, lineHeight: 1.6, display: 'flex', gap: 8 }}>
            <Info size={15} style={{ flexShrink: 0, marginTop: 2 }} />
            {short
              ? `${qty(line.received, line.unit)} has arrived on this line, so it is closed short: what arrived stays recorded, and the ${qty(line.due, line.unit)} still due is no longer expected.`
              : `Nothing has arrived on this line. Cancelling keeps it on the order with your reason; the ${qty(line.due, line.unit)} is no longer expected.`}
          </p>
          <div className="form-group">
            <label htmlFor="cancel-reason">Why *</label>
            <input id="cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required
              placeholder={short ? 'e.g. the supplier will not send the rest' : 'e.g. ordered twice'} />
          </div>
          {error && <div role="alert" style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Back</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : short ? 'Close short' : 'Cancel the line'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
