import { useState, useEffect } from 'react';
import { exportTransactionsToExcel, exportOilUsageToExcel } from '../utils/excelExport';
import { displayStock } from '../utils/unitConversion';
import { GlowingEffect } from '../components/GlowingEffect';

// ── helpers ──────────────────────────────────────────────────────────────────
const toDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}; // YYYY-MM-DD using local time (not UTC)

const getPreset = (key) => {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (key) {
    case 'today':
      return { from: toDateStr(now), to: toDateStr(now), label: 'Today' };
    case 'yesterday': {
      const y2 = new Date(y, m, d - 1);
      return { from: toDateStr(y2), to: toDateStr(y2), label: 'Yesterday' };
    }
    case '7days':
      return { from: toDateStr(new Date(y, m, d - 6)), to: toDateStr(now), label: 'Last 7 Days' };
    case '30days':
      return { from: toDateStr(new Date(y, m, d - 29)), to: toDateStr(now), label: 'Last 30 Days' };
    case 'thisMonth':
      return { from: toDateStr(new Date(y, m, 1)), to: toDateStr(now), label: 'This Month' };
    case 'lastMonth': {
      const first = new Date(y, m - 1, 1);
      const last  = new Date(y, m, 0);
      return { from: toDateStr(first), to: toDateStr(last), label: 'Last Month' };
    }
    case 'all':
    default:
      return { from: '', to: '', label: 'All Time' };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
export default function TransactionHistory() {
  const [transactions, setTransactions]     = useState([]);
  const [loading, setLoading]               = useState(true);
  const [filter, setFilter]                 = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [totalCount, setTotalCount]         = useState(0);
  const [truncated, setTruncated]           = useState(false);

  // Date range — default: this month
  const defaultPreset = getPreset('thisMonth');
  const [dateFrom, setDateFrom]   = useState(defaultPreset.from);
  const [dateTo, setDateTo]       = useState(defaultPreset.to);
  const [activePreset, setActivePreset] = useState('thisMonth');

  useEffect(() => {
    fetchTransactions();
  }, [dateFrom, dateTo]);

  const fetchTransactions = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: 10000 });
      if (dateFrom) params.append('dateFrom', dateFrom);
      if (dateTo)   params.append('dateTo',   dateTo);
      const res  = await fetch(`/api/transactions?${params}`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      setTransactions(rows);
      setTotalCount(rows.length);
      // The backend hard-caps at 5,000 rows (Math.min(limit, 5000)) regardless of
      // what we ask for. Hitting exactly the cap means older rows were silently
      // dropped — say so instead of showing a partial history as if it were whole.
      setTruncated(rows.length >= 5000);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const applyPreset = (key) => {
    const p = getPreset(key);
    setActivePreset(key);
    setDateFrom(p.from);
    setDateTo(p.to);
  };

  const handleDateFrom = (v) => { setDateFrom(v); setActivePreset('custom'); };
  const handleDateTo   = (v) => { setDateTo(v);   setActivePreset('custom'); };

  const getCategoryLabel = (category) => {
    const labels = {
      OILS: 'Oils',
      MACHINES_SPARES: 'Spares',
      RAW_MATERIALS: 'Raw Materials',
      SCENT_MACHINES: 'Diffuser Machines',
      SA_SCENTED_PRODUCTS: 'Scented Products'
    };
    return labels[category] || category;
  };

  const filteredTransactions = transactions.filter(t => {
    const matchesType     = filter === 'all' || t.type === filter;
    const matchesCategory = categoryFilter === 'ALL' || t.category === categoryFilter;
    return matchesType && matchesCategory;
  });

  const handleExport = () => {
    const label = activePreset === 'custom'
      ? `${dateFrom}_to_${dateTo}`
      : getPreset(activePreset).label.replace(/ /g, '_');
    exportTransactionsToExcel(filteredTransactions, label);
  };

  // D15 — cross-company oil usage report. The main /api/transactions call
  // above caps at 5000 rows for the whole page; a long "All Time" range of
  // just OILS could exceed that, so this fetches its own paginated set
  // instead of reusing `transactions`.
  const [exportingOilUsage, setExportingOilUsage] = useState(false);
  const fetchAllOilTransactions = async () => {
    let all = [];
    let offset = 0;
    const limit = 5000;
    for (;;) {
      const params = new URLSearchParams({ category: 'OILS', limit: String(limit), offset: String(offset) });
      if (dateFrom) params.append('dateFrom', dateFrom);
      if (dateTo)   params.append('dateTo',   dateTo);
      const res  = await fetch(`/api/transactions?${params}`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      all = all.concat(rows);
      if (rows.length < limit) break;
      offset += limit;
    }
    return all;
  };
  const handleExportOilUsage = async () => {
    setExportingOilUsage(true);
    try {
      const oilTransactions = await fetchAllOilTransactions();
      const label = activePreset === 'custom'
        ? `${dateFrom}_to_${dateTo}`
        : getPreset(activePreset).label.replace(/ /g, '_');
      exportOilUsageToExcel(oilTransactions, label);
    } catch (error) {
      console.error('Oil usage export error:', error);
    } finally {
      setExportingOilUsage(false);
    }
  };

  // ── date input style ──────────────────────────────────────────────────────
  const dateInputStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '8px',
    color: 'rgba(232,234,242,0.9)',
    padding: '7px 12px',
    fontSize: '13px',
    cursor: 'pointer',
    colorScheme: 'dark',
  };

  const presets = [
    { key: 'today',     label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: '7days',     label: '7 Days' },
    { key: '30days',    label: '30 Days' },
    { key: 'thisMonth', label: 'This Month' },
    { key: 'lastMonth', label: 'Last Month' },
    { key: 'all',       label: 'All Time' },
  ];

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading transactions...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">TRANSACTION HISTORY</h2>
          <p>Complete audit trail of all stock movements</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={handleExport}>
            📊 Export to Excel
          </button>
          <button className="btn btn-secondary" onClick={handleExportOilUsage} disabled={exportingOilUsage} title="Fragrance Library — shared oil usage across SA, SM and MUSE">
            {exportingOilUsage ? 'Exporting…' : '🧪 Export Oil Usage (by company)'}
          </button>
        </div>
      </div>

      {/* ── Date Range Picker ────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: '16px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
          {/* Preset pills */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {presets.map(p => (
              <button
                key={p.key}
                onClick={() => applyPreset(p.key)}
                style={{
                  fontSize: '12px', padding: '5px 13px', borderRadius: '20px',
                  fontWeight: '700', cursor: 'pointer', transition: 'all 0.15s',
                  border: `1px solid ${activePreset === p.key ? '#22c55e' : 'rgba(255,255,255,0.12)'}`,
                  background: activePreset === p.key ? 'rgba(34,197,94,0.15)' : 'transparent',
                  color: activePreset === p.key ? '#22c55e' : 'rgba(232,234,242,0.5)',
                  boxShadow: activePreset === p.key ? '0 0 10px rgba(34,197,94,0.25)' : 'none',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Divider */}
          <div style={{ width: '1px', height: '28px', background: 'rgba(255,255,255,0.1)' }} />

          {/* Calendar inputs */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>FROM</span>
            <input
              type="date"
              value={dateFrom}
              onChange={e => handleDateFrom(e.target.value)}
              style={dateInputStyle}
            />
            <span style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>TO</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => handleDateTo(e.target.value)}
              style={dateInputStyle}
            />
          </div>

          {/* Live count badge */}
          <div style={{ marginLeft: 'auto', fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
            <span style={{
              fontWeight: '800', fontSize: '18px',
              color: filteredTransactions.length > 0 ? '#22c55e' : 'rgba(232,234,242,0.3)',
              marginRight: '6px'
            }}>
              {filteredTransactions.length}
            </span>
            transactions
            {(dateFrom || dateTo) && (
              <span style={{ marginLeft: '6px', color: 'rgba(232,234,242,0.3)' }}>
                {dateFrom && `from ${dateFrom.split('-').reverse().join('/')}`}
                {dateFrom && dateTo && ' → '}
                {dateTo && `${dateTo.split('-').reverse().join('/')}`}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

        {/* ── Type + Category filters ──────────────────────────────────── */}
        <div style={{ marginBottom: '24px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginBottom: '8px' }}>
              Transaction Type
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {[
                { value: 'all',                label: 'All' },
                { value: 'add',                label: 'Additions' },
                { value: 'remove',             label: 'Removals' },
                { value: 'shopify_sale',       label: 'Shopify Sales' },
                { value: 'tech_transfer_out',  label: 'Tech Transfer' },
                { value: 'tech_remove',        label: 'Tech Remove' },
                { value: 'tech_return_to_main',label: 'Tech Return' },
              ].map(opt => (
                <button
                  key={opt.value}
                  className={`btn ${filter === opt.value ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFilter(opt.value)}
                  style={{ fontSize: '13px', padding: '8px 16px' }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginBottom: '8px' }}>
              Category
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {[
                { value: 'ALL',                label: 'All' },
                { value: 'OILS',               label: 'Oils' },
                { value: 'SA_SCENTED_PRODUCTS',label: 'Scented Products' },
                { value: 'MACHINES_SPARES',    label: 'Spares' },
                { value: 'SCENT_MACHINES',     label: 'Diffuser Machines' },
                { value: 'RAW_MATERIALS',      label: 'Raw Materials' },
              ].map(cat => (
                <button
                  key={cat.value}
                  className={`btn ${categoryFilter === cat.value ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setCategoryFilter(cat.value)}
                  style={{ fontSize: '13px', padding: '8px 16px' }}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Table ──────────────────────────────────────────────────────── */}
        {filteredTransactions.length === 0 ? (
          <p style={{ color: 'rgba(232,234,242,0.45)', textAlign: 'center', padding: '40px' }}>
            No transactions found for this period.
          </p>
        ) : (
          <>
            <div className="table-scroll" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date/Time</th>
                    <th>Product Code</th>
                    <th>Product Name</th>
                    <th>Category</th>
                    <th>Type</th>
                    <th>Quantity</th>
                    <th>Balance After</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransactions.map(t => (
                    <tr key={t.id}>
                      <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
                        {new Date(t.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                        {t.product_code || '-'}
                      </td>
                      <td style={{ fontWeight: '600' }}>{t.product_name || '-'}</td>
                      <td>
                        <span className="badge" style={{ fontSize: '11px' }}>
                          {getCategoryLabel(t.category)}
                        </span>
                      </td>
                      <td>
                        {(() => {
                          const techTypes = {
                            tech_transfer_out:    { label: '↗ To Tech Stock',    bg: 'rgba(251,146,60,0.15)',  border: 'rgba(251,146,60,0.4)',  color: '#fb923c' },
                            tech_transfer_in:     { label: '↙ From Main Stock',  bg: 'rgba(96,165,250,0.15)', border: 'rgba(96,165,250,0.4)',  color: '#60a5fa' },
                            tech_remove:          { label: '↘ Tech Remove',      bg: 'rgba(248,113,113,0.15)',border: 'rgba(248,113,113,0.4)', color: '#f87171' },
                            tech_return_to_main:  { label: '↖ To Main Stock',    bg: 'rgba(34,197,94,0.15)',  border: 'rgba(34,197,94,0.4)',   color: '#22c55e' },
                            tech_return_from_tech:{ label: '↗ From Tech Stock',  bg: 'rgba(52,211,153,0.15)', border: 'rgba(52,211,153,0.4)',  color: '#34d399' },
                          };
                          const tech = techTypes[t.type];
                          if (tech) return (
                            <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '4px',
                              background: tech.bg, border: `1px solid ${tech.border}`, color: tech.color }}>
                              {tech.label}
                            </span>
                          );
                          const isCredit = t.type === 'add' || t.type === 'return' || t.type === 'incoming' || t.type === 'adjust' || t.type === 'shopify_reversal';
                          return (
                            <span className={`badge ${isCredit ? 'badge-success' : 'badge-danger'}`}>
                              {t.type === 'add'              ? '+ Addition'              :
                               t.type === 'return'           ? '↩ Return'               :
                               t.type === 'incoming'         ? '📦 Incoming'            :
                               t.type === 'adjust'           ? '⚖️ Adjust'              :
                               t.type === 'shopify_sale'     ? '🛒 Shopify Sale'        :
                               t.type === 'shopify_reversal' ? '↩️ Fulfillment Reversed' :
                               '- Removal'}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ fontWeight: '700' }}>
                        {displayStock(t.quantity, t.unit)}
                      </td>
                      <td style={{ fontWeight: '600' }}>
                        {t.balance_after ? displayStock(t.balance_after, t.unit) : '—'}
                      </td>
                      <td title={t.notes || ''} style={{ maxWidth: '320px', fontSize: '13px', color: 'rgba(232,234,242,0.45)', whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.4' }}>
                        {t.notes || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {truncated && (
              <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.35)', borderRadius: 8, fontSize: 12, color: '#fbbf24' }}>
                ⚠️ Showing the most recent 5,000 transactions — older entries in this period were not loaded. Narrow the date range to see them.
              </div>
            )}

            <div style={{ marginTop: '16px', fontSize: '13px', color: 'rgba(232,234,242,0.45)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                Showing <strong style={{ color: '#22c55e' }}>{filteredTransactions.length}</strong> of <strong>{totalCount}</strong>{truncated ? '+' : ''} transactions in period
              </span>
              <button className="btn btn-secondary" onClick={handleExport} style={{ fontSize: '12px', padding: '6px 14px' }}>
                📊 Export {filteredTransactions.length} rows
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
