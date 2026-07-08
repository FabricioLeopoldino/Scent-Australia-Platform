import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/Toast';
import { GlowingEffect } from '../components/GlowingEffect';
import { displayStock, mlToL, fmtL } from '../utils/unitConversion';
import MlHelper from '../components/MlHelper';

const getStockStatus = (main, min) => {
  const cur = parseFloat(main) || 0;
  const m   = parseFloat(min)  || 0;
  if (cur <= 0)                return 'Out of Stock';
  if (m > 0 && cur <= m)       return 'Low Stock';
  if (m > 0 && cur <= m * 1.5) return 'Reorder Soon';
  return 'Healthy';
};

const statusColor = (s) => ({
  'Out of Stock': '#ef4444',
  'Low Stock':    '#fbbf24',
  'Reorder Soon': '#fbbf24',
  'Healthy':      '#22c55e',
}[s] || '#94a3b8');

export default function TechStock({ user }) {
  const showToast  = useToast();
  const isRoot     = user?.role === 'root';
  const canOperate = ['technician', 'admin', 'root'].includes(user?.role);

  const [products,     setProducts]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Operation modal
  const [modal,      setModal]      = useState(null);
  const [qty,        setQty]        = useState('');
  const [notes,      setNotes]      = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Inline Set Qty editing (root only)
  const [editTarget,   setEditTarget]   = useState(null);
  const [savingTarget, setSavingTarget] = useState(false);

  const fetchProducts = useCallback(async () => {
    try {
      const res  = await fetch('/api/tech-stock');
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Tech Stock fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  // ── Operation modal ────────────────────────────────────────────────────────
  const openModal  = (mode, product) => { setModal({ mode, product }); setQty(''); setNotes(''); };
  const closeModal = () => { setModal(null); setQty(''); setNotes(''); };

  const maxQty = (() => {
    if (!modal) return 0;
    if (modal.mode === 'transfer')     return parseFloat(modal.product.currentStock) || 0;
    if (modal.mode === 'return-input') return Infinity;
    return parseFloat(modal.product.tech_quantity) || 0;
  })();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const parsedQty = parseFloat(qty);
    if (!qty || parsedQty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
    if (maxQty !== Infinity && parsedQty > maxQty) {
      showToast(`Cannot exceed available: ${displayStock(maxQty, modal.product.unit)}`, 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tech-stock/${modal.mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: modal.product.id, quantity: parsedQty, notes: notes || null }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Operation failed', 'error'); return; }
      const labels = {
        transfer:       'Transferred to Tech Stock',
        remove:         'Removed from Tech Stock',
        return:         'Returned to Main Stock',
        'return-input': 'Return recorded in Tech Stock',
      };
      showToast(`${labels[modal.mode]} — ${modal.product.name}`, 'success');
      closeModal();
      fetchProducts();
    } catch {
      showToast('Connection error', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Set Qty inline save (root) ─────────────────────────────────────────────
  const saveTarget = async (productId) => {
    const val = editTarget?.value === '' ? null : parseFloat(editTarget?.value);
    if (val !== null && (isNaN(val) || val < 0)) { showToast('Enter a valid quantity', 'error'); return; }
    setSavingTarget(true);
    try {
      const res = await fetch(`/api/tech-stock/${productId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_quantity: val }),
      });
      if (!res.ok) { showToast('Failed to save', 'error'); return; }
      setEditTarget(null);
      fetchProducts();
    } catch {
      showToast('Connection error', 'error');
    } finally {
      setSavingTarget(false);
    }
  };

  // ── Filtered list ──────────────────────────────────────────────────────────
  const filtered = products.filter(p => {
    const q = search.toLowerCase();
    const matchSearch = !q || p.name?.toLowerCase().includes(q) || p.productCode?.toLowerCase().includes(q);
    if (!matchSearch) return false;
    if (statusFilter === 'HAS_TECH') return (parseFloat(p.tech_quantity) || 0) > 0;
    return true;
  });

  const withTech = products.filter(p => (parseFloat(p.tech_quantity) || 0) > 0);
  const totalTech = products.reduce((s, p) => s + (parseFloat(p.tech_quantity) || 0), 0);

  // ── Modal config ───────────────────────────────────────────────────────────
  const modalConfig = {
    transfer:       { title: '↗ Transfer to Tech Stock',          color: '#22c55e' },
    remove:         { title: '↘ Remove from Tech Stock',          color: '#fb923c' },
    return:         { title: '↩ Return to Main Stock',            color: '#60a5fa' },
    'return-input': { title: '↙ Return Input (Tech → Tech Stock)', color: '#34d399' },
  };

  if (loading) return (
    <div className="container" style={{ paddingTop: 40 }}>
      <div style={{ textAlign: 'center', padding: 60, color: 'rgba(232,234,242,0.45)' }}>Loading Tech Stock...</div>
    </div>
  );

  return (
    <div className="container" style={{ paddingTop: 40 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">TECH STOCK</h2>
          <p style={{ color: 'rgba(232,234,242,0.45)', fontSize: 13, margin: 0 }}>
            Fragrance oil pool reserved for technician use
          </p>
        </div>
        {/* Summary chips */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {[
            { label: 'Total Oils',  value: products.length,   color: '#60a5fa' },
            { label: 'In Tech',     value: withTech.length,   color: '#fb923c' },
            { label: 'Total Tech',  value: fmtL(mlToL(totalTech)) + ' L', color: '#34d399' },
          ].map(chip => (
            <div key={chip.label} style={{
              background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '6px 14px', textAlign: 'center', minWidth: 90,
            }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: chip.color }}>{chip.value}</div>
              <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>{chip.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 24, position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <input className="input" type="text" placeholder="Search oils..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { value: 'ALL',      label: 'All' },
              { value: 'HAS_TECH', label: 'In Tech' },
            ].map(f => (
              <button key={f.value}
                className={`btn ${statusFilter === f.value ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setStatusFilter(f.value)}
                style={{ fontSize: 13, padding: '8px 16px' }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Main Stock</th>
                <th>Main Status</th>
                <th style={{ color: '#fb923c' }}>Tech Stock</th>
                <th>Total Physical</th>
                <th style={{ color: '#a78bfa' }}>Set Qty</th>
                <th style={{ color: '#fbbf24' }}>To Replenish</th>
                {canOperate && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'rgba(232,234,242,0.35)' }}>
                    No oils found.
                  </td>
                </tr>
              ) : filtered.map(p => {
                const techQty    = parseFloat(p.tech_quantity) || 0;
                const mainQty    = parseFloat(p.currentStock)  || 0;
                const total      = mainQty + techQty;
                const targetQty  = p.target_quantity != null ? parseFloat(p.target_quantity) : null;
                const toReplenish = targetQty != null ? Math.max(0, targetQty - techQty) : null;
                const mainInsufficient = toReplenish != null && toReplenish > 0 && mainQty < toReplenish;
                const status     = getStockStatus(p.currentStock, p.minStockLevel);
                const sColor     = statusColor(status);
                const isEditingThis = editTarget?.productId === p.id;

                return (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.productCode || '-'}</td>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td style={{ fontWeight: 700 }}>{displayStock(p.currentStock, p.unit)}</td>
                    <td>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        background: `${sColor}18`, border: `1px solid ${sColor}55`, color: sColor,
                      }}>{status}</span>
                    </td>
                    <td>
                      {techQty > 0 ? (
                        <span style={{
                          fontSize: 13, fontWeight: 700, color: '#fb923c',
                          background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.3)',
                          padding: '2px 10px', borderRadius: 6,
                        }}>
                          {displayStock(techQty, p.unit)}
                        </span>
                      ) : (
                        <span style={{ color: 'rgba(232,234,242,0.25)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={{ fontWeight: 600, color: 'rgba(232,234,242,0.7)' }}>
                      {displayStock(total, p.unit)}
                    </td>

                    {/* Set Qty — inline edit for root */}
                    <td>
                      {isRoot ? (
                        isEditingThis ? (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input
                              type="number" min="0" step="0.001"
                              value={editTarget.value}
                              onChange={e => setEditTarget(t => ({ ...t, value: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') saveTarget(p.id); if (e.key === 'Escape') setEditTarget(null); }}
                              autoFocus
                              style={{
                                width: 80, padding: '3px 6px', fontSize: 12, borderRadius: 5,
                                background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.4)',
                                color: 'var(--text)', outline: 'none',
                              }}
                            />
                            <button onClick={() => saveTarget(p.id)} disabled={savingTarget}
                              style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
                                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e' }}>
                              {savingTarget ? '…' : '✓'}
                            </button>
                            <button onClick={() => setEditTarget(null)}
                              style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
                                background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }}>
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={() => setEditTarget({ productId: p.id, value: targetQty != null ? String(targetQty) : '' })}
                            title="Click to set target quantity"
                            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            {targetQty != null ? (
                              <span style={{ fontWeight: 700, color: '#a78bfa' }}>{displayStock(targetQty, p.unit)}</span>
                            ) : (
                              <span style={{ color: 'rgba(232,234,242,0.25)', fontSize: 12 }}>— set</span>
                            )}
                            <span style={{ fontSize: 10, color: 'rgba(167,139,250,0.4)' }}>✎</span>
                          </div>
                        )
                      ) : (
                        targetQty != null
                          ? <span style={{ fontWeight: 700, color: '#a78bfa' }}>{displayStock(targetQty, p.unit)}</span>
                          : <span style={{ color: 'rgba(232,234,242,0.25)', fontSize: 12 }}>—</span>
                      )}
                    </td>

                    {/* To Replenish */}
                    <td>
                      {toReplenish != null ? (
                        toReplenish > 0 ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontWeight: 700, color: mainInsufficient ? '#ef4444' : '#fbbf24' }}>
                              {displayStock(toReplenish, p.unit)}
                            </span>
                            {mainInsufficient && (
                              <span title={`Main stock (${displayStock(mainQty, p.unit)}) insufficient`} style={{ fontSize: 13 }}>⚠️</span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 12 }}>✓ Full</span>
                        )
                      ) : (
                        <span style={{ color: 'rgba(232,234,242,0.2)', fontSize: 12 }}>—</span>
                      )}
                    </td>

                    {/* Actions */}
                    {canOperate && (
                      <td>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button className="btn btn-secondary" onClick={() => openModal('transfer', p)}
                            style={{ fontSize: 11, padding: '4px 9px', color: '#22c55e', borderColor: 'rgba(34,197,94,0.3)' }}
                            disabled={mainQty <= 0} title="Transfer from Main to Tech">
                            ↗ Transfer
                          </button>
                          {techQty > 0 && (<>
                            <button className="btn btn-secondary" onClick={() => openModal('remove', p)}
                              style={{ fontSize: 11, padding: '4px 9px', color: '#fb923c', borderColor: 'rgba(251,146,60,0.3)' }}
                              title="Remove (consume) from Tech Stock">
                              ↘ Remove
                            </button>
                            <button className="btn btn-secondary" onClick={() => openModal('return', p)}
                              style={{ fontSize: 11, padding: '4px 9px', color: '#60a5fa', borderColor: 'rgba(96,165,250,0.3)' }}
                              title="Return from Tech to Main Stock">
                              ↩ Return to Main
                            </button>
                          </>)}
                          <button className="btn btn-secondary" onClick={() => openModal('return-input', p)}
                            style={{ fontSize: 11, padding: '4px 9px', color: '#34d399', borderColor: 'rgba(52,211,153,0.3)' }}
                            title="Tech returns unused oil back to Tech Stock">
                            ↙ Return Tech
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
          Showing <strong style={{ color: 'rgba(232,234,242,0.7)' }}>{filtered.length}</strong> of {products.length} oils
        </div>
      </div>

      {/* Operation Modal */}
      {modal && (() => {
        const cfg = modalConfig[modal.mode];
        return (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}>
            <div className="card" style={{
              width: '100%', maxWidth: 440,
              border: `1px solid ${cfg.color}33`,
              boxShadow: `0 0 40px ${cfg.color}15`,
            }}>
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: cfg.color }}>{cfg.title}</h3>
                <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.55)', margin: '6px 0 0' }}>{modal.product.name}</p>
              </div>

              {/* Balances */}
              <div style={{
                background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 14px', marginBottom: 18, display: 'flex', gap: 24,
              }}>
                <div>
                  <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginBottom: 3 }}>Main Stock</div>
                  <div style={{ fontWeight: 700 }}>{displayStock(modal.product.currentStock, modal.product.unit)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginBottom: 3 }}>Tech Stock</div>
                  <div style={{ fontWeight: 700, color: '#fb923c' }}>{displayStock(modal.product.tech_quantity, modal.product.unit)}</div>
                </div>
                {modal.mode !== 'return-input' && (
                  <div>
                    <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginBottom: 3 }}>Available</div>
                    <div style={{ fontWeight: 800, color: cfg.color }}>{displayStock(maxQty, modal.product.unit)}</div>
                  </div>
                )}
              </div>

              {modal.mode === 'return-input' && (
                <div style={{
                  fontSize: 12, color: 'rgba(52,211,153,0.7)', background: 'rgba(52,211,153,0.08)',
                  border: '1px solid rgba(52,211,153,0.2)', borderRadius: 6, padding: '8px 12px', marginBottom: 16,
                }}>
                  Technician returning unused oil — stock stays in Tech (Main Stock not affected)
                </div>
              )}

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Quantity ({modal.product.unit})</label>
                  <input className="input" type="number" min="0.001"
                    max={maxQty === Infinity ? undefined : maxQty}
                    step="0.001"
                    value={qty} onChange={e => setQty(e.target.value)}
                    placeholder={maxQty === Infinity ? `Enter quantity in ${modal.product.unit}` : `Max ${displayStock(maxQty, modal.product.unit)}`}
                    autoFocus required />
                  <MlHelper value={qty} unit={modal.product.unit} />
                </div>

                <div className="form-group">
                  <label>Notes <span style={{ color: 'rgba(232,234,242,0.35)', fontWeight: 400 }}>— optional</span></label>
                  <input className="input" type="text" value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder="e.g. Service job, unused quantity..." />
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                  <button type="button" className="btn btn-secondary" onClick={closeModal}
                    style={{ flex: 1 }} disabled={submitting}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}
                    style={{ flex: 2, background: `${cfg.color}22`, color: cfg.color, border: `1px solid ${cfg.color}55` }}>
                    {submitting ? 'Processing...' : cfg.title}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
