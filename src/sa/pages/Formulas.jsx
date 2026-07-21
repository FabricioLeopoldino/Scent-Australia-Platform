import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';

const EMPTY_FORM = {
  tag: '', product_code: '', name: '', shopify_skus: '',
  base_product_code: '', base_percentage: '', oil_product_code: '', oil_percentage: ''
};

export default function Formulas({ user }) {
  const showToast = useToast();
  const [formulas, setFormulas]         = useState([]);
  const [products, setProducts]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [editing, setEditing]           = useState(null);
  const [form, setForm]                 = useState(EMPTY_FORM);
  const [confirmState, setConfirmState] = useState(null);
  const [search, setSearch]             = useState('');
  const [codeLoading, setCodeLoading]   = useState(false);
  const [nextCode, setNextCode]         = useState(null);
  const [publishToShopify, setPublishToShopify] = useState(true);
  const [saving, setSaving]             = useState(false);
  const [shopifyStatuses, setShopifyStatuses] = useState({});
  const [adjustingFormula, setAdjustingFormula] = useState(null); // formula being adjusted
  const [adjustQty, setAdjustQty]       = useState('');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [fRes, pRes] = await Promise.all([fetch('/api/formulas'), fetch('/api/products')]);
      setFormulas(await fRes.json());
      const all = await pRes.json();
      setProducts(Array.isArray(all) ? all.filter(p => p.unit === 'mL') : []);
    } catch { showToast('Failed to load formulas', 'error'); }
    finally { setLoading(false); }
    try {
      const sRes = await fetch('/api/shopify/status');
      if (sRes.ok) {
        const sData = await sRes.json();
        setShopifyStatuses(sData.statuses || {});
      }
    } catch { /* Shopify status optional */ }
  };

  const openAdd = async () => {
    setEditing(null);
    setPublishToShopify(true);
    setForm(EMPTY_FORM);
    setNextCode(null);
    setShowModal(true);
    setCodeLoading(true);
    try {
      const res = await fetch('/api/formulas/next-code');
      if (res.ok) setNextCode(await res.json());
    } catch { /* ignore */ }
    finally { setCodeLoading(false); }
  };

  const openEdit = (f) => {
    setEditing(f);
    setPublishToShopify(false);
    setForm({
      tag: f.tag, product_code: f.product_code, name: f.name,
      shopify_skus: Array.isArray(f.shopify_skus) ? f.shopify_skus.join(', ') : '',
      base_product_code: f.base_product_code, base_percentage: f.base_percentage,
      oil_product_code: f.oil_product_code,   oil_percentage: f.oil_percentage
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.tag || !form.product_code || !form.name || !form.base_product_code || !form.oil_product_code)
      return showToast('Fill all required fields', 'error');
    const pctSum = parseFloat(form.base_percentage || 0) + parseFloat(form.oil_percentage || 0);
    if (Math.abs(pctSum - 100) > 0.01)
      return showToast(`Base + Oil must equal 100% (currently ${pctSum}%)`, 'error');
    const payload = {
      ...form,
      shopify_skus: form.shopify_skus ? form.shopify_skus.split(',').map(s => s.trim()).filter(Boolean) : [],
      base_percentage: parseFloat(form.base_percentage),
      oil_percentage:  parseFloat(form.oil_percentage),
      userId: user?.id,
      publishToShopify: !editing && publishToShopify
    };
    setSaving(true);
    try {
      const url = editing ? `/api/formulas/${editing.id}` : '/api/formulas';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();

      if (!editing && publishToShopify && data.shopifyResult) {
        const { added = [], failed = [] } = data.shopifyResult;
        if (added.length > 0) showToast(`Formula created + ${added.length} Shopify product(s) published as draft`, 'success');
        else if (failed.length > 0) showToast('Formula created but Shopify publish failed — check credentials', 'warning');
        else showToast('Formula created', 'success');
      } else {
        showToast(editing ? 'Formula updated' : 'Formula created', 'success');
      }

      setShowModal(false);
      fetchData();
    } catch (err) { showToast(err.message, 'error'); }
    finally { setSaving(false); }
  };

  const handleDelete = (f) => {
    setConfirmState({
      message: `Delete formula "${f.name}"?`,
      onConfirm: async () => {
        await fetch(`/api/formulas/${f.id}?userId=${user?.id || ''}`, { method: 'DELETE' });
        showToast('Formula deleted', 'success');
        fetchData();
        setConfirmState(null);
      },
      onCancel: () => setConfirmState(null)
    });
  };

  const handleAdjustReadyStock = async () => {
    const qty = parseFloat(adjustQty);
    if (isNaN(qty) || qty < 0) return showToast('Enter a valid quantity (0 or more)', 'error');
    try {
      const res = await fetch(`/api/formulas/${adjustingFormula.id}/ready-stock/adjust`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantityMl: qty, userId: user?.id })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      showToast(`Ready stock updated to ${(qty / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L`, 'success');
      setAdjustingFormula(null);
      setAdjustQty('');
      fetchData();
    } catch (err) { showToast(err.message || 'Failed to adjust', 'error'); }
  };

  const productName  = (code) => products.find(p => p.productCode === code)?.name || code;
  const productStock = (code) => {
    const p = products.find(p => p.productCode === code);
    if (!p) return null;
    const stock = parseFloat(p.currentStock) || 0;
    const litres = stock / 1000;
    const formatted = litres % 1 === 0 ? litres.toLocaleString('en-AU') : litres.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    const low = stock <= (parseFloat(p.minStock) || 0);
    return { ml: stock, display: `${formatted} L`, low };
  };

  const getSkuStatusBadge = (sku) => {
    const s = shopifyStatuses[sku];
    if (!s) return null;
    const cfg = {
      active: { label: 'Active', color: '#10b981', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)' },
      draft:  { label: 'Draft',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)' },
    };
    const c = cfg[s.status] || cfg.draft;
    return (
      <span style={{ fontSize: 10, fontWeight: 700, color: c.color, background: c.bg,
        border: `1px solid ${c.border}`, borderRadius: 4, padding: '1px 5px', marginLeft: 4 }}>
        {c.label}
      </span>
    );
  };

  const filtered = formulas.filter(f =>
    !search || f.name.toLowerCase().includes(search.toLowerCase()) ||
    f.product_code.toLowerCase().includes(search.toLowerCase()) ||
    f.tag.toLowerCase().includes(search.toLowerCase())
  );

  // Formula create/edit/delete drives raw-material debit %s — backend requires
  // root (not admin). Was showing admin an enabled form that 403'd on submit.
  const canEdit = user?.role === 'root';

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      {confirmState && <ConfirmModal {...confirmState} />}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>🧪 Formulas & Blends</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 13 }}>
            {formulas.length} formula{formulas.length !== 1 ? 's' : ''} · Stock debited automatically on Shopify fulfillment
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            className="input" placeholder="Search formulas…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 220, fontSize: 13 }}
          />
          {canEdit && (
            <button className="btn btn-primary" onClick={openAdd}>+ New Formula</button>
          )}
        </div>
      </div>

      {/* Cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>No formulas found</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {filtered.map(f => {
            const skus = Array.isArray(f.shopify_skus) ? f.shopify_skus : [];
            return (
              <div key={f.id} style={{
                background: 'var(--card-bg)', border: '1px solid var(--border)',
                borderRadius: 14, padding: '20px 24px', position: 'relative', overflow: 'visible'
              }}>
                <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                  {/* Left: identity */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#818cf8',
                        background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.25)',
                        borderRadius: 6, padding: '2px 8px' }}>{f.tag}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f.product_code}</span>
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>{f.name}</div>

                    {/* Components */}
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {[
                        { code: f.base_product_code, pct: f.base_percentage, color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.2)', label: 'Base' },
                        { code: f.oil_product_code,  pct: f.oil_percentage,  color: '#10b981', bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.2)',  label: 'Oil'  }
                      ].map(({ code, pct, color, bg, border, label }) => {
                        const stock = productStock(code);
                        return (
                          <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '8px 14px', minWidth: 200 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{productName(code)}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{code} · <strong style={{ color }}>{pct}%</strong></div>
                            {stock && (
                              <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5,
                                padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                                background: stock.low ? 'rgba(248,113,113,0.12)' : 'rgba(52,211,153,0.1)',
                                border: `1px solid ${stock.low ? 'rgba(248,113,113,0.3)' : 'rgba(52,211,153,0.25)'}`,
                                color: stock.low ? '#f87171' : '#34d399' }}>
                                {stock.low ? '⚠️' : '📦'}
                                <span>{stock.low ? 'Low Stock' : 'Stock Available'}:</span>
                                <span>{stock.display}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* SKUs with Shopify status */}
                    {skus.length > 0 && (
                      <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {skus.map(sku => (
                          <span key={sku} style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 600,
                            color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.25)',
                            borderRadius: 6, padding: '2px 8px' }}>
                            🛒 {sku}
                            {getSkuStatusBadge(sku)}
                            {!shopifyStatuses[sku] && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.3)',
                                marginLeft: 4 }}>Not Published</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Ready stock box + Actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end', flexShrink: 0 }}>
                    {/* Ready Formula Stock */}
                    {(() => {
                      const readyMl = parseFloat(f.ready_stock_ml) || 0;
                      const hasStock = readyMl > 0;
                      const readyL = readyMl / 1000;
                      const bottles400 = Math.floor(readyMl / 400);
                      const bottles1L  = Math.floor(readyMl / 1000);
                      return (
                        <div style={{
                          minWidth: 180, padding: '12px 16px', borderRadius: 10,
                          background: hasStock ? 'rgba(129,140,248,0.08)' : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${hasStock ? 'rgba(129,140,248,0.3)' : 'rgba(255,255,255,0.08)'}`,
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1,
                            color: hasStock ? '#818cf8' : 'var(--text-muted)', marginBottom: 6 }}>
                            🧪 Ready Formula
                          </div>
                          <div style={{ fontSize: 20, fontWeight: 800,
                            color: hasStock ? '#818cf8' : 'var(--text-muted)' }}>
                            {readyL % 1 === 0 ? readyL : readyL.toLocaleString('en-AU', { maximumFractionDigits: 2 })} L
                          </div>
                          {hasStock && (
                            <div style={{ fontSize: 11, color: 'rgba(129,140,248,0.7)', marginTop: 4 }}>
                              ≈ {bottles400} × 400ml · {bottles1L} × 1L
                            </div>
                          )}
                          {!hasStock && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                              No ready stock
                            </div>
                          )}
                          <button
                            onClick={() => { setAdjustingFormula(f); setAdjustQty(String(parseFloat(f.ready_stock_ml) || 0)); }}
                            style={{
                              marginTop: 8, width: '100%', padding: '4px 0', fontSize: 11, fontWeight: 600,
                              cursor: 'pointer', borderRadius: 6,
                              background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                              color: 'var(--text-muted)'
                            }}
                          >
                            ✏️ Adjust
                          </button>
                        </div>
                      );
                    })()}

                    {/* Edit / Delete */}
                    {canEdit && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => openEdit(f)}>Edit</button>
                        <button className="btn btn-danger" style={{ fontSize: 12 }}
                          onClick={() => handleDelete(f)}>Delete</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {/* Adjust Ready Stock Modal */}
      {adjustingFormula && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)',
            borderRadius: 16, padding: 28, width: 380 }}>
            <h3 style={{ color: 'var(--text-primary)', marginBottom: 4, fontSize: 16 }}>
              ✏️ Adjust Ready Stock
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
              {adjustingFormula.name}
            </p>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="label">New quantity (mL)</label>
              <input
                type="number" className="input" autoFocus min="0"
                value={adjustQty}
                onChange={e => setAdjustQty(e.target.value)}
                placeholder="e.g. 5000"
              />
            </div>
            {adjustQty !== '' && parseFloat(adjustQty) >= 0 && (
              <div style={{ fontSize: 12, color: '#818cf8', marginBottom: 16 }}>
                = {(parseFloat(adjustQty) / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} L
                &nbsp;·&nbsp; ≈ {Math.floor(parseFloat(adjustQty) / 400)} × 400ml
                &nbsp;·&nbsp; {Math.floor(parseFloat(adjustQty) / 1000)} × 1L
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleAdjustReadyStock} style={{ flex: 1 }}>
                Save
              </button>
              <button className="btn btn-secondary" onClick={() => { setAdjustingFormula(null); setAdjustQty(''); }}
                style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)',
            borderRadius: 16, padding: 32, width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ color: 'var(--text-primary)', marginBottom: 24, fontSize: 18 }}>
              {editing ? 'Edit Formula' : 'New Formula'}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* TAG + Product Code with "Use …" helper buttons */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <label className="label" style={{ margin: 0 }}>TAG *</label>
                    {!editing && (codeLoading
                      ? <span style={{ fontSize: 10, color: '#818cf8' }}>loading…</span>
                      : nextCode?.tag && (
                        <button type="button"
                          onClick={() => setForm(p => ({ ...p, tag: nextCode.tag }))}
                          style={{ padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.1)', color: '#10b981', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          Use {nextCode.tag}
                        </button>
                      )
                    )}
                  </div>
                  <input className="input" placeholder="#SAFORM00001" value={form.tag}
                    onChange={e => setForm(p => ({ ...p, tag: e.target.value }))} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <label className="label" style={{ margin: 0 }}>Product Code *</label>
                    {!editing && nextCode?.product_code && (
                      <button type="button"
                        onClick={() => setForm(p => ({ ...p, product_code: nextCode.product_code }))}
                        style={{ padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.1)', color: '#10b981', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                        Use {nextCode.product_code}
                      </button>
                    )}
                  </div>
                  <input className="input" placeholder="FORM_00001" value={form.product_code}
                    onChange={e => setForm(p => ({ ...p, product_code: e.target.value }))} />
                </div>
              </div>

              <div>
                <label className="label">Formula Name *</label>
                <input className="input" placeholder="e.g. Odour + White Tea & Ginger" value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </div>

              {/* Shopify SKUs with "Use …" helper */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label className="label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    Shopify SKUs
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>comma-separated</span>
                  </label>
                  {!editing && nextCode?.shopify_skus && (
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, shopify_skus: nextCode.shopify_skus }))}
                      style={{ padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.1)', color: '#10b981', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                      Use auto SKUs
                    </button>
                  )}
                </div>
                <input className="input" placeholder="SA_FORM_00001_400, SA_FORM_00001_1L"
                  value={form.shopify_skus}
                  onChange={e => setForm(p => ({ ...p, shopify_skus: e.target.value }))} />
                <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {form.shopify_skus.split(',').map(s => s.trim()).filter(Boolean).map(sku => (
                    <span key={sku} style={{ fontSize: 10, fontWeight: 600, color: '#34d399',
                      background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)',
                      borderRadius: 4, padding: '1px 6px' }}>🛒 {sku}</span>
                  ))}
                </div>
              </div>

              {/* Base component */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Base Component</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12 }}>
                  <div>
                    <label className="label">Product Code *</label>
                    <select className="input" value={form.base_product_code}
                      onChange={e => setForm(p => ({ ...p, base_product_code: e.target.value }))}>
                      <option value="">Select base…</option>
                      {products.map(p => <option key={p.productCode} value={p.productCode}>{p.name} ({p.productCode})</option>)}
                    </select>
                  </div>
                  <div style={{ width: 90 }}>
                    <label className="label">% *</label>
                    <input className="input" type="number" min="0" max="100" placeholder="30" value={form.base_percentage}
                      onChange={e => setForm(p => ({ ...p, base_percentage: e.target.value, oil_percentage: (100 - parseFloat(e.target.value || 0)).toString() }))} />
                  </div>
                </div>
              </div>

              {/* Oil component */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Oil Component</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12 }}>
                  <div>
                    <label className="label">Product Code *</label>
                    <select className="input" value={form.oil_product_code}
                      onChange={e => setForm(p => ({ ...p, oil_product_code: e.target.value }))}>
                      <option value="">Select oil…</option>
                      {products.map(p => <option key={p.productCode} value={p.productCode}>{p.name} ({p.productCode})</option>)}
                    </select>
                  </div>
                  <div style={{ width: 90 }}>
                    <label className="label">%</label>
                    <input className="input" type="number" min="0" max="100" placeholder="70" value={form.oil_percentage}
                      onChange={e => setForm(p => ({ ...p, oil_percentage: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* % validation */}
              {form.base_percentage && form.oil_percentage && (parseFloat(form.base_percentage) + parseFloat(form.oil_percentage)) !== 100 && (
                <div style={{ color: '#f87171', fontSize: 12 }}>
                  ⚠️ Base + Oil must equal 100% (currently {parseFloat(form.base_percentage || 0) + parseFloat(form.oil_percentage || 0)}%)
                </div>
              )}

              {/* Shopify publish toggle — only for new formulas */}
              {!editing && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <div
                      onClick={() => setPublishToShopify(v => !v)}
                      style={{
                        width: 38, height: 20, borderRadius: 10, position: 'relative', cursor: 'pointer',
                        background: publishToShopify ? 'rgba(52,211,153,0.3)' : 'rgba(255,255,255,0.1)',
                        border: `1px solid ${publishToShopify ? 'rgba(52,211,153,0.5)' : 'rgba(255,255,255,0.15)'}`,
                        transition: 'all 0.2s'
                      }}>
                      <div style={{
                        position: 'absolute', top: 2, left: publishToShopify ? 18 : 2,
                        width: 14, height: 14, borderRadius: '50%', transition: 'left 0.2s',
                        background: publishToShopify ? '#34d399' : 'rgba(232,234,242,0.3)'
                      }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: publishToShopify ? '#34d399' : 'var(--text-secondary)' }}>
                        {publishToShopify ? '🛒 Auto-create in Shopify (400ml + 1L as draft)' : 'Skip Shopify — create formula only'}
                      </div>
                      {publishToShopify && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          Uses the SKUs above · Published as draft · Requires Shopify credentials
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving || codeLoading}>
                {saving ? 'Saving…' : editing ? 'Save Changes' : publishToShopify ? 'Create + Publish to Shopify' : 'Create Formula'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
