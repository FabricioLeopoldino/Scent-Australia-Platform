import { useState, useEffect } from 'react';
import { displayStock } from '../utils/unitConversion';
import { GlowingEffect } from '../components/GlowingEffect';

const TYPE_LABELS = {
  add:             { label: 'Add Stock',       color: '#22c55e' },
  remove:          { label: 'Remove Stock',    color: '#f87171' },
  return:          { label: 'Return',          color: '#a78bfa' },
  incoming:        { label: 'Incoming Order',  color: '#fbbf24' },
  adjust:          { label: 'Adjustment',      color: '#60a5fa' },
  shopify_sale:     { label: 'Shopify Sale',         color: '#f472b6' },
  shopify_reversal: { label: 'Fulfillment Reversed', color: '#fb923c' },
  product_created:      { label: 'Product Created',      color: '#34d399' },
  product_deleted:      { label: 'Product Deleted',      color: '#f87171' },
  product_deactivated:  { label: 'Product Deactivated',  color: '#94a3b8' },
  product_activated:    { label: 'Product Activated',    color: '#34d399' },
  sku_published:   { label: 'SKU Published',   color: '#818cf8' },
  sku_added:       { label: 'SKU Added',       color: '#c084fc' },
  po_created:      { label: 'PO Created',      color: '#f59e0b' },
  po_cancelled:    { label: 'PO Cancelled',    color: '#f87171' },
  po_received:     { label: 'PO Received',     color: '#34d399' },
  formula_created:        { label: 'Formula Created',        color: '#a78bfa' },
  formula_updated:        { label: 'Formula Updated',        color: '#818cf8' },
  formula_deleted:        { label: 'Formula Deleted',        color: '#f87171' },
  formula_ready_received: { label: 'Ready Stock Received',   color: '#34d399' },
  formula_ready_adjusted: { label: 'Ready Stock Adjusted',   color: '#60a5fa' },
  formula_ready_used:     { label: 'Ready Stock Used',       color: '#c084fc' },
  scented_group_created:  { label: 'Scented Line Created',   color: '#34d399' },
  scented_group_deleted:  { label: 'Scented Line Deleted',   color: '#f87171' },
  tech_transfer:          { label: 'Tech Transfer',           color: '#fb923c' },
  tech_remove:            { label: 'Tech Remove',             color: '#f87171' },
  tech_return:            { label: 'Tech Return',             color: '#34d399' },
};

const CATEGORY_LABELS = {
  OILS:                'Fragrance Oils',
  SA_SCENTED_PRODUCTS: 'Scented Products',
  SCENT_MACHINES:      'Diffuser Machines',
  MACHINES_SPARES:     'Spares',
  RAW_MATERIALS:       'Raw Materials',
};

const toDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export default function ActivityLog({ user }) {
  const [logs, setLogs]           = useState([]);
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);

  const [filterUser,     setFilterUser]     = useState('');
  const [filterType,     setFilterType]     = useState('');
  const [filterCategory, setFilterCategory] = useState('ALL');
  const [dateFrom,       setDateFrom]       = useState('');
  const [dateTo,         setDateTo]         = useState('');
  const [hideSystem,     setHideSystem]     = useState(true);

  useEffect(() => {
    fetch('/api/audit/users')
      .then(r => r.json())
      .then(setUsers)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [filterUser, filterType, filterCategory, dateFrom, dateTo, hideSystem]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: 500, hideSystem: hideSystem ? 'true' : 'false' });
      if (filterUser)               params.append('userId',   filterUser);
      if (filterType)               params.append('type',     filterType);
      if (filterCategory !== 'ALL') params.append('category', filterCategory);
      if (dateFrom)                 params.append('dateFrom', dateFrom);
      if (dateTo)                   params.append('dateTo',   dateTo);

      const res = await fetch(`/api/audit?${params}`);
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  const resetFilters = () => {
    setFilterUser('');
    setFilterType('');
    setFilterCategory('ALL');
    setDateFrom('');
    setDateTo('');
    setHideSystem(true);
  };

  const formatDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const today = toDateStr(new Date());
  const hasFilters = filterUser || filterType || filterCategory !== 'ALL' || dateFrom || dateTo || !hideSystem;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Activity Log</h1>
          <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.45)', margin: '4px 0 0' }}>
            All stock movements — who did what and when
          </p>
        </div>
        {hasFilters && (
          <button className="btn btn-secondary" style={{ fontSize: 13 }} onClick={resetFilters}>
            Clear Filters
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20, position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>

          {/* User */}
          <div className="form-group" style={{ margin: 0, minWidth: 160 }}>
            <label style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 4, display: 'block' }}>User</label>
            <select className="input" style={{ fontSize: 13 }} value={filterUser} onChange={e => setFilterUser(e.target.value)}>
              <option value="">All Users</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>

          {/* Action Type */}
          <div className="form-group" style={{ margin: 0, minWidth: 160 }}>
            <label style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 4, display: 'block' }}>Action</label>
            <select className="input" style={{ fontSize: 13 }} value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="">All Actions</option>
              {Object.entries(TYPE_LABELS).map(([val, { label }]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          {/* Category */}
          <div className="form-group" style={{ margin: 0, minWidth: 160 }}>
            <label style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 4, display: 'block' }}>Category</label>
            <select className="input" style={{ fontSize: 13 }} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All Categories</option>
              {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          {/* Date From */}
          <div className="form-group" style={{ margin: 0, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 4, display: 'block' }}>From</label>
            <input type="date" className="input" style={{ fontSize: 13 }} value={dateFrom} max={dateTo || today} onChange={e => setDateFrom(e.target.value)} />
          </div>

          {/* Date To */}
          <div className="form-group" style={{ margin: 0, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 4, display: 'block' }}>To</label>
            <input type="date" className="input" style={{ fontSize: 13 }} value={dateTo} min={dateFrom} max={today} onChange={e => setDateTo(e.target.value)} />
          </div>

          {/* Hide System toggle */}
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '6px 14px',
                background: hideSystem ? '#3b82f6' : 'rgba(255,255,255,0.04)',
                color: hideSystem ? 'white' : 'rgba(232,234,242,0.45)',
                border: hideSystem ? 'none' : '1px solid rgba(255,255,255,0.07)',
              }}
              onClick={() => setHideSystem(v => !v)}
            >
              {hideSystem ? 'Users only' : 'All (incl. System)'}
            </button>
          </div>

          {/* Quick presets */}
          <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-end' }}>
            {[
              { label: 'Today',   from: today,                                                             to: today },
              { label: '7 days',  from: toDateStr(new Date(Date.now() - 6*86400000)),                     to: today },
              { label: '30 days', from: toDateStr(new Date(Date.now() - 29*86400000)),                    to: today },
            ].map(p => (
              <button key={p.label} className="btn btn-secondary"
                style={{ fontSize: 12, padding: '6px 12px', background: dateFrom === p.from && dateTo === p.to ? '#3b82f6' : undefined, color: dateFrom === p.from && dateTo === p.to ? 'white' : undefined, border: dateFrom === p.from && dateTo === p.to ? 'none' : undefined }}
                onClick={() => { setDateFrom(p.from); setDateTo(p.to); }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ marginBottom: 12, fontSize: 13, color: 'rgba(232,234,242,0.45)' }}>
          {loading ? 'Loading…' : `${logs.length} record${logs.length !== 1 ? 's' : ''}`}
        </div>
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Product</th>
                <th>Category</th>
                <th>Quantity</th>
                <th>Balance After</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'rgba(232,234,242,0.35)' }}>Loading…</td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'rgba(232,234,242,0.35)' }}>No records found</td></tr>
              ) : logs.map(log => {
                const typeInfo = TYPE_LABELS[log.action] || { label: log.action, color: '#94a3b8' };
                const isProductEvent = log.source === 'product';
                const isNegative = log.action === 'remove' || log.action === 'shopify_sale';

                // Format notes: audit_log events store JSON details — render friendly
                let notesDisplay = log.notes || '—';
                let quantityDisplay = null;
                if (isProductEvent && log.notes) {
                  try {
                    const d = JSON.parse(log.notes);
                    if (log.action === 'product_created') {
                      notesDisplay = `${CATEGORY_LABELS[d.category] || d.category} · ${d.productCode}`;
                    } else if (log.action === 'product_deleted') {
                      notesDisplay = `${CATEGORY_LABELS[d.category] || d.category} · ${d.productCode}`;
                    } else if (log.action === 'product_deactivated' || log.action === 'product_activated') {
                      notesDisplay = `${CATEGORY_LABELS[d.category] || d.category} · ${d.productCode}`;
                    } else if (log.action === 'sku_published' || log.action === 'sku_added') {
                      notesDisplay = `${d.added} SKU(s) → Shopify${d.failed ? ` (${d.failed} failed)` : ''}`;
                    } else if (log.action === 'po_created') {
                      const qty = d.unit === 'mL' ? `${(d.quantity / 1000).toFixed(2)} L` : `${d.quantity} ${d.unit || 'units'}`;
                      const eta = d.estimatedDeliveryDate
                        ? ` · ETA: ${new Date(d.estimatedDeliveryDate).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}`
                        : '';
                      notesDisplay = `${d.orderNumber} · ${qty}${eta}`;
                      quantityDisplay = { sign: '+', value: qty, color: '#f59e0b' };
                    } else if (log.action === 'po_cancelled') {
                      const qty = d.unit === 'mL' ? `${(d.quantity / 1000).toFixed(2)} L` : `${d.quantity} ${d.unit || 'units'}`;
                      notesDisplay = `${d.orderNumber} · ${qty} cancelled`;
                      quantityDisplay = { sign: '−', value: qty, color: '#f87171' };
                    } else if (log.action === 'po_received') {
                      const rcv = d.unit === 'mL' ? `${(d.quantityReceived / 1000).toFixed(2)} L` : `${d.quantityReceived} ${d.unit || 'units'}`;
                      const tot = d.unit === 'mL' ? `${(d.totalQuantity / 1000).toFixed(2)} L` : `${d.totalQuantity} ${d.unit || 'units'}`;
                      const badge = d.receiveType === 'full' ? '✅ Full' : '⚠️ Partial';
                      notesDisplay = `${d.orderNumber} · ${badge} · ${rcv}${d.receiveType === 'partial' ? ` of ${tot}` : ''}`;
                      quantityDisplay = { sign: '+', value: rcv, color: '#34d399' };
                    } else if (log.action === 'formula_created') {
                      const skus = Array.isArray(d.shopify_skus) ? d.shopify_skus.join(', ') : (d.shopify_skus || '—');
                      notesDisplay = `Base: ${d.base_product_code} (${d.base_percentage}%) + Oil: ${d.oil_product_code} (${d.oil_percentage}%)${skus !== '—' ? ` · SKUs: ${skus}` : ''}`;
                    } else if (log.action === 'formula_updated') {
                      if (d.changes && Object.keys(d.changes).length > 0) {
                        notesDisplay = Object.entries(d.changes).map(([field, { from, to }]) => {
                          const label = field === 'base_percentage' ? 'Base %'
                            : field === 'oil_percentage' ? 'Oil %'
                            : field === 'base_product_code' ? 'Base product'
                            : field === 'oil_product_code' ? 'Oil product'
                            : field;
                          return `${label}: "${from}" → "${to}"`;
                        }).join(' · ');
                      } else {
                        notesDisplay = 'Updated (no percentage changes)';
                      }
                    } else if (log.action === 'formula_deleted') {
                      notesDisplay = `${d.product_code} · ${d.tag}`;
                    } else if (log.action === 'formula_ready_received') {
                      const ml = d.quantityMl || 0;
                      const total = d.newTotalMl || 0;
                      notesDisplay = `+${(ml / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L received · Total now: ${(total / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L${d.notes ? ` · ${d.notes}` : ''}`;
                      quantityDisplay = { sign: '+', value: `${(ml / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`, color: '#34d399' };
                    } else if (log.action === 'formula_ready_adjusted') {
                      const prev = d.previousMl || 0;
                      const next = d.newMl ?? 0;
                      notesDisplay = `${(prev / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L → ${(next / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`;
                      quantityDisplay = { sign: next >= prev ? '+' : '−', value: `${(Math.abs(next - prev) / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`, color: '#60a5fa' };
                    } else if (log.action === 'formula_ready_used') {
                      const ml = d.mlUsed || 0;
                      const remaining = d.remainingMl ?? 0;
                      const partial = d.partial ? ' (partial)' : '';
                      notesDisplay = `−${(ml / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L used${partial} · Order: ${d.orderId || '—'} · Remaining: ${(remaining / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`;
                      quantityDisplay = { sign: '−', value: `${(ml / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`, color: '#c084fc' };
                    }
                  } catch { /* keep raw */ }
                }

                return (
                  <tr key={`${log.source}-${log.id}`}>
                    <td style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', whiteSpace: 'nowrap' }}>
                      {formatDate(log.created_at)}
                    </td>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>
                      {log.performed_by || <span style={{ color: 'rgba(232,234,242,0.3)', fontStyle: 'italic' }}>System</span>}
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        padding: '2px 10px',
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        background: `${typeInfo.color}18`,
                        color: typeInfo.color,
                        border: `1px solid ${typeInfo.color}40`,
                        whiteSpace: 'nowrap',
                      }}>
                        {typeInfo.label}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{log.entity_name || '—'}</div>
                      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)' }}>{log.entity_code}</div>
                    </td>
                    <td style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                      {CATEGORY_LABELS[log.category] || log.category || '—'}
                    </td>
                    <td style={{ fontWeight: 700, fontSize: 13, color: quantityDisplay?.color || typeInfo.color }}>
                      {quantityDisplay
                        ? `${quantityDisplay.sign}${quantityDisplay.value}`
                        : isProductEvent
                          ? '—'
                          : `${isNegative ? '-' : '+'}${displayStock(Math.abs(log.quantity), log.unit)}`}
                    </td>
                    <td style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                      {isProductEvent ? '—' : displayStock(log.balance_after, log.unit)}
                    </td>
                    <td style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)', maxWidth: 200 }}>
                      {notesDisplay}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
