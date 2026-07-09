import { useState, useEffect, useCallback, useRef } from 'react';
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

// Accept: 1000 → 1000mL | 1L / 1.5L → converted to mL | 1000ml → 1000mL
const parseQtyMl = (raw) => {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  const lMatch = s.match(/^(\d+(?:\.\d+)?)l$/);
  if (lMatch) return parseFloat(lMatch[1]) * 1000;
  const mlMatch = s.match(/^(\d+(?:\.\d+)?)ml$/);
  if (mlMatch) return parseFloat(mlMatch[1]);
  const n = parseFloat(s);
  return isNaN(n) || n <= 0 ? null : n;
};

const ACTION_CONFIG = {
  transfer:       { label: '↗ Transfer',        title: 'Transfer to Tech',    color: '#22c55e' },
  remove:         { label: '↘ Remove',          title: 'Remove from Tech',    color: '#fb923c' },
  return:         { label: '↩ Return to Main',  title: 'Return to Main',      color: '#60a5fa' },
  'return-input': { label: '↙ Return Tech',     title: 'Return to Tech Pool', color: '#34d399' },
};

export default function TechStock({ user }) {
  const showToast  = useToast();
  const isRoot     = user?.role === 'root';
  const canOperate = ['technician', 'admin', 'root'].includes(user?.role);

  // ── Shared data ────────────────────────────────────────────────────────────
  const [products, setProducts] = useState([]);
  const [loading,  setLoading]  = useState(true);

  // ── Tab navigation ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'in-tech' | 'scanner'

  // ── Table view state ───────────────────────────────────────────────────────
  const [search,       setSearch]       = useState('');
  const [editTarget,   setEditTarget]   = useState(null);
  const [savingTarget, setSavingTarget] = useState(false);

  // ── Manual operation modal (table view) ───────────────────────────────────
  const [modal,      setModal]      = useState(null);
  const [qty,        setQty]        = useState('');
  const [notes,      setNotes]      = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ── Scanner tab state ──────────────────────────────────────────────────────
  const [scanInput,      setScanInput]      = useState('');
  const [scannedItems,   setScannedItems]   = useState([]);
  const [selectedAction, setSelectedAction] = useState(null);
  const [scanModal,      setScanModal]      = useState(null); // product found by scan
  const [modalQtyRaw,    setModalQtyRaw]    = useState('');
  const [scanStage,      setScanStage]      = useState('scan'); // 'scan' | 'check'
  const [batchSubmitting,setBatchSubmitting]= useState(false);
  const scanInputRef = useRef(null);
  const modalQtyRef  = useRef(null);

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

  // Re-focus scanner input when tab switches to scanner
  useEffect(() => {
    if (activeTab === 'scanner' && scanInputRef.current) {
      setTimeout(() => scanInputRef.current?.focus(), 100);
    }
  }, [activeTab]);

  // Focus modal qty input when scan modal opens
  useEffect(() => {
    if (scanModal && modalQtyRef.current) {
      setTimeout(() => modalQtyRef.current?.focus(), 100);
    }
  }, [scanModal]);

  // ── Table view: manual operation modal ────────────────────────────────────
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
      const labels = { transfer: 'Transferred', remove: 'Removed', return: 'Returned to Main', 'return-input': 'Return recorded' };
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

  // ── Scanner: barcode lookup ────────────────────────────────────────────────
  const handleScan = (e) => {
    if (e.key !== 'Enter') return;
    const code = scanInput.trim().toUpperCase();
    setScanInput('');
    if (!code) return;
    const product = products.find(p => p.productCode?.toUpperCase() === code);
    if (!product) { showToast(`Product not found: ${code}`, 'error'); return; }
    if (scannedItems.some(i => i.product.id === product.id)) {
      showToast(`${product.name} already in list`, 'error'); return;
    }
    setScanModal(product);
    setModalQtyRaw('');
  };

  // ── Scanner: confirm qty and add to list ──────────────────────────────────
  const confirmScan = () => {
    const ml = parseQtyMl(modalQtyRaw);
    if (!ml) { showToast('Enter a valid quantity (e.g. 1L, 1000, 500ml)', 'error'); return; }
    setScannedItems(prev => [...prev, { product: scanModal, quantityMl: ml }]);
    setScanModal(null);
    setModalQtyRaw('');
    setTimeout(() => scanInputRef.current?.focus(), 100);
  };

  // ── Scanner: remove item from list ────────────────────────────────────────
  const removeScannedItem = (idx) => {
    setScannedItems(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Scanner: update qty of existing item ─────────────────────────────────
  const updateScannedQty = (idx, raw) => {
    const ml = parseQtyMl(raw);
    if (!ml) return;
    setScannedItems(prev => prev.map((item, i) => i === idx ? { ...item, quantityMl: ml } : item));
  };

  // ── Scanner: proceed to check screen ─────────────────────────────────────
  const proceedToCheck = () => {
    if (scannedItems.length === 0) { showToast('Scan at least one product', 'error'); return; }
    if (!selectedAction) { showToast('Select an action', 'error'); return; }
    setScanStage('check');
  };

  // ── Scanner: batch submit ─────────────────────────────────────────────────
  const handleBatchSubmit = async () => {
    setBatchSubmitting(true);
    try {
      const res = await fetch('/api/tech-stock/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: selectedAction,
          items: scannedItems.map(i => ({ productId: i.product.id, quantity: i.quantityMl })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Batch failed', 'error'); setScanStage('check'); return; }
      showToast(`Batch complete — ${scannedItems.length} oil(s) processed`, 'success');
      setScannedItems([]);
      setSelectedAction(null);
      setScanStage('scan');
      fetchProducts();
    } catch {
      showToast('Connection error', 'error');
    } finally {
      setBatchSubmitting(false);
    }
  };

  // ── Checking screen: compute before/after per item ────────────────────────
  const checkRows = scannedItems.map(item => {
    const mainBefore = parseFloat(item.product.currentStock)  || 0;
    const techBefore = parseFloat(item.product.tech_quantity) || 0;
    let mainAfter = mainBefore;
    let techAfter = techBefore;
    if (selectedAction === 'transfer')     { mainAfter -= item.quantityMl; techAfter += item.quantityMl; }
    if (selectedAction === 'remove')       { techAfter -= item.quantityMl; }
    if (selectedAction === 'return')       { mainAfter += item.quantityMl; techAfter -= item.quantityMl; }
    if (selectedAction === 'return-input') { techAfter += item.quantityMl; }
    return { ...item, mainBefore, techBefore, mainAfter, techAfter };
  });

  // ── Table: filtered list ───────────────────────────────────────────────────
  const filtered = products.filter(p => {
    if (activeTab === 'in-tech' && (parseFloat(p.tech_quantity) || 0) <= 0) return false;
    const q = search.toLowerCase();
    return !q || p.name?.toLowerCase().includes(q) || p.productCode?.toLowerCase().includes(q);
  });

  const withTech  = products.filter(p => (parseFloat(p.tech_quantity) || 0) > 0);
  const totalTech = products.reduce((s, p) => s + (parseFloat(p.tech_quantity) || 0), 0);

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
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">TECH STOCK</h2>
          <p style={{ color: 'rgba(232,234,242,0.45)', fontSize: 13, margin: 0 }}>
            Fragrance oil pool reserved for technician use
          </p>
        </div>
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

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {[
          { id: 'all',     label: 'All' },
          { id: 'in-tech', label: 'In Tech' },
          { id: 'scanner', label: '⌖ Scanner' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: 'none', outline: 'none',
              borderTop: 'none', borderLeft: 'none', borderRight: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #60a5fa' : '2px solid transparent',
              color: activeTab === tab.id ? '#60a5fa' : 'rgba(232,234,242,0.5)',
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          TABLE VIEW (All / In Tech)
      ═══════════════════════════════════════════════════════════════════ */}
      {(activeTab === 'all' || activeTab === 'in-tech') && (<>
        {/* Search */}
        <div className="card" style={{ marginBottom: 20, position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <input className="input" type="text" placeholder="Search oils..."
            value={search} onChange={e => setSearch(e.target.value)} />
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
                      {activeTab === 'in-tech' ? 'No oils with tech stock.' : 'No oils found.'}
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
                  const isEditing  = editTarget?.productId === p.id;

                  return (
                    <tr key={p.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.productCode || '-'}</td>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td style={{ fontWeight: 700 }}>{displayStock(p.currentStock, p.unit)}</td>
                      <td>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                          background: `${sColor}18`, border: `1px solid ${sColor}55`, color: sColor }}>
                          {status}
                        </span>
                      </td>
                      <td>
                        {techQty > 0 ? (
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#fb923c',
                            background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.3)',
                            padding: '2px 10px', borderRadius: 6 }}>
                            {displayStock(techQty, p.unit)}
                          </span>
                        ) : <span style={{ color: 'rgba(232,234,242,0.25)', fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ fontWeight: 600, color: 'rgba(232,234,242,0.7)' }}>
                        {displayStock(total, p.unit)}
                      </td>

                      {/* Set Qty */}
                      <td>
                        {isRoot ? (
                          isEditing ? (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <input type="number" min="0" step="0.001" value={editTarget.value}
                                onChange={e => setEditTarget(t => ({ ...t, value: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveTarget(p.id); if (e.key === 'Escape') setEditTarget(null); }}
                                autoFocus
                                style={{ width: 80, padding: '3px 6px', fontSize: 12, borderRadius: 5,
                                  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.4)',
                                  color: 'var(--text)', outline: 'none' }}
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
                            <div onClick={() => setEditTarget({ productId: p.id, value: targetQty != null ? String(targetQty) : '' })}
                              title="Click to set target quantity"
                              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                              {targetQty != null
                                ? <span style={{ fontWeight: 700, color: '#a78bfa' }}>{displayStock(targetQty, p.unit)}</span>
                                : <span style={{ color: 'rgba(232,234,242,0.25)', fontSize: 12 }}>— set</span>}
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
                              {mainInsufficient && <span title={`Main stock (${displayStock(mainQty, p.unit)}) insufficient`} style={{ fontSize: 13 }}>⚠️</span>}
                            </div>
                          ) : <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 12 }}>✓ Full</span>
                        ) : <span style={{ color: 'rgba(232,234,242,0.2)', fontSize: 12 }}>—</span>}
                      </td>

                      {/* Actions */}
                      {canOperate && (
                        <td>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            <button className="btn btn-secondary" onClick={() => openModal('transfer', p)}
                              style={{ fontSize: 11, padding: '4px 9px', color: '#22c55e', borderColor: 'rgba(34,197,94,0.3)' }}
                              disabled={mainQty <= 0}>↗ Transfer</button>
                            {techQty > 0 && (<>
                              <button className="btn btn-secondary" onClick={() => openModal('remove', p)}
                                style={{ fontSize: 11, padding: '4px 9px', color: '#fb923c', borderColor: 'rgba(251,146,60,0.3)' }}>
                                ↘ Remove</button>
                              <button className="btn btn-secondary" onClick={() => openModal('return', p)}
                                style={{ fontSize: 11, padding: '4px 9px', color: '#60a5fa', borderColor: 'rgba(96,165,250,0.3)' }}>
                                ↩ Return to Main</button>
                            </>)}
                            <button className="btn btn-secondary" onClick={() => openModal('return-input', p)}
                              style={{ fontSize: 11, padding: '4px 9px', color: '#34d399', borderColor: 'rgba(52,211,153,0.3)' }}>
                              ↙ Return Tech</button>
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
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════
          SCANNER TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'scanner' && (<>

        {/* ── STAGE: SCAN ─────────────────────────────────────────────────── */}
        {scanStage === 'scan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Barcode input */}
            <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
              <GlowingEffect spread={40} glow={false} disabled={false} proximity={100} inactiveZone={0.1} borderWidth={1.5} />
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Barcode Scanner
                </div>
                <p style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', margin: '0 0 12px' }}>
                  Scan a barcode or type a product code and press Enter
                </p>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  ref={scanInputRef}
                  className="input"
                  type="text"
                  placeholder="Scan barcode or type code (e.g. FRAG_0003)..."
                  value={scanInput}
                  onChange={e => setScanInput(e.target.value)}
                  onKeyDown={handleScan}
                  style={{ fontSize: 15, letterSpacing: 1 }}
                />
                <button className="btn btn-secondary"
                  onClick={() => { if (scanInput.trim()) handleScan({ key: 'Enter' }); }}
                  style={{ whiteSpace: 'nowrap', padding: '0 20px' }}>
                  Add
                </button>
              </div>
            </div>

            {/* Scanned items list */}
            {scannedItems.length > 0 && (
              <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
                <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>Scanned Items ({scannedItems.length})</span>
                  <button onClick={() => { setScannedItems([]); setSelectedAction(null); }}
                    style={{ fontSize: 12, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}>
                    Clear all
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Code</th>
                        <th>Product</th>
                        <th>Quantity</th>
                        <th>Main Stock</th>
                        <th style={{ color: '#fb923c' }}>Tech Stock</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {scannedItems.map((item, idx) => (
                        <tr key={item.product.id}>
                          <td style={{ color: 'rgba(232,234,242,0.4)', fontSize: 12 }}>{idx + 1}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{item.product.productCode}</td>
                          <td style={{ fontWeight: 600 }}>{item.product.name}</td>
                          <td>
                            <span style={{ fontWeight: 700, color: '#60a5fa' }}>
                              {displayStock(item.quantityMl, item.product.unit)}
                            </span>
                          </td>
                          <td>{displayStock(item.product.currentStock, item.product.unit)}</td>
                          <td>
                            {(parseFloat(item.product.tech_quantity) || 0) > 0
                              ? <span style={{ color: '#fb923c', fontWeight: 700 }}>{displayStock(item.product.tech_quantity, item.product.unit)}</span>
                              : <span style={{ color: 'rgba(232,234,242,0.25)' }}>—</span>}
                          </td>
                          <td>
                            <button onClick={() => removeScannedItem(idx)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 16, padding: '2px 6px' }}
                              title="Remove">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Action selector + Submit */}
            <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
              <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
              <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(232,234,242,0.6)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                Select Action
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                {Object.entries(ACTION_CONFIG).map(([key, cfg]) => (
                  <button key={key}
                    onClick={() => setSelectedAction(selectedAction === key ? null : key)}
                    style={{
                      padding: '10px 18px', fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
                      background: selectedAction === key ? `${cfg.color}22` : 'rgba(128,128,128,0.06)',
                      border: `1px solid ${selectedAction === key ? cfg.color : 'var(--border)'}`,
                      color: selectedAction === key ? cfg.color : 'rgba(232,234,242,0.6)',
                      transition: 'all 0.15s',
                    }}>
                    {cfg.label}
                  </button>
                ))}
              </div>
              <button
                onClick={proceedToCheck}
                disabled={scannedItems.length === 0 || !selectedAction}
                className="btn btn-primary"
                style={{
                  padding: '12px 32px', fontSize: 14, fontWeight: 700,
                  opacity: (scannedItems.length === 0 || !selectedAction) ? 0.4 : 1,
                }}>
                Review & Submit →
              </button>
              {scannedItems.length === 0 && (
                <p style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)', margin: '10px 0 0' }}>Scan products first</p>
              )}
              {scannedItems.length > 0 && !selectedAction && (
                <p style={{ fontSize: 12, color: '#fbbf24', margin: '10px 0 0' }}>Select an action to continue</p>
              )}
            </div>
          </div>
        )}

        {/* ── STAGE: CHECKING ─────────────────────────────────────────────── */}
        {scanStage === 'check' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
              <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                    Batch Confirmation
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: ACTION_CONFIG[selectedAction]?.color }}>
                    {ACTION_CONFIG[selectedAction]?.label}
                  </div>
                  <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.5)', marginTop: 4 }}>
                    {checkRows.length} oil(s) · User: <strong style={{ color: 'rgba(232,234,242,0.8)' }}>{user?.username || user?.name || 'You'}</strong>
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12, color: 'rgba(232,234,242,0.4)' }}>
                  Review before submitting.<br/>This cannot be undone.
                </div>
              </div>

              {/* Preview table */}
              <div style={{ overflowX: 'auto', marginBottom: 24 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Qty</th>
                      <th>Main Before</th>
                      <th>Main After</th>
                      <th style={{ color: '#fb923c' }}>Tech Before</th>
                      <th style={{ color: '#fb923c' }}>Tech After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checkRows.map((row, idx) => {
                      const mainChanged = row.mainAfter !== row.mainBefore;
                      const techChanged = row.techAfter !== row.techBefore;
                      return (
                        <tr key={idx}>
                          <td>
                            <div style={{ fontWeight: 700 }}>{row.product.name}</div>
                            <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{row.product.productCode}</div>
                          </td>
                          <td>
                            <span style={{ fontWeight: 800, color: ACTION_CONFIG[selectedAction]?.color }}>
                              {displayStock(row.quantityMl, row.product.unit)}
                            </span>
                          </td>
                          <td style={{ color: mainChanged ? 'rgba(232,234,242,0.5)' : 'rgba(232,234,242,0.3)' }}>
                            {displayStock(row.mainBefore, row.product.unit)}
                          </td>
                          <td style={{ fontWeight: mainChanged ? 700 : 400, color: mainChanged ? (row.mainAfter < row.mainBefore ? '#f87171' : '#22c55e') : 'rgba(232,234,242,0.3)' }}>
                            {displayStock(row.mainAfter, row.product.unit)}
                          </td>
                          <td style={{ color: techChanged ? 'rgba(232,234,242,0.5)' : 'rgba(232,234,242,0.3)' }}>
                            {displayStock(row.techBefore, row.product.unit)}
                          </td>
                          <td style={{ fontWeight: techChanged ? 700 : 400, color: techChanged ? (row.techAfter > row.techBefore ? '#fb923c' : '#60a5fa') : 'rgba(232,234,242,0.3)' }}>
                            {displayStock(row.techAfter, row.product.unit)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => setScanStage('scan')}
                  disabled={batchSubmitting}
                  style={{ flex: 1, padding: '12px 0', fontSize: 14 }}>
                  ← Cancel (Back to List)
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleBatchSubmit}
                  disabled={batchSubmitting}
                  style={{
                    flex: 2, padding: '12px 0', fontSize: 14, fontWeight: 700,
                    background: `${ACTION_CONFIG[selectedAction]?.color}22`,
                    color: ACTION_CONFIG[selectedAction]?.color,
                    border: `1px solid ${ACTION_CONFIG[selectedAction]?.color}55`,
                  }}>
                  {batchSubmitting ? 'Processing...' : `Confirm — ${ACTION_CONFIG[selectedAction]?.label} (${checkRows.length} oils)`}
                </button>
              </div>
            </div>
          </div>
        )}
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════
          MANUAL OPERATION MODAL (table view)
      ═══════════════════════════════════════════════════════════════════ */}
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
              <div style={{ background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 14px', marginBottom: 18, display: 'flex', gap: 24 }}>
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
                <div style={{ fontSize: 12, color: 'rgba(52,211,153,0.7)', background: 'rgba(52,211,153,0.08)',
                  border: '1px solid rgba(52,211,153,0.2)', borderRadius: 6, padding: '8px 12px', marginBottom: 16 }}>
                  Technician returning unused oil — stock stays in Tech (Main Stock not affected)
                </div>
              )}
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Quantity ({modal.product.unit})</label>
                  <input className="input" type="number" min="0.001"
                    max={maxQty === Infinity ? undefined : maxQty}
                    step="0.001" value={qty} onChange={e => setQty(e.target.value)}
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

      {/* ═══════════════════════════════════════════════════════════════════
          SCAN MODAL — product found, enter qty
      ═══════════════════════════════════════════════════════════════════ */}
      {scanModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <div className="card" style={{ width: '100%', maxWidth: 420, border: '1px solid rgba(96,165,250,0.3)', boxShadow: '0 0 40px rgba(96,165,250,0.1)' }}>
            {/* Product info */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Product Scanned
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>{scanModal.name}</div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#60a5fa' }}>{scanModal.productCode}</div>
            </div>

            {/* Stock grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 20 }}>
              {[
                { label: 'Main Stock',  value: displayStock(scanModal.currentStock, scanModal.unit),  color: '#22c55e' },
                { label: 'Tech Stock',  value: displayStock(scanModal.tech_quantity, scanModal.unit), color: '#fb923c' },
                { label: 'Set Target', value: scanModal.target_quantity != null ? displayStock(scanModal.target_quantity, scanModal.unit) : '—', color: '#a78bfa' },
              ].map(cell => (
                <div key={cell.label} style={{ background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: cell.color }}>{cell.value}</div>
                  <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>{cell.label}</div>
                </div>
              ))}
            </div>

            {/* Qty input */}
            <div className="form-group">
              <label style={{ fontSize: 13 }}>Quantity <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: 400 }}>(mL, L, e.g. 1L, 500, 500ml)</span></label>
              <input
                ref={modalQtyRef}
                className="input"
                type="text"
                placeholder="e.g. 1L, 2000, 500ml"
                value={modalQtyRaw}
                onChange={e => setModalQtyRaw(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmScan(); if (e.key === 'Escape') { setScanModal(null); setTimeout(() => scanInputRef.current?.focus(), 100); } }}
              />
              {/* Inline conversion hint */}
              {modalQtyRaw && (() => {
                const ml = parseQtyMl(modalQtyRaw);
                if (!ml) return null;
                const L = ml / 1000;
                return (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6,
                    padding: '4px 10px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)',
                    borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#10b981' }}>
                    {ml.toLocaleString()} mL = <strong style={{ color: '#34d399' }}>{parseFloat(L.toFixed(3))} L</strong>
                  </div>
                );
              })()}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button className="btn btn-secondary"
                onClick={() => { setScanModal(null); setTimeout(() => scanInputRef.current?.focus(), 100); }}
                style={{ flex: 1 }}>
                Close
              </button>
              <button className="btn btn-primary"
                onClick={confirmScan}
                disabled={!parseQtyMl(modalQtyRaw)}
                style={{ flex: 2, background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }}>
                Confirm → Add to List
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
