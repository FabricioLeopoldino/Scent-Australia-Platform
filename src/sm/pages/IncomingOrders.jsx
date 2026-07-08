import { useState, useEffect } from 'react'
import { Plus, X, CheckCircle, Truck, Search, AlertTriangle, Settings, Trash2 } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import { useToast } from '../SMModule.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import MlHint from '../components/MlHint.jsx'
import { fmt } from '../utils/date.js'
import SearchSelect from '../components/SearchSelect.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const CAT_COLORS = { FRAGRANCE:'#a78bfa', RAW_MATERIALS:'#fbbf24', COMPONENTS:'#60a5fa', FINISHED_GOODS:'#4ade80', READY_FORMULA:'#fb923c' }


const STATUS_META = {
  pending:   { label: 'Pending',   color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
  partial:   { label: 'Partial',   color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
  received:  { label: 'Received',  color: '#4ade80', bg: 'rgba(34,197,94,0.12)'  },
  cancelled: { label: 'Cancelled', color: '#f87171', bg: 'rgba(239,68,68,0.10)'  },
}

export default function IncomingOrders() {
  const [pos, setPos]               = useState([])
  const [products, setProducts]     = useState([])
  const [loading, setLoading]       = useState(true)
  const [statusFilter, setStatusFilter] = useState('active')
  const [search, setSearch]         = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [receiveModal, setReceiveModal] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [receiveQty, setReceiveQty] = useState('')
  const [saving, setSaving]         = useState(false)
  // Tolerance
  const [toleranceResult, setToleranceResult] = useState(null) // { expected, received, difference, diff_pct, ... }
  const [discrepancyReason, setDiscrepancyReason] = useState('')
  const [settings, setSettings]     = useState({ receiving_tolerance_pct: '5', receiving_tolerance_units: '0' })
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  // Create form
  const [createForm, setCreateForm] = useState({ product_id: '', order_number: '', quantity: '', supplier: '', estimated_delivery_date: '', notes: '' })
  const [productSearch, setProductSearch] = useState('')
  const [showProductDrop, setShowProductDrop] = useState(false)
  // Quick create product
  const [showQPForm, setShowQPForm] = useState(false)
  const [qpForm, setQpForm] = useState({ name: '', category: 'RAW_MATERIAL', product_code: '', unit: 'units' })
  const [qpSaving, setQpSaving] = useState(false)
  const { addToast } = useToast()

  useEffect(() => { loadPOs(); loadProducts(); loadSettings() }, [])

  async function loadPOs() {
    setLoading(true)
    try {
      const res = await axios.get('/api/purchase-orders', api())
      setPos(res.data)
    } catch { addToast('Failed to load POs', 'error') }
    finally { setLoading(false) }
  }

  async function loadProducts() {
    const res = await axios.get('/api/products', api())
    setProducts(res.data)
  }

  async function loadSettings() {
    try {
      const res = await axios.get('/api/settings', api())
      setSettings(s => ({ ...s, ...res.data }))
    } catch {}
  }

  async function handleSaveSettings() {
    setSettingsSaving(true)
    try {
      await axios.put('/api/settings', {
        receiving_tolerance_pct: settings.receiving_tolerance_pct,
        receiving_tolerance_units: settings.receiving_tolerance_units,
      }, api())
      addToast('Settings saved')
      setShowSettings(false)
    } catch { addToast('Failed to save', 'error') }
    finally { setSettingsSaving(false) }
  }

  async function handleCreate() {
    if (!createForm.product_id || !createForm.quantity) { addToast('Product and quantity required', 'error'); return }
    setSaving(true)
    try {
      await axios.post(`/api/products/${createForm.product_id}/incoming`, {
        order_number: createForm.order_number || null,
        quantity: parseFloat(createForm.quantity),
        supplier: createForm.supplier || null,
        estimated_delivery_date: createForm.estimated_delivery_date || null,
        notes: createForm.notes || null,
      }, api())
      addToast('Purchase order created')
      setShowCreate(false)
      setCreateForm({ product_id: '', order_number: '', quantity: '', supplier: '', estimated_delivery_date: '', notes: '' })
      setProductSearch('')
      loadPOs()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleReceive(forceAccept = false) {
    if (!receiveQty || parseFloat(receiveQty) <= 0) { addToast('Enter quantity', 'error'); return }
    setSaving(true)
    try {
      const res = await axios.post(`/api/purchase-orders/${receiveModal.id}/receive`, {
        quantity_received: parseFloat(receiveQty),
        force_accept: forceAccept,
        discrepancy_reason: forceAccept ? discrepancyReason : undefined,
      }, api())
      if (res.data.tolerance_exceeded) {
        setToleranceResult(res.data)
        setSaving(false)
        return
      }
      addToast('Stock received')
      setReceiveModal(null)
      setReceiveQty('')
      setToleranceResult(null)
      setDiscrepancyReason('')
      loadPOs()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    const mode = deleteTarget._mode || 'cancel'
    try {
      const url = mode === 'discard'
        ? `/api/purchase-orders/${deleteTarget.id}?mode=discard`
        : `/api/purchase-orders/${deleteTarget.id}`
      await axios.delete(url, api())
      addToast(mode === 'discard' ? 'PO discarded' : 'PO cancelled')
      setDeleteTarget(null)
      loadPOs()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  function selectProduct(p) {
    setCreateForm(f => ({ ...f, product_id: p.id, supplier: p.supplier || '' }))
    setProductSearch(p.name)
    setShowProductDrop(false)
  }

  function qpDefaultUnit(cat) {
    if (['FRAGRANCE', 'RAW_MATERIAL', 'READY_FORMULA'].includes(cat)) return 'ml'
    return 'units'
  }

  function qpSuggestCode(cat) {
    const prefixes = { FRAGRANCE: 'FRAG_', RAW_MATERIAL: 'RAW_', COMPONENT: 'COMP_', LABEL: 'LABEL_', FINISHED_GOOD: 'FG_', READY_FORMULA: 'RF-FRAG_' }
    const prefix = prefixes[cat] || 'PROD_'
    const last = products
      .filter(p => p.product_code?.startsWith(prefix))
      .map(p => parseInt(p.product_code.replace(prefix, '')) || 0)
      .sort((a, b) => b - a)[0] || 0
    return prefix + String(last + 1).padStart(5, '0')
  }

  async function handleQuickCreate() {
    if (!qpForm.name.trim()) { addToast('Name is required', 'error'); return }
    if (!qpForm.product_code.trim()) { addToast('Product code is required', 'error'); return }
    setQpSaving(true)
    try {
      const res = await axios.post('/api/products', {
        name: qpForm.name.trim(),
        product_code: qpForm.product_code.toUpperCase().trim(),
        category: qpForm.category,
        unit: qpForm.unit,
        current_stock: 0,
        min_stock_level: 0,
      }, api())
      const created = res.data
      setProducts(prev => [...prev, created])
      selectProduct(created)
      setShowQPForm(false)
      setQpForm({ name: '', category: 'RAW_MATERIAL', product_code: '', unit: 'units' })
      addToast(`Product "${created.name}" created`)
    } catch (e) { addToast(e.response?.data?.error || 'Failed to create product', 'error') }
    finally { setQpSaving(false) }
  }

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.product_code.toLowerCase().includes(productSearch.toLowerCase())
  )

  const displayed = pos.filter(po => {
    const matchSearch = !search || (po.product_name || '').toLowerCase().includes(search.toLowerCase()) || (po.order_number || '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all'
      || (statusFilter === 'active' ? ['pending', 'partial'].includes(po.status) : po.status === statusFilter)
    return matchSearch && matchStatus
  })

  const pending = pos.filter(p => ['pending', 'partial'].includes(p.status)).length

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Incoming Orders</h1>
          {pending > 0 && <p style={{ fontSize: 13, color: '#fbbf24', marginTop: 4 }}>{pending} pending order{pending !== 1 ? 's' : ''}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowSettings(true)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: 'rgba(232,234,242,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <Settings size={14} /> Tolerance
          </button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={15} /> New PO
          </Button>
        </div>
      </div>

      {/* Tolerance info bar */}
      <div style={{ marginBottom: 16, padding: '8px 14px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, fontSize: 11, color: 'rgba(232,234,242,0.4)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <AlertTriangle size={11} />
        Receiving tolerance: ±{settings.receiving_tolerance_pct}% or ±{settings.receiving_tolerance_units} units — outside this range requires approval
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[['active','Active'],['received','Received'],['cancelled','Cancelled'],['all','All']].map(([k,l]) => (
          <button key={k} onClick={() => setStatusFilter(k)} style={{
            background: statusFilter === k ? '#2563eb' : 'rgba(255,255,255,0.05)',
            color: statusFilter === k ? 'white' : 'rgba(232,234,242,0.6)',
            border: statusFilter === k ? 'none' : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 20, padding: '5px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer'
          }}>{l}</button>
        ))}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 12px 6px 28px', color: '#e8eaf2', fontSize: 12, outline: 'none', width: 200 }} />
        </div>
      </div>

      {/* PO Table */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>No purchase orders</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Product', 'PO #', 'Ordered', 'Received', 'Status', 'Supplier', 'ETA', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(po => {
                const sm = STATUS_META[po.status] || STATUS_META.pending
                const remaining = po.quantity - po.quantity_received
                return (
                  <tr key={po.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{po.product_name}</div>
                      <span style={{ fontSize: 10, color: CAT_COLORS[po.category] || '#e8eaf2' }}>{po.product_code}</span>
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.55)', fontFamily: 'monospace' }}>{po.order_number || '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{Number(po.quantity).toLocaleString()} {po.unit}</td>
                    <td style={{ padding: '10px 14px', fontSize: 13, color: po.quantity_received > 0 ? '#4ade80' : 'rgba(232,234,242,0.4)' }}>
                      {Number(po.quantity_received).toLocaleString()} {po.unit}
                      {po.status === 'partial' && <div style={{ fontSize: 10, color: '#fb923c' }}>({Number(remaining).toLocaleString()} remaining)</div>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: sm.color, fontSize: 11, fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: sm.color, flexShrink: 0 }} />{sm.label}</span>
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>{po.supplier || '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: po.estimated_delivery_date ? '#10b981' : 'rgba(232,234,242,0.3)' }}>
                      {po.estimated_delivery_date ? fmt(po.estimated_delivery_date) : '—'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {['pending', 'partial'].includes(po.status) && (
                          <button onClick={() => { setReceiveModal(po); setReceiveQty(String(po.quantity - po.quantity_received)); setToleranceResult(null); setDiscrepancyReason('') }} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#4ade80', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={12} /> Receive
                          </button>
                        )}
                        {['pending', 'partial'].includes(po.status) && (
                          <IconButton variant="danger" onClick={() => setDeleteTarget({ ...po, _mode: 'cancel' })} title="Cancel PO"><X size={13} /></IconButton>
                        )}
                        {po.status === 'cancelled' && (
                          <IconButton variant="danger" onClick={() => setDeleteTarget({ ...po, _mode: 'discard' })} title="Permanently discard"><Trash2 size={13} /></IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {displayed.length} order{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Tolerance Settings Modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Receiving Tolerance</h2>
              <button className="modal-close" onClick={() => setShowSettings(false)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)', marginBottom: 16, lineHeight: 1.5 }}>
                When received quantity differs from expected beyond these thresholds, approval and reason are required before stock is accepted.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <F label="Tolerance %">
                  <input type="number" min={0} step="0.1" value={settings.receiving_tolerance_pct} onChange={e => setSettings(s => ({ ...s, receiving_tolerance_pct: e.target.value }))} style={inp} />
                </F>
                <F label="Tolerance Units">
                  <input type="number" min={0} step="any" value={settings.receiving_tolerance_units} onChange={e => setSettings(s => ({ ...s, receiving_tolerance_units: e.target.value }))} style={inp} />
                </F>
              </div>
              <p style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', marginTop: 10 }}>Pass either threshold to auto-accept (OR logic).</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSettings(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveSettings} disabled={settingsSaving}>{settingsSaving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Create PO Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Purchase Order</h2>
              <button className="modal-close" onClick={() => setShowCreate(false)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <F label="Product *" full>
                <div style={{ position: 'relative' }}>
                  <input value={productSearch} onChange={e => { setProductSearch(e.target.value); setCreateForm(f => ({ ...f, product_id: '' })); setShowProductDrop(true) }} onFocus={() => setShowProductDrop(true)} onBlur={() => setTimeout(() => setShowProductDrop(false), 150)} placeholder="Search product..." style={inp} />
                  {showProductDrop && (filteredProducts.length > 0 || productSearch.trim()) && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--popover-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 8, zIndex: 100, maxHeight: 220, overflowY: 'auto' }}>
                      {filteredProducts.slice(0, 20).map(p => (
                        <div key={p.id} onMouseDown={() => selectProduct(p)} style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <span>{p.name}</span>
                          <span style={{ color: CAT_COLORS[p.category], fontSize: 10, fontWeight: 700 }}>{p.category.replace('_',' ')}</span>
                        </div>
                      ))}
                      {productSearch.trim() && (
                        <div onMouseDown={() => { setQpForm(f => ({ ...f, name: productSearch, product_code: qpSuggestCode('RAW_MATERIAL'), unit: 'units', category: 'RAW_MATERIAL' })); setShowQPForm(true); setShowProductDrop(false) }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 12, color: '#60a5fa', borderTop: filteredProducts.length > 0 ? '1px solid rgba(255,255,255,0.07)' : 'none', display: 'flex', alignItems: 'center', gap: 6 }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(96,165,250,0.08)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <Plus size={11} /> Create product "{productSearch}"
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </F>
              <F label="PO Number">
                <input value={createForm.order_number} onChange={e => setCreateForm(f => ({ ...f, order_number: e.target.value }))} placeholder="PO-001..." style={inp} />
              </F>
              <F label="Quantity *">
                <input type="number" min={0.01} step="any" value={createForm.quantity} onChange={e => setCreateForm(f => ({ ...f, quantity: e.target.value }))} placeholder="0" style={inp} />
                <MlHint value={createForm.quantity} unit={products.find(p => p.id === parseInt(createForm.product_id))?.unit} />
              </F>
              <F label="Supplier">
                <input value={createForm.supplier} onChange={e => setCreateForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Supplier name" style={inp} />
              </F>
              <F label="ETA">
                <input type="date" value={createForm.estimated_delivery_date} onChange={e => setCreateForm(f => ({ ...f, estimated_delivery_date: e.target.value }))} style={inp} />
              </F>
              <F label="Notes">
                <input value={createForm.notes} onChange={e => setCreateForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" style={inp} />
              </F>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>{saving ? 'Creating...' : 'Create PO'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Receive Modal */}
      {receiveModal && (
        <div className="modal-overlay" onClick={() => { setReceiveModal(null); setToleranceResult(null) }}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Receive Stock</h2>
              <button className="modal-close" onClick={() => { setReceiveModal(null); setToleranceResult(null) }}><X size={14} /></button>
            </div>
            <div className="modal-body">

            {/* Product info */}
            <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{receiveModal.product_name}</div>
              <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', marginTop: 3 }}>{receiveModal.product_code}</div>
            </div>

            {/* Expected | Received | Remaining table */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
              {[
                { label: 'Ordered', val: receiveModal.quantity, color: '#e8eaf2' },
                { label: 'Received so far', val: receiveModal.quantity_received, color: '#4ade80' },
                { label: 'Remaining', val: receiveModal.quantity - receiveModal.quantity_received, color: '#fbbf24' },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color }}>{Number(val).toLocaleString()}</div>
                  <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Tolerance exceeded warning */}
            {toleranceResult && (
              <div style={{ marginBottom: 16, padding: '12px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <AlertTriangle size={14} color="#f87171" />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171' }}>Tolerance Exceeded — Approval Required</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
                  {[
                    { label: 'Expected', val: toleranceResult.expected, color: '#e8eaf2' },
                    { label: 'Received', val: toleranceResult.received, color: '#fbbf24' },
                    { label: 'Difference', val: toleranceResult.difference, color: toleranceResult.difference < 0 ? '#f87171' : '#4ade80' },
                  ].map(({ label, val, color }) => (
                    <div key={label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color }}>{val > 0 ? '+' : ''}{Number(val).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase' }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)', marginBottom: 8 }}>
                  Variance: {toleranceResult.diff_pct}% · Tolerance: ±{toleranceResult.tolerance_pct}% or ±{toleranceResult.tolerance_units} units
                </div>
                <F label="Reason for discrepancy *">
                  <input value={discrepancyReason} onChange={e => setDiscrepancyReason(e.target.value)} placeholder="e.g. Damaged in transit, supplier short-shipped..." style={inp} autoFocus />
                </F>
              </div>
            )}

            {!toleranceResult && (
              <F label={`Quantity to receive (${receiveModal.unit})`}>
                <input type="number" min={0.01} step="any" value={receiveQty} onChange={e => setReceiveQty(e.target.value)} autoFocus placeholder="0" style={inp} />
              </F>
            )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setReceiveModal(null); setToleranceResult(null) }}>Cancel</button>
              {toleranceResult ? (
                <button onClick={() => handleReceive(true)} disabled={saving || !discrepancyReason.trim()} className="btn btn-danger" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={13} /> {saving ? 'Accepting...' : 'Accept with Discrepancy'}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => handleReceive(false)} disabled={saving}>{saving ? 'Saving...' : 'Receive'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={deleteTarget._mode === 'discard' ? 'Discard PO' : 'Cancel PO'}
          message={deleteTarget._mode === 'discard'
            ? `Permanently delete this purchase order for "${deleteTarget.product_name}"? This cannot be undone.`
            : `Cancel this purchase order for "${deleteTarget.product_name}"? It will be marked as cancelled and can be discarded later.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Quick Create Product Modal */}
      {showQPForm && (
        <div className="modal-overlay" onClick={() => setShowQPForm(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Quick Create Product</h2>
                <p>Can be fully configured in Products page later</p>
              </div>
              <button className="modal-close" onClick={() => setShowQPForm(false)}>×</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <F label="Name *" full>
                <input value={qpForm.name} onChange={e => setQpForm(f => ({ ...f, name: e.target.value }))} placeholder="Product name" autoFocus style={inp} />
              </F>
              <F label="Category *" full>
                <SearchSelect
                  value={qpForm.category}
                  onChange={cat => setQpForm(f => ({ ...f, category: cat, unit: qpDefaultUnit(cat), product_code: qpSuggestCode(cat) }))}
                  clearable={false}
                  options={[
                    { value: 'RAW_MATERIAL', label: 'Raw Material' },
                    { value: 'COMPONENT', label: 'Component' },
                    { value: 'LABEL', label: 'Label' },
                    { value: 'FRAGRANCE', label: 'Fragrance' },
                    { value: 'FINISHED_GOOD', label: 'Finished Good' },
                    { value: 'READY_FORMULA', label: 'Ready Formula' },
                  ]}
                />
              </F>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <F label="Product Code *">
                  <input value={qpForm.product_code} onChange={e => setQpForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} placeholder="e.g. RAW_00001" style={{ ...inp, fontFamily: 'monospace' }} />
                </F>
                <F label="Unit">
                  <SearchSelect
                    value={qpForm.unit}
                    onChange={u => setQpForm(f => ({ ...f, unit: u }))}
                    clearable={false}
                    options={[
                      { value: 'ml', label: 'ml' },
                      { value: 'units', label: 'units' },
                      { value: 'kg', label: 'kg' },
                      { value: 'g', label: 'g' },
                    ]}
                  />
                </F>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowQPForm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleQuickCreate} disabled={qpSaving}>{qpSaving ? 'Creating...' : 'Create & Select'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function F({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : undefined }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</label>
      {children}
    </div>
  )
}
function Btn({ children, onClick, primary, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ background: primary ? '#2563eb' : 'rgba(255,255,255,0.06)', border: primary ? 'none' : '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '9px 20px', color: primary ? 'white' : '#e8eaf2', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 700, opacity: disabled ? 0.7 : 1 }}>{children}</button>
  )
}
const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none' }
