import { useState, useEffect, useRef, useCallback } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';
import { PackageOpen, ArchiveRestore, Plus, X, Pencil, Check } from 'lucide-react';

// Flexible qty parser: 1L / 1.5L / 1000 / 500ml → mL value
const parseQtyMl = (raw) => {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  const lMatch = s.match(/^(\d+(?:\.\d+)?)l$/);
  if (lMatch) return parseFloat(lMatch[1]) * 1000;
  const mlMatch = s.match(/^(\d+(?:\.\d+)?)ml$/);
  if (mlMatch) return parseFloat(mlMatch[1]);
  const n = parseFloat(s);
  return isNaN(n) || n <= 0 ? null : n;
};

const parseQtyForUnit = (raw, unit) => {
  if (unit === 'mL') return parseQtyMl(raw);
  const n = parseFloat(raw);
  return isNaN(n) || n <= 0 ? null : n;
};

const fmtQty = (val, unit) => {
  if (unit === 'mL') return `${(val / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`;
  return `${Number(val).toLocaleString('en-AU', { maximumFractionDigits: 3 })} ${unit}`;
};

const fmtEditDefault = (qty, unit) => {
  if (unit === 'mL') {
    const l = qty / 1000;
    return Number.isInteger(l) ? `${l}L` : `${qty}`;
  }
  return `${qty}`;
};

export default function ProductReturns({ user }) {
  const showToast = useToast();

  // ── Tab ────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('manual');

  // ── Shared data ────────────────────────────────────────────────────────────
  const [products, setProducts] = useState([]);
  const [formulas, setFormulas] = useState([]);
  const [loading,  setLoading]  = useState(true);

  // ── Manual tab state ───────────────────────────────────────────────────────
  const [confirmState,    setConfirmState]    = useState(null);
  const [searchTerm,      setSearchTerm]      = useState('');
  const [categoryFilter,  setCategoryFilter]  = useState('ALL');
  const [cart,            setCart]            = useState(new Map());
  const [notes,           setNotes]           = useState('');
  const [returnedBy,      setReturnedBy]      = useState('');
  const [processing,      setProcessing]      = useState(false);
  const [qtyModal,        setQtyModal]        = useState({ open: false, product: null, value: '' });

  // ── Scanner tab state ──────────────────────────────────────────────────────
  const [scanInput,        setScanInput]        = useState('');
  const [scanItems,        setScanItems]        = useState([]); // [{product, quantity}] — allows duplicates
  const [scanModal,        setScanModal]        = useState(null);
  const [modalQtyRaw,      setModalQtyRaw]      = useState('');
  const [scanStage,        setScanStage]        = useState('scan'); // 'scan' | 'check'
  const [scanReturnedBy,   setScanReturnedBy]   = useState('');
  const [scanNotes,        setScanNotes]        = useState('');
  const [batchProcessing,  setBatchProcessing]  = useState(false);
  // Inline editing on check screen
  const [checkEdits,       setCheckEdits]       = useState({}); // { [productId]: number (overridden qty) }
  const [editingCheckId,   setEditingCheckId]   = useState(null);
  const [editingCheckRaw,  setEditingCheckRaw]  = useState('');

  const scanInputRef = useRef(null);
  const modalQtyRef  = useRef(null);
  const editInputRef = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const [pRes, fRes] = await Promise.all([fetch('/api/products'), fetch('/api/formulas')]);
      const pData = await pRes.json();
      const fData = await fRes.json();
      setProducts(Array.isArray(pData) ? pData : []);
      setFormulas(Array.isArray(fData) ? fData : []);
    } catch (e) {
      console.error('Error fetching data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    if (activeTab === 'scanner' && scanInputRef.current) {
      setTimeout(() => scanInputRef.current?.focus(), 100);
    }
  }, [activeTab]);

  useEffect(() => {
    if (scanModal && modalQtyRef.current) {
      setTimeout(() => modalQtyRef.current?.focus(), 100);
    }
  }, [scanModal]);

  useEffect(() => {
    if (editingCheckId && editInputRef.current) {
      setTimeout(() => editInputRef.current?.focus(), 80);
    }
  }, [editingCheckId]);

  // ── Virtual formula items ──────────────────────────────────────────────────
  const formulaItems = formulas.map(f => ({
    id: `formula_${f.id}`,
    _isFormula: true,
    _formulaId: f.id,
    name: f.name,
    productCode: f.product_code,
    tag: f.tag,
    category: 'FORMULA',
    unit: 'mL',
    currentStock: parseFloat(f.ready_stock_ml) || 0,
    color: null,
    shopifySkus: {}
  }));

  const allItems = [...products, ...formulaItems];

  // ── Grouped check rows (for check screen) ─────────────────────────────────
  const groupedCheckRows = (() => {
    const groups = new Map();
    scanItems.forEach(item => {
      const id = item.product.id;
      if (!groups.has(id)) {
        groups.set(id, { product: item.product, entries: [], totalQty: 0 });
      }
      const g = groups.get(id);
      g.entries.push(item);
      g.totalQty += item.quantity;
    });
    return Array.from(groups.values()).map(g => {
      const editedQty = checkEdits[g.product.id];
      const finalQty  = editedQty !== undefined ? editedQty : g.totalQty;
      const before    = parseFloat(g.product.currentStock) || 0;
      return { ...g, finalQty, before, after: before + finalQty };
    });
  })();

  // Scan count per product (for scan list badges)
  const scanCounts = scanItems.reduce((acc, item) => {
    acc[item.product.id] = (acc[item.product.id] || 0) + 1;
    return acc;
  }, {});

  // ── Manual tab: filters ────────────────────────────────────────────────────
  const filteredProducts = allItems.filter(p => {
    if (categoryFilter === 'FORMULA') return p.category === 'FORMULA';
    if (categoryFilter !== 'ALL' && p.category !== categoryFilter) return false;
    if (categoryFilter === 'ALL' && p.category === 'FORMULA' && !searchTerm) return false;
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return (
      (p.name?.toLowerCase() ?? '').includes(s) ||
      (p.productCode?.toLowerCase() ?? '').includes(s) ||
      (p.tag?.toLowerCase() ?? '').includes(s) ||
      (p.color?.toLowerCase() ?? '').includes(s)
    );
  });

  // ── Manual tab: cart ───────────────────────────────────────────────────────
  const addToCart = (product) => {
    if (cart.has(product.id)) return;
    setQtyModal({ open: true, product, value: '' });
  };

  const confirmQtyModal = () => {
    const qty = parseFloat(qtyModal.value);
    if (!qtyModal.value || isNaN(qty) || qty <= 0)
      return showToast('Enter a valid quantity', 'warning');
    const next = new Map(cart);
    next.set(qtyModal.product.id, String(qty));
    setCart(next);
    setQtyModal({ open: false, product: null, value: '' });
  };

  const removeFromCart = (productId) => {
    const next = new Map(cart); next.delete(productId); setCart(next);
  };

  const setQty = (productId, val) => {
    const next = new Map(cart); next.set(productId, val); setCart(next);
  };

  const cartProducts = Array.from(cart.entries()).map(([id, qty]) => ({
    product: allItems.find(p => p.id === id), qty
  })).filter(x => x.product);

  // ── Manual tab: process ────────────────────────────────────────────────────
  const handleProcess = async () => {
    if (cart.size === 0) return showToast('Add at least one item to the list', 'warning');
    if (!returnedBy.trim()) return showToast('Enter the name of the person processing the return', 'warning');
    const invalid = cartProducts.filter(({ qty }) => !qty || parseFloat(qty) <= 0);
    if (invalid.length > 0)
      return showToast(`Enter valid quantities for: ${invalid.map(x => x.product.name).join(', ')}`, 'warning');

    const formulaEntries = cartProducts.filter(({ product }) => product._isFormula);
    const productEntries = cartProducts.filter(({ product }) => !product._isFormula);

    setConfirmState({
      message: `Process restock for ${cart.size} item(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        setProcessing(true);
        let successCount = 0;
        try {
          if (productEntries.length > 0) {
            const res = await fetch('/api/returns', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                items: productEntries.map(({ product, qty }) => ({ productId: product.id, quantity: parseFloat(qty) })),
                notes: notes.trim(),
                returnedBy: returnedBy.trim()
              })
            });
            if (res.ok) {
              const data = await res.json();
              successCount += data.processedCount || productEntries.length;
            } else {
              const err = await res.json();
              showToast(`Product restock error: ${err.error || 'Failed'}`, 'error');
            }
          }
          for (const { product, qty } of formulaEntries) {
            const res = await fetch(`/api/formulas/${product._formulaId}/ready-stock/receive`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ quantityMl: parseFloat(qty), notes: notes.trim(), userId: user?.id })
            });
            if (res.ok) { successCount++; }
            else {
              const err = await res.json();
              showToast(`Formula error (${product.name}): ${err.error || 'Failed'}`, 'error');
            }
          }
          if (successCount > 0) {
            showToast(`Successfully restocked ${successCount} item(s)!`, 'success');
            setCart(new Map()); setNotes(''); setReturnedBy(''); setSearchTerm('');
            fetchAll();
          }
        } catch { showToast('Connection error', 'error'); }
        finally { setProcessing(false); }
      }
    });
  };

  // ── Scanner: barcode lookup — ALLOWS SAME PRODUCT MULTIPLE TIMES ──────────
  const handleScan = (e) => {
    if (e.key !== 'Enter') return;
    const code = scanInput.trim().toUpperCase();
    setScanInput('');
    if (!code) return;
    const product = allItems.find(p => p.productCode?.toUpperCase() === code);
    if (!product) { showToast(`Product not found: ${code}`, 'error'); return; }
    setScanModal(product);
    setModalQtyRaw('');
  };

  // ── Scanner: confirm qty ───────────────────────────────────────────────────
  const confirmScan = () => {
    const qty = parseQtyForUnit(modalQtyRaw, scanModal.unit);
    if (!qty) { showToast('Enter a valid quantity (e.g. 1L, 500ml, 1000)', 'error'); return; }
    setScanItems(prev => [...prev, { product: scanModal, quantity: qty }]);
    setScanModal(null);
    setModalQtyRaw('');
    setTimeout(() => scanInputRef.current?.focus(), 100);
  };

  const removeScanItem = (idx) => setScanItems(prev => prev.filter((_, i) => i !== idx));

  const clearScanner = () => {
    setScanItems([]);
    setCheckEdits({});
    setEditingCheckId(null);
    setEditingCheckRaw('');
    setScanStage('scan');
  };

  // ── Check screen: inline edit ──────────────────────────────────────────────
  const startEdit = (row) => {
    setEditingCheckId(row.product.id);
    setEditingCheckRaw(fmtEditDefault(row.finalQty, row.product.unit));
  };

  const commitEdit = (productId, unit) => {
    const q = parseQtyForUnit(editingCheckRaw, unit);
    if (q && q > 0) {
      setCheckEdits(prev => ({ ...prev, [productId]: q }));
    }
    setEditingCheckId(null);
    setEditingCheckRaw('');
  };

  const cancelEdit = () => {
    setEditingCheckId(null);
    setEditingCheckRaw('');
  };

  // ── Scanner: batch submit (uses grouped + edited quantities) ──────────────
  const handleBatchSubmit = async () => {
    if (!scanReturnedBy.trim()) { showToast('Enter the name of the person processing the return', 'warning'); return; }
    setBatchProcessing(true);
    let successCount = 0;
    try {
      const formulaRows  = groupedCheckRows.filter(r => r.product._isFormula);
      const productRows  = groupedCheckRows.filter(r => !r.product._isFormula);

      if (productRows.length > 0) {
        const res = await fetch('/api/returns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: productRows.map(r => ({ productId: r.product.id, quantity: r.finalQty })),
            notes: scanNotes.trim(),
            returnedBy: scanReturnedBy.trim()
          })
        });
        if (res.ok) {
          const data = await res.json();
          successCount += data.processedCount || productRows.length;
        } else {
          const err = await res.json();
          showToast(`Restock error: ${err.error || 'Failed'}`, 'error');
          setBatchProcessing(false); return;
        }
      }

      for (const r of formulaRows) {
        const res = await fetch(`/api/formulas/${r.product._formulaId}/ready-stock/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantityMl: r.finalQty, notes: scanNotes.trim(), userId: user?.id })
        });
        if (res.ok) { successCount++; }
        else {
          const err = await res.json();
          showToast(`Formula error (${r.product.name}): ${err.error || 'Failed'}`, 'error');
        }
      }

      if (successCount > 0) {
        showToast(`Successfully restocked ${successCount} item(s)!`, 'success');
        clearScanner();
        setScanReturnedBy('');
        setScanNotes('');
        fetchAll();
      }
    } catch { showToast('Connection error', 'error'); }
    finally { setBatchProcessing(false); }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getCategoryLabel = (cat) => ({
    OILS: 'Oils', RAW_MATERIALS: 'Raw Materials',
    MACHINES_SPARES: 'Spares', SCENT_MACHINES: 'Diffuser Machines'
  }[cat] || cat);

  const getCategoryColor = (cat) => ({
    OILS: '#818cf8', RAW_MATERIALS: '#f59e0b',
    MACHINES_SPARES: '#94a3b8', SCENT_MACHINES: '#38bdf8'
  }[cat] || '#94a3b8');

  const uniqueScanCount = new Set(scanItems.map(i => i.product.id)).size;

  if (loading) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading products…</div>
  );

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1600, margin: '0 auto' }}>
      {confirmState && <ConfirmModal {...confirmState} onCancel={() => setConfirmState(null)} />}

      {/* Quantity modal (manual tab) */}
      {qtyModal.open && qtyModal.product && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => setQtyModal({ open: false, product: null, value: '' })}>
          <div style={{
            background: 'var(--card-bg)', border: '1px solid var(--border)',
            borderRadius: 16, padding: '28px 32px', width: 360, maxWidth: '90vw',
            boxShadow: '0 24px 64px rgba(0,0,0,0.35)'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#10b981', marginBottom: 6 }}>Add to Restock List</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>{qtyModal.product.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {qtyModal.product.productCode}
                {qtyModal.product._isFormula
                  ? <> · Ready stock: <strong style={{ color: '#818cf8' }}>{(qtyModal.product.currentStock / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L</strong></>
                  : <> · Current stock: <strong style={{ color: 'var(--text-secondary)' }}>{parseFloat(qtyModal.product.currentStock).toLocaleString()} {qtyModal.product.unit}</strong></>
                }
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>
                {qtyModal.product._isFormula ? 'Quantity received (mL)' : `Quantity to restock (${qtyModal.product.unit})`}
              </label>
              <input autoFocus type="number" className="input" value={qtyModal.value}
                onChange={e => setQtyModal(m => ({ ...m, value: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') confirmQtyModal(); if (e.key === 'Escape') setQtyModal({ open: false, product: null, value: '' }); }}
                placeholder={qtyModal.product._isFormula ? 'e.g. 5000' : 'e.g. 10'} min="0"
                style={{ fontSize: 20, fontWeight: 700, textAlign: 'center', padding: '12px 16px' }} />
              {qtyModal.value && parseFloat(qtyModal.value) > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>
                  {qtyModal.product._isFormula
                    ? <>After restock: <strong style={{ color: '#818cf8' }}>{((qtyModal.product.currentStock + parseFloat(qtyModal.value)) / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L</strong></>
                    : <>After restock: <strong style={{ color: '#10b981' }}>{(parseFloat(qtyModal.product.currentStock) + parseFloat(qtyModal.value)).toLocaleString()} {qtyModal.product.unit}</strong></>
                  }
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setQtyModal({ open: false, product: null, value: '' })} style={{
                flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>Cancel</button>
              <button onClick={confirmQtyModal} style={{
                flex: 2, padding: '10px 0', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                background: '#10b981', border: '1px solid rgba(16,185,129,0.5)', color: '#fff' }}>Add to List</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
          <ArchiveRestore size={22} style={{ marginRight: 10, verticalAlign: 'middle', color: '#10b981' }} />
          Product Returns / Restock
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 13 }}>
          Search and add products on the left — review quantities on the right before processing
        </p>
      </div>

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        {[
          { id: 'manual',  label: 'Manual' },
          { id: 'scanner', label: '⌖ Scanner' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: 'none', outline: 'none',
            borderTop: 'none', borderLeft: 'none', borderRight: 'none',
            borderBottom: activeTab === tab.id ? '2px solid #10b981' : '2px solid transparent',
            color: activeTab === tab.id ? '#10b981' : 'rgba(232,234,242,0.5)',
            transition: 'all 0.15s',
          }}>{tab.label}</button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          MANUAL TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'manual' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 460px', gap: 24, alignItems: 'start' }}>

          {/* LEFT */}
          <div>
            <div className="card" style={{ marginBottom: 16, position: 'relative', overflow: 'visible' }}>
              <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <input type="text" className="input" placeholder="🔍 Search by name, code, colour or SKU…"
                  value={searchTerm} onChange={e => setSearchTerm(e.target.value)} autoFocus />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)'
                  }}>×</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { value: 'ALL',             label: 'All' },
                  { value: 'OILS',            label: 'Oils' },
                  { value: 'SCENT_MACHINES',  label: 'Diffuser Machines' },
                  { value: 'MACHINES_SPARES', label: 'Spares' },
                  { value: 'RAW_MATERIALS',   label: 'Raw Materials' },
                  { value: 'FORMULA',         label: '🧪 Formulas' },
                ].map(cat => (
                  <button key={cat.value} onClick={() => setCategoryFilter(cat.value)} style={{
                    padding: '6px 14px', fontSize: 12, borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s',
                    border: categoryFilter === cat.value
                      ? cat.value === 'FORMULA' ? '1px solid rgba(129,140,248,0.6)' : '1px solid rgba(16,185,129,0.6)'
                      : '1px solid var(--border)',
                    background: categoryFilter === cat.value
                      ? cat.value === 'FORMULA' ? 'rgba(129,140,248,0.12)' : 'rgba(16,185,129,0.12)'
                      : 'transparent',
                    color: categoryFilter === cat.value
                      ? cat.value === 'FORMULA' ? '#818cf8' : '#10b981'
                      : 'var(--text-secondary)',
                    fontWeight: categoryFilter === cat.value ? 700 : 400
                  }}>{cat.label}</button>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                {filteredProducts.length} item(s) · {cart.size} in restock list
                {categoryFilter === 'FORMULA' && (
                  <span style={{ marginLeft: 8, color: '#818cf8' }}>· Ready formula stock — received from technicians</span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '74vh', overflowY: 'auto', paddingRight: 4 }}>
              {filteredProducts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No products found</div>
              ) : filteredProducts.map(product => {
                const inCart = cart.has(product.id);
                return (
                  <div key={product.id} style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 10,
                    background: inCart ? 'rgba(16,185,129,0.06)' : 'var(--card-bg)',
                    border: inCart ? '1px solid rgba(16,185,129,0.35)' : '1px solid var(--border)',
                    transition: 'all 0.15s', position: 'relative', overflow: 'visible'
                  }}>
                    <div style={{ width: 3, height: 36, borderRadius: 2, flexShrink: 0, background: getCategoryColor(product.category) }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{product.name}</span>
                        {product._isFormula ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#818cf8',
                            background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.3)',
                            borderRadius: 5, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 3 }}>🧪 Formula</span>
                        ) : (
                          <span style={{ fontSize: 10, fontWeight: 700, color: getCategoryColor(product.category),
                            background: `${getCategoryColor(product.category)}18`,
                            border: `1px solid ${getCategoryColor(product.category)}33`,
                            borderRadius: 5, padding: '1px 6px' }}>{getCategoryLabel(product.category)}</span>
                        )}
                        {product.color && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: product.color.toLowerCase(), border: '1px solid rgba(255,255,255,0.2)' }} />
                            {product.color}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                        {product.productCode}
                        {product._isFormula
                          ? <> · Ready: <strong style={{ color: '#818cf8' }}>{(product.currentStock / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L</strong></>
                          : <> · Stock: <strong style={{ color: 'var(--text-secondary)' }}>{parseFloat(product.currentStock).toLocaleString()} {product.unit}</strong></>
                        }
                      </div>
                    </div>
                    <button onClick={() => addToCart(product)} disabled={inCart} style={{
                      flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
                      padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: inCart ? 'default' : 'pointer',
                      border: '1px solid rgba(16,185,129,0.5)',
                      background: inCart ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.15)',
                      color: '#10b981', transition: 'all 0.15s'
                    }}>
                      {inCart ? '✓ Added' : <><Plus size={13} /> Add</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT: cart */}
          <div style={{ position: 'sticky', top: 24 }}>
            <div className="card" style={{ position: 'relative', overflow: 'visible', borderLeft: '3px solid #10b981' }}>
              <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(16,185,129,0.12)',
                    border: '1px solid rgba(16,185,129,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ArchiveRestore size={18} color="#10b981" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>Restock List</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cart.size} item{cart.size !== 1 ? 's' : ''}</div>
                  </div>
                </div>
                {cart.size > 0 && (
                  <button onClick={() => setCart(new Map())} style={{
                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)', padding: '4px 8px'
                  }}>Clear all</button>
                )}
              </div>

              {cart.size === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                  <PackageOpen size={36} style={{ opacity: 0.25, marginBottom: 12 }} />
                  <div style={{ fontSize: 13 }}>No products added yet</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>Click "Add" on the left</div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20,
                    maxHeight: '52vh', overflowY: 'auto', paddingRight: 2 }}>
                    {cartProducts.map(({ product, qty }) => (
                      <div key={product.id} style={{
                        padding: '10px 12px', borderRadius: 8,
                        background: product._isFormula ? 'rgba(129,140,248,0.06)' : 'rgba(16,185,129,0.06)',
                        border: product._isFormula ? '1px solid rgba(129,140,248,0.25)' : '1px solid rgba(16,185,129,0.2)'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {product._isFormula && <span style={{ fontSize: 10, marginRight: 5 }}>🧪</span>}
                              {product.name}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                              {product.productCode}
                              {product._isFormula
                                ? <> · Ready: <strong style={{ color: '#818cf8' }}>{(product.currentStock / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L</strong></>
                                : <> · {parseFloat(product.currentStock).toLocaleString()} {product.unit}</>
                              }
                            </div>
                          </div>
                          <button onClick={() => removeFromCart(product.id)} style={{
                            flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2
                          }}><X size={14} /></button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                          <input type="number" className="input" value={qty}
                            onChange={e => setQty(product.id, e.target.value)}
                            placeholder={product._isFormula ? 'mL received' : 'Qty'} min="0"
                            style={{ flex: 1, fontSize: 14, fontWeight: 700, padding: '6px 10px' }} />
                          <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0,
                            color: product._isFormula ? '#818cf8' : '#10b981' }}>{product.unit}</span>
                          {qty && parseFloat(qty) > 0 && !product._isFormula && (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                              → {(parseFloat(product.currentStock) + parseFloat(qty)).toLocaleString()}
                            </span>
                          )}
                          {qty && parseFloat(qty) > 0 && product._isFormula && (
                            <span style={{ fontSize: 11, color: '#818cf8', flexShrink: 0 }}>
                              +{(parseFloat(qty) / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 14 }}>
                    <div className="form-group" style={{ marginBottom: 12 }}>
                      <label className="label">{cartProducts.some(x => x.product._isFormula) ? 'Received By *' : 'Returned By *'}</label>
                      <input type="text" className="input" value={returnedBy} onChange={e => setReturnedBy(e.target.value)} placeholder="Your name" />
                    </div>
                    <div className="form-group" style={{ marginBottom: 16 }}>
                      <label className="label">Notes (optional)</label>
                      <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                        placeholder="e.g. Returned from customer…" style={{ resize: 'none' }} />
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={handleProcess} disabled={processing}
                    style={{ width: '100%', background: '#10b981', border: '1px solid rgba(16,185,129,0.5)', fontSize: 14 }}>
                    {processing ? 'Processing…' : `✓ Process ${cart.size} Restock${cart.size !== 1 ? 's' : ''}`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          SCANNER TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'scanner' && (<>

        {/* ── STAGE: SCAN ─────────────────────────────────────────────────── */}
        {scanStage === 'scan' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 24, alignItems: 'start' }}>

            {/* LEFT */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Barcode input */}
              <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
                <GlowingEffect spread={40} glow={false} disabled={false} proximity={100} inactiveZone={0.1} borderWidth={1.5} />
                <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Barcode Scanner
                </div>
                <p style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', margin: '0 0 10px' }}>
                  Same product can be scanned multiple times — quantities are combined on review
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input ref={scanInputRef} className="input" type="text"
                    placeholder="Scan barcode or type code (e.g. FRAG_0003)…"
                    value={scanInput} onChange={e => setScanInput(e.target.value)} onKeyDown={handleScan}
                    style={{ fontSize: 15, letterSpacing: 1 }} />
                  <button className="btn btn-secondary"
                    onClick={() => { if (scanInput.trim()) handleScan({ key: 'Enter' }); }}
                    style={{ whiteSpace: 'nowrap', padding: '0 20px' }}>Add</button>
                </div>
              </div>

              {/* Scanned list */}
              {scanItems.length > 0 && (
                <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
                  <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>Scan Log</span>
                      <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', marginLeft: 10 }}>
                        {scanItems.length} scan{scanItems.length !== 1 ? 's' : ''} · {uniqueScanCount} unique product{uniqueScanCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <button onClick={clearScanner}
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
                          <th>Qty</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {scanItems.map((item, idx) => {
                          const isDup = scanCounts[item.product.id] > 1;
                          return (
                            <tr key={idx} style={{ background: isDup ? 'rgba(250,204,21,0.04)' : undefined }}>
                              <td style={{ color: 'rgba(232,234,242,0.4)', fontSize: 12 }}>{idx + 1}</td>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{item.product.productCode}</td>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                  <span style={{ fontWeight: 600 }}>
                                    {item.product._isFormula && <span style={{ fontSize: 10, marginRight: 4 }}>🧪</span>}
                                    {item.product.name}
                                  </span>
                                  {isDup && (
                                    <span style={{
                                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                                      background: 'rgba(250,204,21,0.15)', color: '#facc15',
                                      border: '1px solid rgba(250,204,21,0.3)'
                                    }}>×{scanCounts[item.product.id]}</span>
                                  )}
                                </div>
                              </td>
                              <td>
                                <span style={{ fontWeight: 700, color: '#10b981' }}>{fmtQty(item.quantity, item.product.unit)}</span>
                              </td>
                              <td>
                                <button onClick={() => removeScanItem(idx)}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(248,113,113,0.6)', fontSize: 15, padding: '2px 6px' }}>✕</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: submit panel */}
            <div style={{ position: 'sticky', top: 24 }}>
              <div className="card" style={{ position: 'relative', overflow: 'visible', borderLeft: '3px solid #10b981' }}>
                <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(16,185,129,0.12)',
                    border: '1px solid rgba(16,185,129,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ArchiveRestore size={18} color="#10b981" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>Restock Queue</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {uniqueScanCount} product{uniqueScanCount !== 1 ? 's' : ''} · {scanItems.length} scan{scanItems.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>

                {scanItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--text-muted)' }}>
                    <PackageOpen size={32} style={{ opacity: 0.25, marginBottom: 10 }} />
                    <div style={{ fontSize: 13 }}>Scan products to begin</div>
                    <div style={{ fontSize: 12, marginTop: 4, color: 'rgba(232,234,242,0.3)' }}>Same product can be scanned multiple times</div>
                  </div>
                ) : (<>
                  <div className="form-group" style={{ marginBottom: 12 }}>
                    <label className="label">Returned By *</label>
                    <input type="text" className="input" value={scanReturnedBy}
                      onChange={e => setScanReturnedBy(e.target.value)} placeholder="Your name" />
                  </div>
                  <div className="form-group" style={{ marginBottom: 20 }}>
                    <label className="label">Notes (optional)</label>
                    <textarea className="input" rows={2} value={scanNotes}
                      onChange={e => setScanNotes(e.target.value)}
                      placeholder="e.g. Returned from customer…" style={{ resize: 'none' }} />
                  </div>
                  <button
                    onClick={() => {
                      if (!scanReturnedBy.trim()) { showToast('Enter the name of the person processing the return', 'warning'); return; }
                      setEditingCheckId(null); setEditingCheckRaw('');
                      setScanStage('check');
                    }}
                    className="btn btn-primary"
                    style={{ width: '100%', background: '#10b981', border: '1px solid rgba(16,185,129,0.5)', fontSize: 14, padding: '12px 0' }}>
                    Review & Confirm →
                  </button>
                </>)}
              </div>
            </div>
          </div>
        )}

        {/* ── STAGE: CHECKING ─────────────────────────────────────────────── */}
        {scanStage === 'check' && (
          <div className="card" style={{ position: 'relative', overflow: 'visible', maxWidth: 960 }}>
            <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                  Review Before Submitting
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#10b981' }}>
                  ↩ Restock — {groupedCheckRows.length} product{groupedCheckRows.length !== 1 ? 's' : ''} ({scanItems.length} scan{scanItems.length !== 1 ? 's' : ''})
                </div>
                <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.5)', marginTop: 4 }}>
                  Returned by: <strong style={{ color: 'rgba(232,234,242,0.8)' }}>{scanReturnedBy}</strong>
                  {scanNotes && <> · {scanNotes}</>}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.35)', textAlign: 'right', lineHeight: 1.6 }}>
                Click <Pencil size={11} style={{ verticalAlign: 'middle', display: 'inline' }} /> to adjust a quantity.<br />
                This cannot be undone.
              </div>
            </div>

            {/* Table */}
            <div style={{ overflowX: 'auto', marginBottom: 24 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th style={{ textAlign: 'center' }}>Times Scanned</th>
                    <th>Individual Scans</th>
                    <th>Total to Restock</th>
                    <th></th>
                    <th>Stock Before</th>
                    <th style={{ color: '#10b981' }}>Stock After</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedCheckRows.map((row) => {
                    const isEditing = editingCheckId === row.product.id;
                    const wasEdited = checkEdits[row.product.id] !== undefined;
                    return (
                      <tr key={row.product.id}>
                        {/* Product */}
                        <td>
                          <div style={{ fontWeight: 700 }}>
                            {row.product._isFormula && <span style={{ fontSize: 10, marginRight: 4 }}>🧪</span>}
                            {row.product.name}
                          </div>
                          <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>
                            {row.product.productCode}
                          </div>
                        </td>

                        {/* Times scanned */}
                        <td style={{ textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block', padding: '3px 10px', borderRadius: 20,
                            fontSize: 13, fontWeight: 800,
                            background: row.entries.length > 1 ? 'rgba(250,204,21,0.12)' : 'rgba(16,185,129,0.08)',
                            color: row.entries.length > 1 ? '#facc15' : 'rgba(232,234,242,0.5)',
                            border: row.entries.length > 1 ? '1px solid rgba(250,204,21,0.25)' : '1px solid rgba(255,255,255,0.06)',
                          }}>×{row.entries.length}</span>
                        </td>

                        {/* Individual scan chips */}
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {row.entries.map((entry, i) => (
                              <span key={i} style={{
                                fontSize: 11, padding: '2px 8px', borderRadius: 6,
                                background: 'rgba(128,128,128,0.1)', border: '1px solid rgba(255,255,255,0.07)',
                                color: 'rgba(232,234,242,0.55)', fontWeight: 600
                              }}>{fmtQty(entry.quantity, entry.product.unit)}</span>
                            ))}
                          </div>
                        </td>

                        {/* Total qty (editable) */}
                        <td style={{ minWidth: 130 }}>
                          {isEditing ? (
                            <input
                              ref={editInputRef}
                              className="input"
                              value={editingCheckRaw}
                              onChange={e => setEditingCheckRaw(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitEdit(row.product.id, row.product.unit);
                                if (e.key === 'Escape') cancelEdit();
                              }}
                              placeholder={row.product.unit === 'mL' ? '1L, 500ml…' : 'qty'}
                              style={{ fontSize: 13, padding: '5px 8px', width: 110 }}
                            />
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontWeight: 800, fontSize: 15, color: wasEdited ? '#facc15' : '#10b981' }}>
                                {fmtQty(row.finalQty, row.product.unit)}
                              </span>
                              {wasEdited && (
                                <span style={{ fontSize: 10, color: '#facc15' }}>
                                  edited (was {fmtQty(row.totalQty, row.product.unit)})
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Edit / Confirm button */}
                        <td style={{ width: 60 }}>
                          {isEditing ? (
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                onClick={() => commitEdit(row.product.id, row.product.unit)}
                                title="Confirm edit"
                                style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)',
                                  borderRadius: 6, cursor: 'pointer', color: '#10b981', padding: '4px 6px' }}>
                                <Check size={13} />
                              </button>
                              <button
                                onClick={cancelEdit}
                                title="Cancel edit"
                                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                                  borderRadius: 6, cursor: 'pointer', color: 'rgba(232,234,242,0.4)', padding: '4px 6px' }}>
                                <X size={13} />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(row)}
                              title="Edit quantity"
                              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                                borderRadius: 6, cursor: 'pointer', color: 'rgba(232,234,242,0.4)', padding: '4px 8px',
                                display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                              <Pencil size={12} /> Edit
                            </button>
                          )}
                        </td>

                        {/* Before */}
                        <td style={{ color: 'rgba(232,234,242,0.5)' }}>
                          {fmtQty(row.before, row.product.unit)}
                        </td>

                        {/* After */}
                        <td>
                          <span style={{ fontWeight: 700, color: '#10b981' }}>{fmtQty(row.after, row.product.unit)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <button className="btn btn-secondary"
                onClick={() => { setScanStage('scan'); setEditingCheckId(null); setEditingCheckRaw(''); }}
                disabled={batchProcessing}
                style={{ flex: 1, padding: '12px 0', fontSize: 14 }}>
                ← Back to Scan List
              </button>
              <button className="btn btn-primary"
                onClick={handleBatchSubmit}
                disabled={batchProcessing}
                style={{ flex: 2, padding: '12px 0', fontSize: 14, fontWeight: 700,
                  background: 'rgba(16,185,129,0.18)', color: '#10b981', border: '1px solid rgba(16,185,129,0.45)' }}>
                {batchProcessing ? 'Processing…' : `✓ Confirm Restock — ${groupedCheckRows.length} product${groupedCheckRows.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </>)}

      {/* ── Scan Modal ──────────────────────────────────────────────────────── */}
      {scanModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <div className="card" style={{ width: '100%', maxWidth: 400, border: '1px solid rgba(16,185,129,0.3)', boxShadow: '0 0 40px rgba(16,185,129,0.1)' }}>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Product Scanned</div>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>
                {scanModal._isFormula && <span style={{ fontSize: 12, marginRight: 6 }}>🧪</span>}
                {scanModal.name}
              </div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#10b981' }}>{scanModal.productCode}</div>
              {scanCounts[scanModal.id] > 0 && (
                <div style={{ marginTop: 8, padding: '5px 10px', borderRadius: 6, background: 'rgba(250,204,21,0.08)',
                  border: '1px solid rgba(250,204,21,0.2)', fontSize: 12, color: '#facc15' }}>
                  Already scanned ×{scanCounts[scanModal.id]} — this will add another scan
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
              <div style={{ background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: scanModal._isFormula ? '#818cf8' : '#22c55e' }}>
                  {fmtQty(parseFloat(scanModal.currentStock) || 0, scanModal.unit)}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>
                  {scanModal._isFormula ? 'Ready Stock' : 'Current Stock'}
                </div>
              </div>
              <div style={{ background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: scanModal._isFormula ? '#818cf8' : getCategoryColor(scanModal.category) }}>
                  {scanModal._isFormula ? 'Formula' : getCategoryLabel(scanModal.category)}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Category</div>
              </div>
            </div>

            <div className="form-group">
              <label style={{ fontSize: 13 }}>
                Quantity to restock
                {scanModal.unit === 'mL' && <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: 400 }}> (mL, L — e.g. 1L, 500ml, 1000)</span>}
              </label>
              <input ref={modalQtyRef} className="input" type="text"
                placeholder={scanModal.unit === 'mL' ? 'e.g. 1L, 2000, 500ml' : `e.g. 10 ${scanModal.unit}`}
                value={modalQtyRaw} onChange={e => setModalQtyRaw(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmScan();
                  if (e.key === 'Escape') { setScanModal(null); setTimeout(() => scanInputRef.current?.focus(), 100); }
                }}
              />
              {scanModal.unit === 'mL' && modalQtyRaw && (() => {
                const ml = parseQtyMl(modalQtyRaw);
                if (!ml) return null;
                return (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6,
                    padding: '4px 10px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)',
                    borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#10b981' }}>
                    {ml.toLocaleString()} mL = <strong style={{ color: '#34d399' }}>{(ml / 1000).toFixed(3)} L</strong>
                  </div>
                );
              })()}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button className="btn btn-secondary"
                onClick={() => { setScanModal(null); setTimeout(() => scanInputRef.current?.focus(), 100); }}
                style={{ flex: 1 }}>Close</button>
              <button className="btn btn-primary"
                onClick={confirmScan}
                disabled={!parseQtyForUnit(modalQtyRaw, scanModal.unit)}
                style={{ flex: 2, background: 'rgba(16,185,129,0.2)', color: '#10b981', border: '1px solid rgba(16,185,129,0.5)' }}>
                + Add to Scan List
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
