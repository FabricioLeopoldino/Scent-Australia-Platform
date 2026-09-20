// Purchase orders raised in Shopify, and the one action taken on them.
//
// Reading is the default state of this page: it shows what the platform can see
// in the store, with every line either placed against a product or carrying the
// reason it could not be. Nothing is ever written back to Shopify.
//
// Accepting is the only thing that writes, and what it writes is an ORDINARY
// purchase order row. From that moment the order behaves exactly like one raised
// here — it shows beside its fragrance, and the warehouse receives it with the
// button it already uses. There is no separate receiving flow to learn and no
// second place for incoming stock to live.
import { useState, useEffect } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, ExternalLink, PackageCheck, Link2 } from 'lucide-react';
import { useToast } from '../components/Toast';
import { GlowingEffect } from '../components/GlowingEffect';

const L = (ml) => `${(ml / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} L`;

export default function ShopifyPurchaseOrders({ user }) {
  const showToast = useToast();
  const [state, setState] = useState({ loading: true });
  const [accepting, setAccepting] = useState(null);

  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch('/api/shopify-purchase-orders');
      setState({ loading: false, ...(await res.json()) });
    } catch (e) {
      setState({ loading: false, ok: false, error: e.message, orders: [] });
    }
  };

  // Accepting writes ordinary purchase order rows, so from then on the order
  // behaves like one raised here: it shows beside its fragrance and is received
  // with the button the warehouse already uses. The server re-reads the
  // quantities from Shopify, so a tab left open cannot accept a stale number.
  const accept = async (po) => {
    setAccepting(po.shopifyId);
    try {
      const res = await fetch('/api/shopify-purchase-orders/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopifyId: po.shopifyId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not accept');
      showToast(
        `${body.number}: ${body.accepted} line(s) now showing against their fragrance`
        + (body.unmatched ? ` · ${body.unmatched} still not recognised` : ''),
        'success');
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setAccepting(null);
    }
  };

  useEffect(() => { load(); }, []);

  // Accepted here, then deleted in Shopify. The platform would otherwise count
  // that oil as on its way for ever, and silently — the order is gone from the
  // store, so it is gone from the list below too.
  const dropOrphan = async (o) => {
    setAccepting(o.id);
    try {
      const res = await fetch(`/api/purchase-orders/${o.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not remove');
      showToast(`${o.number} removed — it is no longer expected`, 'success');
      await load();
    } catch (e) { showToast(e.message, 'error'); }
    finally { setAccepting(null); }
  };

  const { ok, error, orders = [], orphans = [], counts, readAt, loading } = state;

  return (
    <div className="container" style={{ paddingTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <h2 className="page-title" style={{ margin: 0 }}>Purchase orders raised in Shopify</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6, maxWidth: 680 }}>
            What the platform can see in Shopify right now. <strong>Nothing here changes any stock</strong> —
            this page only reads, so it can be checked against the store before it is trusted.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={14} /> {loading ? 'Reading…' : 'Read again'}
        </button>
      </div>

      {readAt && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 20 }}>
          Read {new Date(readAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}
          {counts ? ` · ${counts.orders} orders · ${counts.lines} lines · ${counts.unmatched} not recognised` : ''}
        </div>
      )}

      {/* Fails closed and says so. `unstable` can change without notice, and a
          page showing an old list as if it were current is worse than one that
          admits it could not read. */}
      {ok === false && (
        <div className="card" style={{ borderLeft: '3px solid #ef4444', background: 'rgba(239,68,68,0.06)', marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <AlertTriangle size={15} /> Could not read Shopify
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>{error}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Nothing is shown rather than something out of date. Ordering carries on as it does today.
          </div>
        </div>
      )}

      {orphans.length > 0 && (
        <div className="card" style={{
          marginBottom: 24, borderLeft: '3px solid #ef4444', background: 'rgba(239,68,68,0.06)',
        }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <AlertTriangle size={15} /> Accepted here, but no longer in Shopify ({orphans.length})
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 14px' }}>
            These were accepted and the purchase order has since been deleted or cancelled in Shopify.
            The platform is still counting them as stock on its way. Remove them unless they really are coming.
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {orphans.map((o) => (
              <div key={o.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.07)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}>
                <div style={{ fontSize: 13 }}>
                  <span style={{ fontFamily: 'monospace' }}>{o.number}</span>
                  <span style={{ color: 'var(--text-secondary)' }}> · {o.productCode} {o.productName}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontWeight: 700, color: '#f87171', fontSize: 13 }}>
                    {L(o.outstandingMl)} still expected
                  </span>
                  {['admin', 'root'].includes(user?.role) && (
                    <button className="btn btn-secondary" disabled={accepting === o.id}
                      onClick={() => dropOrphan(o)} style={{ fontSize: 11, padding: '4px 10px' }}>
                      {accepting === o.id ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {ok && orders.length === 0 && (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No purchase orders raised in Shopify for the warehouse yet.
        </div>
      )}

      {orders.map((po) => (
        <div key={po.shopifyId} className="card" style={{
          marginBottom: 18, position: 'relative', overflow: 'visible',
          borderLeft: `3px solid ${po.unmatchedCount > 0 ? '#fbbf24' : '#10b981'}`,
        }}>
          <GlowingEffect spread={35} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>
                {po.number}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 8px', borderRadius: 20,
                background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.3)',
              }}>
                SHOPIFY
              </span>
              {po.arrivedInShopify && (
                <span style={{ fontSize: 11, color: '#34d399', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <PackageCheck size={13} /> received in Shopify
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {po.supplier || 'no supplier'} → {po.destination} · {po.dateCreatedLocal}
                {po.transfers.length > 0 && ` · ${po.transfers.join(', ')}`}
              </div>
              {po.acceptableLines > 0 && ['admin', 'root'].includes(user?.role) && (
                <button
                  className="btn btn-primary"
                  onClick={() => accept(po)}
                  disabled={accepting === po.shopifyId}
                  style={{ fontSize: 12, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Link2 size={13} />
                  {accepting === po.shopifyId
                    ? 'Accepting…'
                    : `Accept ${po.acceptableLines} line${po.acceptableLines > 1 ? 's' : ''}`}
                </button>
              )}
              {po.acceptedLines > 0 && po.acceptableLines === 0 && (
                <span style={{ fontSize: 11, color: '#34d399', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Link2 size={13} /> accepted
                </span>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
            {po.lines.map((l) => (
              <div key={l.lineId} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                padding: '10px 14px', borderRadius: 8,
                background: l.matched ? 'rgba(16,185,129,0.05)' : 'rgba(245,158,11,0.07)',
                border: `1px solid ${l.matched ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.25)'}`,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    {l.matched
                      ? <CheckCircle2 size={14} color="#34d399" style={{ flexShrink: 0 }} />
                      : <AlertTriangle size={14} color="#fbbf24" style={{ flexShrink: 0 }} />}
                    <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{l.sku || '(no code)'}</span>
                    {l.matched && <span style={{ color: 'var(--text-secondary)' }}>{l.productName}</span>}
                  </div>
                  {/* The reason is the whole point of this line existing. A code
                      that does not match must reach a person, never be skipped —
                      that is how 30 litres sold in July without leaving the
                      system on paper. */}
                  {!l.matched && (
                    <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 4, marginLeft: 22 }}>
                      {l.reason}{l.supplierSku ? ` · supplier code ${l.supplierSku}` : ''}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: l.matched ? '#34d399' : 'var(--text-muted)' }}>
                    {l.matched ? `+ ${L(l.incomingMl)}` : `${l.quantity} units`}
                  </div>
                  {l.matched && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {l.bottles} × {l.bottleMl} mL · has {L(l.currentStock)}
                    </div>
                  )}
                  {l.accepted && (
                    <div style={{ fontSize: 11, color: '#34d399' }}>
                      {l.poStatus === 'received' ? 'received'
                        : l.receivedMl > 0 ? `${L(l.receivedMl)} received so far`
                        : 'waiting to arrive'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {ok && orders.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 20, display: 'flex', alignItems: 'center', gap: 6 }}>
          <ExternalLink size={12} />
          Only orders raised for the warehouse since the new process started are shown. Shopify never closes a
          purchase order, so older ones stay marked "ordered" there for ever and would otherwise fill this page.
        </div>
      )}
    </div>
  );
}
