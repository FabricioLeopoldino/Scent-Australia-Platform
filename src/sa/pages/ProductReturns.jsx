import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';
import { PackageOpen, ArchiveRestore, Plus, X, ArrowRight, FlaskConical } from 'lucide-react';

export default function ProductReturns({ user }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [products, setProducts]         = useState([]);
  const [formulas, setFormulas]         = useState([]);
  const [searchTerm, setSearchTerm]     = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [cart, setCart]                 = useState(new Map()); // id -> quantity
  const [notes, setNotes]               = useState('');
  const [returnedBy, setReturnedBy]     = useState('');
  const [loading, setLoading]           = useState(true);
  const [processing, setProcessing]     = useState(false);
  const [qtyModal, setQtyModal]         = useState({ open: false, product: null, value: '' });

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    try {
      const [pRes, fRes] = await Promise.all([fetch('/api/products'), fetch('/api/formulas')]);
      const pData = await pRes.json();
      const fData = await fRes.json();
      setProducts(Array.isArray(pData) ? pData : []);
      setFormulas(Array.isArray(fData) ? fData : []);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Map formulas to virtual items so they fit the existing list/cart structure
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

  const filteredProducts = allItems.filter(p => {
    if (categoryFilter === 'FORMULA') return p.category === 'FORMULA';
    if (categoryFilter !== 'ALL' && p.category !== categoryFilter) return false;
    if (categoryFilter === 'ALL' && p.category === 'FORMULA' && !searchTerm) return false; // formulas only appear via search or their own tab
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return (
      (p.name?.toLowerCase() ?? '').includes(s) ||
      (p.productCode?.toLowerCase() ?? '').includes(s) ||
      (p.tag?.toLowerCase() ?? '').includes(s) ||
      (p.color?.toLowerCase() ?? '').includes(s)
    );
  });

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
    const next = new Map(cart);
    next.delete(productId);
    setCart(next);
  };

  const setQty = (productId, val) => {
    const next = new Map(cart);
    next.set(productId, val);
    setCart(next);
  };

  const cartProducts = Array.from(cart.entries()).map(([id, qty]) => ({
    product: allItems.find(p => p.id === id),
    qty
  })).filter(x => x.product);

  const handleProcess = async () => {
    if (cart.size === 0) return showToast('Add at least one item to the list', 'warning');
    if (!returnedBy.trim()) return showToast('Enter the name of the person processing the return', 'warning');

    const invalid = cartProducts.filter(({ qty }) => !qty || parseFloat(qty) <= 0);
    if (invalid.length > 0)
      return showToast(`Enter valid quantities for: ${invalid.map(x => x.product.name).join(', ')}`, 'warning');

    const formulaEntries  = cartProducts.filter(({ product }) => product._isFormula);
    const productEntries  = cartProducts.filter(({ product }) => !product._isFormula);

    setConfirmState({
      message: `Process restock for ${cart.size} item(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        setProcessing(true);
        let successCount = 0;
        try {
          // Regular products → /api/returns
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

          // Formula items → /api/formulas/:id/ready-stock/receive
          for (const { product, qty } of formulaEntries) {
            const res = await fetch(`/api/formulas/${product._formulaId}/ready-stock/receive`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                quantityMl: parseFloat(qty),
                notes: notes.trim(),
                userId: user?.id
              })
            });
            if (res.ok) {
              successCount++;
            } else {
              const err = await res.json();
              showToast(`Formula error (${product.name}): ${err.error || 'Failed'}`, 'error');
            }
          }

          if (successCount > 0) {
            showToast(`Successfully restocked ${successCount} item(s)!`, 'success');
            setCart(new Map());
            setNotes('');
            setReturnedBy('');
            setSearchTerm('');
            fetchAll();
          }
        } catch (err) {
          showToast('Connection error', 'error');
        } finally {
          setProcessing(false);
        }
      }
    });
  };

  const getCategoryLabel = (cat) => ({
    OILS: 'Oils', RAW_MATERIALS: 'Raw Materials',
    MACHINES_SPARES: 'Spares', SCENT_MACHINES: 'Diffuser Machines'
  }[cat] || cat);

  const getCategoryColor = (cat) => ({
    OILS: '#818cf8', RAW_MATERIALS: '#f59e0b',
    MACHINES_SPARES: '#94a3b8', SCENT_MACHINES: '#38bdf8'
  }[cat] || '#94a3b8');

  if (loading) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading products…</div>
  );

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1600, margin: '0 auto' }}>
      {confirmState && <ConfirmModal {...confirmState} onCancel={() => setConfirmState(null)} />}

      {/* Quantity modal */}
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
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
                color: '#10b981', marginBottom: 6 }}>Add to Restock List</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {qtyModal.product.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {qtyModal.product.productCode}
                {qtyModal.product._isFormula
                  ? <> · Ready stock: <strong style={{ color: '#818cf8' }}>{(qtyModal.product.currentStock / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L</strong></>
                  : <> · Current stock: <strong style={{ color: 'var(--text-secondary)' }}>{parseFloat(qtyModal.product.currentStock).toLocaleString()} {qtyModal.product.unit}</strong></>
                }
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
                display: 'block', marginBottom: 8 }}>
                {qtyModal.product._isFormula ? 'Quantity received (mL)' : `Quantity to restock (${qtyModal.product.unit})`}
              </label>
              <input
                autoFocus
                type="number"
                className="input"
                value={qtyModal.value}
                onChange={e => setQtyModal(m => ({ ...m, value: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') confirmQtyModal(); if (e.key === 'Escape') setQtyModal({ open: false, product: null, value: '' }); }}
                placeholder={qtyModal.product._isFormula ? 'e.g. 5000' : 'e.g. 10'}
                min="0"
                style={{ fontSize: 20, fontWeight: 700, textAlign: 'center', padding: '12px 16px' }}
              />
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
              <button
                onClick={() => setQtyModal({ open: false, product: null, value: '' })}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)'
                }}>
                Cancel
              </button>
              <button
                onClick={confirmQtyModal}
                style={{
                  flex: 2, padding: '10px 0', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  background: '#10b981', border: '1px solid rgba(16,185,129,0.5)', color: '#fff'
                }}>
                Add to List
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
          <ArchiveRestore size={22} style={{ marginRight: 10, verticalAlign: 'middle', color: '#10b981' }} />
          Product Returns / Restock
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 13 }}>
          Search and add products on the left — review quantities on the right before processing
        </p>
      </div>

      {/* Split layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 460px', gap: 24, alignItems: 'start' }}>

        {/* ── LEFT: Search + Product List ── */}
        <div>
          {/* Search + filters */}
          <div className="card" style={{ marginBottom: 16, position: 'relative', overflow: 'visible' }}>
            <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <input
                type="text"
                className="input"
                placeholder="🔍 Search by name, code, colour or SKU…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                autoFocus
              />
              {searchTerm && (
                <button onClick={() => setSearchTerm('')} style={{
                  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
                  color: 'var(--text-muted)'
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

          {/* Product rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '74vh', overflowY: 'auto', paddingRight: 4 }}>
            {filteredProducts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No products found</div>
            ) : filteredProducts.map(product => {
              const inCart = cart.has(product.id);
              return (
                <div key={product.id} style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '12px 16px', borderRadius: 10,
                  background: inCart ? 'rgba(16,185,129,0.06)' : 'var(--card-bg)',
                  border: inCart ? '1px solid rgba(16,185,129,0.35)' : '1px solid var(--border)',
                  transition: 'all 0.15s', position: 'relative', overflow: 'visible'
                }}>
                  {/* Category colour bar */}
                  <div style={{ width: 3, height: 36, borderRadius: 2, flexShrink: 0,
                    background: getCategoryColor(product.category) }} />

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                        {product.name}
                      </span>
                      {product._isFormula ? (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#818cf8',
                          background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.3)',
                          borderRadius: 5, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          🧪 Formula
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, fontWeight: 700, color: getCategoryColor(product.category),
                          background: `${getCategoryColor(product.category)}18`,
                          border: `1px solid ${getCategoryColor(product.category)}33`,
                          borderRadius: 5, padding: '1px 6px' }}>
                          {getCategoryLabel(product.category)}
                        </span>
                      )}
                      {product.color && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 11, color: 'var(--text-secondary)' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%',
                            background: product.color.toLowerCase(), border: '1px solid rgba(255,255,255,0.2)' }} />
                          {product.color}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                      {product.productCode}
                      {product._isFormula
                        ? <> · Ready stock: <strong style={{ color: '#818cf8' }}>{(product.currentStock / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L</strong></>
                        : <> · Stock: <strong style={{ color: 'var(--text-secondary)' }}>{parseFloat(product.currentStock).toLocaleString()} {product.unit}</strong></>
                      }
                    </div>
                  </div>

                  {/* Add button */}
                  <button
                    onClick={() => addToCart(product)}
                    disabled={inCart}
                    style={{
                      flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
                      padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: inCart ? 'default' : 'pointer',
                      border: inCart ? '1px solid rgba(16,185,129,0.4)' : '1px solid rgba(16,185,129,0.5)',
                      background: inCart ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.15)',
                      color: inCart ? '#10b981' : '#10b981',
                      transition: 'all 0.15s'
                    }}
                  >
                    {inCart ? '✓ Added' : <><Plus size={13} /> Add</>}
                    {!inCart && <ArrowRight size={13} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT: Restock List (cart) ── */}
        <div style={{ position: 'sticky', top: 24 }}>
          <div className="card" style={{ position: 'relative', overflow: 'visible', borderLeft: '3px solid #10b981' }}>
            <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

            {/* Cart header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10,
                  background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ArchiveRestore size={18} color="#10b981" />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>Restock List</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cart.size} item{cart.size !== 1 ? 's' : ''}</div>
                </div>
              </div>
              {cart.size > 0 && (
                <button onClick={() => setCart(new Map())} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 11, color: 'var(--text-muted)', padding: '4px 8px'
                }}>Clear all</button>
              )}
            </div>

            {/* Empty cart */}
            {cart.size === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                <PackageOpen size={36} style={{ opacity: 0.25, marginBottom: 12 }} />
                <div style={{ fontSize: 13 }}>No products added yet</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>Click "Add →" on the left</div>
              </div>
            ) : (
              <>
                {/* Cart items */}
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
                          flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-muted)', padding: 2, lineHeight: 1
                        }}><X size={14} /></button>
                      </div>
                      {/* Quantity row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <input
                          type="number"
                          className="input"
                          value={qty}
                          onChange={e => setQty(product.id, e.target.value)}
                          placeholder={product._isFormula ? 'mL received' : 'Qty'}
                          min="0"
                          style={{ flex: 1, fontSize: 14, fontWeight: 700, padding: '6px 10px' }}
                        />
                        <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0,
                          color: product._isFormula ? '#818cf8' : '#10b981' }}>
                          {product.unit}
                        </span>
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

                {/* Divider */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 14 }}>

                  {/* Returned / Received By */}
                  <div className="form-group" style={{ marginBottom: 12 }}>
                    <label className="label">
                      {cartProducts.some(x => x.product._isFormula) ? 'Received By *' : 'Returned By *'}
                    </label>
                    <input type="text" className="input"
                      value={returnedBy} onChange={e => setReturnedBy(e.target.value)}
                      placeholder="Your name" />
                  </div>

                  {/* Notes */}
                  <div className="form-group" style={{ marginBottom: 16 }}>
                    <label className="label">Notes (optional)</label>
                    <textarea className="input" rows={2}
                      value={notes} onChange={e => setNotes(e.target.value)}
                      placeholder="e.g. Returned from customer, received from technician…"
                      style={{ resize: 'none' }} />
                  </div>
                </div>

                {/* Process button */}
                <button
                  className="btn btn-primary"
                  onClick={handleProcess}
                  disabled={processing}
                  style={{ width: '100%', background: '#10b981', border: '1px solid rgba(16,185,129,0.5)', fontSize: 14 }}>
                  {processing ? 'Processing…' : `✓ Process ${cart.size} Restock${cart.size !== 1 ? 's' : ''}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
