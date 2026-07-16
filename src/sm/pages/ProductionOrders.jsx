import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, X, ChevronDown, ChevronRight, Trash2, AlertTriangle, CheckCircle, Clock, Package, Edit2 } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import { useToast } from '../SMModule.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import SearchSelect from '../components/SearchSelect.jsx'
import { fmtDate as fmt } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const STATUS_META = {
  draft:            { label: 'Draft',            color: 'rgba(232,234,242,0.5)',  bg: 'rgba(255,255,255,0.07)' },
  confirmed:        { label: 'Confirmed',         color: '#60a5fa',  bg: 'rgba(37,99,235,0.15)' },
  queued:           { label: 'Queued',            color: '#fbbf24',  bg: 'rgba(245,158,11,0.15)' },
  in_production:    { label: 'In Production',     color: '#f472b6',  bg: 'rgba(244,114,182,0.15)' },
  waiting_external: { label: 'Waiting External',  color: '#a78bfa',  bg: 'rgba(167,139,250,0.15)' },
  completed:        { label: 'Completed',         color: '#4ade80',  bg: 'rgba(34,197,94,0.15)' },
  ready_to_ship:    { label: 'Ready to Ship',     color: '#34d399',  bg: 'rgba(16,185,129,0.15)' },
  fulfilled:        { label: 'Fulfilled',          color: 'rgba(232,234,242,0.35)', bg: 'rgba(255,255,255,0.04)' },
  cancelled:        { label: 'Cancelled',         color: '#f87171',  bg: 'rgba(220,38,38,0.1)' },
}

const EMPTY_LINE = { product_type: '', fragrance_id: '', oil_id: '', variant_name: '', oil_pct: 25, quantity: '', packaging_component_id: '', label_client_label_id: '', use_ready_formula: false, ready_formula_id: '', labels_supplier: '', labels_eta: '', labels_order_qty: '', needs_labeling: false, needs_packing: false }

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: m.color }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
      {m.label}
    </span>
  )
}

// Quiet status chip — small dot + label (refined), no filled pill, no emoji.
function Chip({ color, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {children}
    </span>
  )
}

function isOverdue(d) { return d && new Date(d) < new Date() }

// Cycle of accent colors used to tell line cards apart in the order form.
const LINE_COLORS = ['#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c']

export default function ProductionOrders() {
  const [orders, setOrders]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [museOnly, setMuseOnly]        = useState(false)
  const [showCreate, setShowCreate]   = useState(false)
  const [editingOrder, setEditingOrder] = useState(null)  // order id being edited (draft only)
  const [expanded, setExpanded]       = useState(null)
  const [orderDetail, setOrderDetail] = useState({})
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [fulfillTarget, setFulfillTarget] = useState(null)
  const [shippingModal, setShippingModal] = useState(null)
  const [epModal, setEpModal] = useState(null) // { order }
  const [epForm, setEpForm] = useState({ processing_type: 'labels', product_name: '', qty_sent: '', supplier: '', expected_return: '', notes: '', client_label_id: '', set_waiting: false })
  const [epSaving, setEpSaving] = useState(false)
  const [epClientLabels, setEpClientLabels] = useState([])
  const [productTypes, setProductTypes] = useState([])  // dynamic from /api/product-types
  const { addToast } = useToast()

  useEffect(() => { loadOrders() }, [statusFilter])
  useEffect(() => {
    axios.get('/api/product-types', api()).then(r => setProductTypes(r.data)).catch(() => {})
  }, [])

  async function loadOrders() {
    setLoading(true)
    try {
      const params = statusFilter !== 'ALL' ? { status: statusFilter } : {}
      const res = await axios.get('/api/production-orders', { ...api(), params })
      setOrders(res.data)
    } catch { addToast('Failed to load orders', 'error') }
    finally { setLoading(false) }
  }

  async function loadDetail(id) {
    try {
      const res = await axios.get(`/api/production-orders/${id}`, api())
      setOrderDetail(prev => ({ ...prev, [id]: res.data }))
    } catch {}
  }

  function toggleExpand(id) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    loadDetail(id)
  }

  async function handleCancel() {
    try {
      await axios.delete(`/api/production-orders/${deleteTarget.id}?mode=cancel`, api())
      addToast('Order cancelled')
      setDeleteTarget(null)
      loadOrders()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleDiscard() {
    try {
      await axios.delete(`/api/production-orders/${deleteTarget.id}?mode=discard`, api())
      addToast('Order permanently deleted')
      setDeleteTarget(null)
      loadOrders()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function sendToShopify(order) {
    try {
      const { data } = await axios.post('/api/shopify/draft-order', { production_order_id: order.id }, api())
      if (data.queued) {
        addToast('Shopify unavailable — order queued for retry', 'error')
      } else {
        addToast('Draft order sent to Shopify')
      }
      loadOrders()
    } catch (e) { addToast(e.response?.data?.error || 'Shopify error', 'error') }
  }

  async function queueManually(order) {
    try {
      await axios.put(`/api/production-orders/${order.id}/status`, { status: 'queued' }, api())
      addToast(`${order.order_number} queued for production`)
      loadOrders()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  function openShippingModal(order) {
    setShippingModal(order)
  }

  async function openEpModal(order) {
    // Build one item per order line (or one blank if no lines)
    const orderLines = order.lines || []
    const items = orderLines.length > 0
      ? orderLines.map(l => ({
          _lineId: l.id,
          product_name: [l.fragrance_name, l.fg_product_name || productTypes.find(p => p.key === l.product_type)?.label || l.product_type].filter(Boolean).join(' — '),
          processing_type: 'labels',
          qty_requested: l.quantity ? String(l.quantity) : '',
          qty_sent: '',
          supplier: '',
          expected_return: '',
          client_label_id: l.label_client_label_id ? String(l.label_client_label_id) : '',
          notes: '',
          enabled: true,
        }))
      : [{ _lineId: null, product_name: '', processing_type: 'labels', qty_requested: '', qty_sent: '', supplier: '', expected_return: '', client_label_id: '', notes: '', enabled: true }]
    setEpModal({ order, items })
    setEpClientLabels([])
    if (order.client_id) {
      try {
        const res = await axios.get(`/api/clients/${order.client_id}/labels`, api())
        setEpClientLabels((res.data || []).filter(l => !l.is_obsolete))
      } catch {}
    }
  }

  async function handleSaveEp() {
    if (!epModal) return
    const { order, items } = epModal
    const enabledItems = items.filter(it => it.enabled)
    if (enabledItems.length === 0) { addToast('Enable at least one item', 'error'); return }
    const missingName = enabledItems.filter(it => !it.product_name.trim())
    if (missingName.length > 0) { addToast('Fill in "Product / Description" for all enabled items', 'error'); return }
    const missingQty = enabledItems.filter(it => it.processing_type === 'labels' ? !it.qty_requested : !it.qty_sent)
    if (missingQty.length > 0) {
      const isLabels = missingQty[0].processing_type === 'labels'
      addToast(isLabels ? 'Fill in "Qty Requested" for label items' : 'Fill in "Qty Sent" for candle/other items', 'error')
      return
    }
    const activeItems = enabledItems
    setEpSaving(true)
    try {
      for (const it of activeItems) {
        await axios.post('/api/external-processing', {
          production_order_id: order.id,
          client_id: order.client_id || null,
          product_name: it.product_name.trim(),
          processing_type: it.processing_type,
          qty_requested: it.qty_requested ? parseFloat(it.qty_requested) : null,
          qty_sent: parseFloat(it.qty_sent),
          supplier: it.supplier || null,
          expected_return: it.expected_return || null,
          notes: it.notes || null,
          client_label_id: it.client_label_id ? parseInt(it.client_label_id) : null,
          set_waiting: epModal.set_waiting && activeItems.indexOf(it) === activeItems.length - 1,
          production_order_line_id: it._lineId || null,
        }, api())
      }
      // Optionally mark order waiting if any item has set_waiting
      addToast(`External processing created — ${order.order_number} (${activeItems.length} item${activeItems.length > 1 ? 's' : ''})`)
      setEpModal(null)
      loadOrders()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setEpSaving(false) }
  }

  function updateEpItem(idx, field, value) {
    setEpModal(prev => {
      const items = [...prev.items]
      items[idx] = { ...items[idx], [field]: value }
      return { ...prev, items }
    })
  }

  async function handleFulfill() {
    try {
      await axios.put(`/api/production-orders/${fulfillTarget.id}/status`, { status: 'fulfilled' }, api())
      addToast(`${fulfillTarget.order_number} fulfilled`)
      setFulfillTarget(null)
      loadOrders()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  const STATUSES = ['ALL','draft','confirmed','queued','in_production','waiting_external','completed','ready_to_ship','fulfilled','cancelled']

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="ed-title">Production Orders</h1>
          <p className="ed-sub">Create, track and fulfil every order.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus size={15} /> New Order
        </Button>
      </div>
      <div className="ed-rule" style={{ margin: '22px 0 24px' }} />

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {STATUSES.map(s => {
          const m = STATUS_META[s]
          const active = statusFilter === s
          return (
            <button key={s} onClick={() => setStatusFilter(s)} style={{
              background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
              border: active ? '1px solid var(--border-h)' : '1px solid var(--border)',
              borderRadius: 20, padding: '4px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              color: active ? 'var(--accent-text)' : 'var(--text-secondary)'
            }}>{s === 'ALL' ? 'All' : m?.label || s}</button>
          )
        })}
        <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
        <button onClick={() => setMuseOnly(v => !v)} style={{
          background: museOnly ? 'var(--accent-soft)' : 'var(--surface-2)',
          border: museOnly ? '1px solid var(--border-h)' : '1px solid var(--border)',
          borderRadius: 20, padding: '4px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          color: museOnly ? 'var(--accent-text)' : 'var(--text-secondary)'
        }}>MUSE only</button>
      </div>

      {/* Orders list */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (() => {
        const displayOrders = museOnly ? orders.filter(o => !o.client_id) : orders
        if (displayOrders.length === 0) return <div style={{ textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 14, padding: 48 }}>No orders found</div>
        const renderOrderRow = (order, cardStyle = {}) => (
          <div key={order.id} style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', ...cardStyle }}>
            <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <button onClick={() => toggleExpand(order.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.5)', padding: 0 }}>
                {expanded === order.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{order.order_number}</span>
                  {statusFilter === 'ALL' ? null : <StatusBadge status={order.status} />}
                  {order.order_type === 'LARGE_CLIENT' && <Chip color="#a78bfa">Major Client</Chip>}
                  {!order.client_id && <Chip color="#fbbf24">MUSE</Chip>}
                  {order.shopify_draft_order_number && !order.shopify_order_number && <Chip color="#94a3b8">Shopify {order.shopify_draft_order_number}</Chip>}
                  {order.shopify_order_number && <Chip color="#60a5fa">Shopify {order.shopify_order_number}</Chip>}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)', marginTop: 3 }}>
                  {order.client_name || 'MUSE Internal'} · {order.lines?.length || 0} line{order.lines?.length !== 1 ? 's' : ''}
                  {order.due_date && (
                    <span style={{ marginLeft: 8, color: isOverdue(order.due_date) && !['fulfilled','cancelled'].includes(order.status) ? '#f87171' : 'rgba(232,234,242,0.4)' }}>
                      · Due {fmt(order.due_date)}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {order.status === 'draft' && !order.shopify_draft_order_id && (
                  <button onClick={() => sendToShopify(order)} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#60a5fa', fontSize: 11, fontWeight: 600 }}>
                    Shopify
                  </button>
                )}
                {order.status === 'draft' && (
                  <button onClick={() => queueManually(order)} title="Queue for production without Shopify" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#fbbf24', fontSize: 11, fontWeight: 600 }}>
                    Queue
                  </button>
                )}
                {order.status === 'confirmed' && (
                  <button onClick={() => queueManually(order)} style={{ background: 'var(--accent-soft)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600 }}>
                    Queue for Production
                  </button>
                )}
                {order.status === 'completed' && !order.client_id && (
                  <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 600, padding: '2px 8px' }}>In MUSE Stock</span>
                )}
                {order.status === 'completed' && order.client_id && (
                  <button onClick={() => openShippingModal(order)} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#34d399', fontSize: 11, fontWeight: 600 }}>
                    Ready to Ship
                  </button>
                )}
                {order.status === 'ready_to_ship' && order.client_id && (
                  <button onClick={() => openShippingModal(order)} title="Manage shipping labels" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                    <Package size={13} />
                  </button>
                )}
                {order.status === 'ready_to_ship' && order.client_id && (
                  <button onClick={() => setFulfillTarget(order)} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#4ade80', fontSize: 11, fontWeight: 600 }}>
                    Fulfilled
                  </button>
                )}
                {['draft','confirmed','queued'].includes(order.status) && (
                  <button onClick={() => openEpModal(order)} title="Create External Processing record" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#a78bfa', fontSize: 11, fontWeight: 600 }}>
                    External
                  </button>
                )}
                {order.status === 'draft' && (
                  <button onClick={async () => {
                    if (!orderDetail[order.id]?.lines) await loadDetail(order.id)
                    setEditingOrder(order.id)
                    setShowCreate(true)
                  }} title="Edit order" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                    <Edit2 size={13} />
                  </button>
                )}
                {['draft','cancelled'].includes(order.status) && (
                  <button onClick={() => setDeleteTarget(order)} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: '#f87171' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
            {expanded === order.id && (
              <OrderDetail order={orderDetail[order.id] || order} productTypes={productTypes} onRefresh={() => { loadOrders(); loadDetail(order.id) }} />
            )}
          </div>
        )

        if (statusFilter !== 'ALL') {
          return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{displayOrders.map(o => renderOrderRow(o))}</div>
        }

        const GROUP_ORDER = ['draft','confirmed','queued','in_production','waiting_external','completed','ready_to_ship','fulfilled','cancelled']
        const grouped = {}
        GROUP_ORDER.forEach(s => { grouped[s] = [] })
        displayOrders.forEach(o => { if (grouped[o.status]) grouped[o.status].push(o) })
        const activeGroups = GROUP_ORDER.filter(s => grouped[s].length > 0)
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {activeGroups.map(status => {
              const m = STATUS_META[status]
              const grpOrders = grouped[status]
              const isArchive = ['fulfilled','cancelled'].includes(status)
              return (
                <div key={status}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: m.color, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{m.label}</span>
                    <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', fontWeight: 600 }}>({grpOrders.length})</span>
                    <div style={{ flex: 1, height: 1, background: isArchive ? 'rgba(255,255,255,0.04)' : `${m.color}22` }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: isArchive ? 0.65 : 1 }}>
                    {grpOrders.map(o => renderOrderRow(o, { borderLeft: `3px solid ${m.color}55` }))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Create Order Modal */}
      {showCreate && (
        <CreateOrderModal
          editingOrder={editingOrder ? orderDetail[editingOrder] : null}
          productTypes={productTypes}
          onClose={() => { setShowCreate(false); setEditingOrder(null) }}
          onCreated={(order) => { const wasEditing = !!editingOrder; loadOrders(); setShowCreate(false); setEditingOrder(null); if (!wasEditing && order?.id) openEpModal(order) }}
        />
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Order {deleteTarget.order_number}</h2>
              <button className="modal-close" onClick={() => setDeleteTarget(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.6)', marginBottom: 18, lineHeight: 1.5 }}>
                What would you like to do with this order?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button onClick={handleCancel} style={{ background: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.3)', borderRadius: 8, padding: '10px 16px', color: '#fb923c', fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                  Cancel Order — marks as Cancelled, visible in history
                </button>
                <button onClick={handleDiscard} style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, padding: '10px 16px', color: '#f87171', fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                  Discard — permanently deletes (draft only)
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Keep order</button>
            </div>
          </div>
        </div>
      )}

      {fulfillTarget && (
        <ConfirmModal
          title="Mark as Fulfilled"
          message={`Mark order ${fulfillTarget.order_number} as fulfilled? This closes the order permanently.`}
          onConfirm={handleFulfill}
          onCancel={() => setFulfillTarget(null)}
        />
      )}

      {shippingModal && (
        <ShippingModal
          order={shippingModal}
          onClose={() => { setShippingModal(null); loadOrders() }}
          onStatusChange={loadOrders}
        />
      )}

      {/* External Processing Modal */}
      {epModal && (
        <div className="modal-overlay" style={{ alignItems: 'stretch', gap: 16 }}
          onClick={() => setEpModal(null)}>
          {/* Order summary side panel */}
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 16, padding: 22, width: 320, maxHeight: '90vh', overflowY: 'auto', alignSelf: 'center' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Order Reference</div>
            <div style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 15, color: '#e8eaf2', marginBottom: 4 }}>{epModal.order.order_number}</div>
            {epModal.order.client_name && <div style={{ fontSize: 12, color: '#a78bfa', marginBottom: 10 }}>{epModal.order.client_name}</div>}
            {epModal.order.due_date && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)', marginBottom: 12 }}>Due: <strong style={{ color: '#fbbf24' }}>{new Date(epModal.order.due_date).toLocaleDateString()}</strong></div>}

            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '12px 0' }} />

            <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Order Lines ({(epModal.order.lines || []).length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(epModal.order.lines || []).map((l, i) => {
                const lc = LINE_COLORS[i % LINE_COLORS.length]
                const flags = []
                if (l.needs_labeling) flags.push({ icon: '🏷', label: 'Needs labels', color: '#fbbf24' })
                if (l.needs_packing)  flags.push({ icon: '📦', label: 'Needs packing', color: '#60a5fa' })
                if (l.use_ready_formula) flags.push({ icon: '✨', label: 'Ready formula', color: '#fb923c' })
                const hasLabelDetail = l.label_name || l.labels_supplier || l.labels_eta || l.labels_order_qty
                return (
                  <div key={l.id || i} style={{ background: `${lc}12`, border: `1px solid ${lc}40`, borderLeft: `3px solid ${lc}`, borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 9, fontWeight: 800, color: lc, textTransform: 'uppercase', letterSpacing: 0.6 }}>Line {i + 1}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#e8eaf2' }}>
                        {l.fg_product_name || productTypes.find(p => p.key === l.product_type)?.label || l.product_type}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.6)' }}>
                      {l.fragrance_name && <span>{l.fragrance_name}{l.oil_pct ? ` · ${l.oil_pct}%` : ''} · </span>}
                      <strong style={{ color: '#e8eaf2' }}>{l.quantity} units</strong>
                    </div>
                    {flags.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {flags.map(f => (
                          <span key={f.label} style={{ background: `${f.color}18`, color: f.color, padding: '1px 6px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: 0.3 }}>
                            {f.icon} {f.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {hasLabelDetail && (
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed rgba(255,255,255,0.08)', fontSize: 9, color: 'rgba(232,234,242,0.55)', lineHeight: 1.5 }}>
                        {l.label_name && <div style={{ color: '#fbbf24', fontWeight: 700 }}>🏷 {l.label_name}</div>}
                        {l.labels_supplier && <div>Supplier: <strong style={{ color: 'rgba(232,234,242,0.8)' }}>{l.labels_supplier}</strong></div>}
                        {l.labels_eta && <div>ETA: <strong style={{ color: '#fbbf24' }}>{new Date(l.labels_eta).toLocaleDateString()}</strong></div>}
                        {l.labels_order_qty && <div>Order qty: <strong style={{ color: 'rgba(232,234,242,0.8)' }}>{l.labels_order_qty}</strong></div>}
                      </div>
                    )}
                  </div>
                )
              })}
              {(!epModal.order.lines || epModal.order.lines.length === 0) && (
                <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', fontStyle: 'italic' }}>No lines</div>
              )}
            </div>
          </div>

          <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{ alignSelf: 'center', maxWidth: 640 }}>
            <div className="modal-header">
              <div>
                <h2>External Processing</h2>
                <p style={{ color: '#a78bfa', fontWeight: 700 }}>{epModal.order.order_number}{epModal.order.client_name ? ` — ${epModal.order.client_name}` : ''}</p>
              </div>
              <button className="modal-close" onClick={() => setEpModal(null)}>×</button>
            </div>

            <div className="modal-body">

            {/* Per-line items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
              {epModal.items.map((item, idx) => (
                <div key={idx} style={{ background: item.enabled ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)', border: `1px solid ${item.enabled ? 'rgba(167,139,250,0.2)' : 'rgba(255,255,255,0.06)'}`, borderLeft: `4px solid ${LINE_COLORS[idx % LINE_COLORS.length]}${item.enabled ? '' : '55'}`, borderRadius: 12, padding: 14, opacity: item.enabled ? 1 : 0.5 }}>
                  {/* Header row: enable toggle + line label */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <input type="checkbox" checked={item.enabled} onChange={e => updateEpItem(idx, 'enabled', e.target.checked)} style={{ accentColor: '#a78bfa', width: 15, height: 15, cursor: 'pointer' }} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: LINE_COLORS[idx % LINE_COLORS.length], textTransform: 'uppercase', letterSpacing: '0.08em' }}>Item {idx + 1}</span>
                    {epModal.items.length > 1 && (
                      <button onClick={() => setEpModal(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }))}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(248,113,113,0.5)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>✕</button>
                    )}
                  </div>

                  {/* Type selector */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    {[['labels','Labels'],['candle_filling','Candle Fill'],['other','Other']].map(([v, l]) => (
                      <button key={v} onClick={() => updateEpItem(idx, 'processing_type', v)} style={{ flex: 1, background: item.processing_type === v ? 'rgba(167,139,250,0.2)' : 'rgba(255,255,255,0.04)', border: `1px solid ${item.processing_type === v ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.1)'}`, borderRadius: 7, padding: '5px 0', color: item.processing_type === v ? '#a78bfa' : 'rgba(232,234,242,0.45)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
                    ))}
                  </div>

                  {/* Product name */}
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Product / Description *</label>
                    <input value={item.product_name} onChange={e => updateEpItem(idx, 'product_name', e.target.value)}
                      placeholder="e.g. Clean Skin Black labels"
                      style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                  </div>

                  {/* Qty fields — labels = requested only; candle/other = sent + requested */}
                  <div style={{ display: 'grid', gridTemplateColumns: item.processing_type === 'labels' ? '1fr' : '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    {item.processing_type !== 'labels' && (
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Qty Sent *</label>
                        <input type="number" value={item.qty_sent} onChange={e => updateEpItem(idx, 'qty_sent', e.target.value)}
                          placeholder="0"
                          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                      </div>
                    )}
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Qty Requested *</label>
                      <input type="number" value={item.qty_requested} onChange={e => updateEpItem(idx, 'qty_requested', e.target.value)}
                        placeholder="0"
                        style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                  </div>

                  {/* Supplier + Expected Return */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Supplier</label>
                      <input value={item.supplier} onChange={e => updateEpItem(idx, 'supplier', e.target.value)}
                        placeholder="Print shop, filler..."
                        style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Expected Return</label>
                      <input type="date" value={item.expected_return} onChange={e => updateEpItem(idx, 'expected_return', e.target.value)}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                  </div>

                  {/* Client Label link (labels type only) */}
                  {item.processing_type === 'labels' && epClientLabels.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Link to Label Stock</label>
                      <select value={item.client_label_id} onChange={e => updateEpItem(idx, 'client_label_id', e.target.value)}
                        style={{ width: '100%', background: '#1e2035', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }}>
                        <option value="">— None —</option>
                        {epClientLabels.map(l => <option key={l.id} value={l.id}>{l.label_name} ({Number(l.quantity).toLocaleString()} in stock)</option>)}
                      </select>
                      {item.client_label_id && <div style={{ fontSize: 10, color: '#4ade80', marginTop: 4 }}>✓ Label stock will auto-update when return is registered</div>}
                    </div>
                  )}

                  {/* Notes */}
                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Notes</label>
                    <input value={item.notes} onChange={e => updateEpItem(idx, 'notes', e.target.value)}
                      placeholder="Any additional info..."
                      style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                </div>
              ))}
            </div>

            {/* Add item button */}
            <button onClick={() => setEpModal(prev => ({ ...prev, items: [...prev.items, { _lineId: null, product_name: '', processing_type: 'labels', qty_requested: '', qty_sent: '', supplier: '', expected_return: '', client_label_id: '', notes: '', enabled: true }] }))}
              style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 0', color: 'rgba(232,234,242,0.4)', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginBottom: 16 }}>
              + Add Item
            </button>

            {/* Mark waiting toggle */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={epModal.set_waiting || false} onChange={e => setEpModal(prev => ({ ...prev, set_waiting: e.target.checked }))} style={{ accentColor: '#a78bfa' }} />
                <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>Mark order as <strong style={{ color: '#a78bfa' }}>Waiting External</strong> until return</span>
              </label>
            </div>

            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEpModal(null)}>Skip</button>
              <button className="btn btn-primary" onClick={handleSaveEp} disabled={epSaving}>
                {epSaving ? 'Saving...' : `Create Record${epModal.items.filter(i => i.enabled).length > 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────
// ORDER DETAIL (expanded view)
// ─────────────────────────────────────────
function OrderDetail({ order, onRefresh, productTypes = [] }) {
  if (!order.lines) return <div style={{ padding: '12px 18px', color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>Loading...</div>

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: '16px 18px', background: 'rgba(0,0,0,0.12)' }}>
      {order.lines.map((line, i) => {
        const lc = LINE_COLORS[i % LINE_COLORS.length]
        return (
        <div key={line.id} style={{ marginBottom: i < order.lines.length - 1 ? 16 : 0, padding: '10px 12px', background: `${lc}08`, border: `1px solid ${lc}22`, borderLeft: `3px solid ${lc}`, borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: lc, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Line {line.line_number}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2' }}>{productTypes.find(p => p.key === line.product_type)?.label || line.fg_product_name || line.product_type}</span>
            <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>× {line.quantity}</span>
            {line.fragrance_name && <span style={{ fontSize: 12, color: '#a78bfa' }}>— {line.fragrance_name}</span>}
            {(() => { const pt = productTypes.find(p => p.key === line.product_type); return pt && !pt.is_candle && !pt.is_pure_oil && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>@ {line.oil_pct}% oil</span> })()}
          </div>
          {line.components && line.components.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {line.components.map((comp, ci) => (
                <div key={ci} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, background: `${lc}14`, border: `1px solid ${lc}33`, color: 'rgba(232,234,242,0.85)' }}>
                  {comp.product_name} — <strong>{Number(comp.quantity_required).toLocaleString()} {comp.unit}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
        )
      })}
      {order.notes && (
        <div style={{ marginTop: 14, padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 12, color: 'rgba(232,234,242,0.5)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
          Notes: {order.notes}
        </div>
      )}
      {order.external_processing && order.external_processing.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(251,146,60,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>External Processing</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {order.external_processing.map(ep => {
              const isPartial = ep.status === 'partial'
              const isDone = ep.status === 'done'
              const isLabels = ep.processing_type === 'labels'
              const refQty = isLabels ? parseFloat(ep.qty_requested || 0) : parseFloat(ep.qty_sent || 0)
              const remaining = refQty - parseFloat(ep.qty_returned || 0)
              const overdue = !isDone && ep.expected_return && new Date(ep.expected_return) < new Date()
              return (
                <div key={ep.id} style={{ background: isDone ? 'rgba(74,222,128,0.05)' : isPartial ? 'rgba(251,191,36,0.05)' : 'rgba(251,146,60,0.05)', border: `1px solid ${isDone ? 'rgba(74,222,128,0.15)' : isPartial ? 'rgba(251,191,36,0.2)' : 'rgba(251,146,60,0.15)'}`, borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: isDone ? '#4ade80' : isPartial ? '#fbbf24' : '#fb923c' }}>
                    {isDone ? '✓' : isPartial ? '⚠' : '↗'} {ep.processing_type?.toUpperCase()}
                  </span>
                  <span style={{ fontSize: 12, color: '#e8eaf2', flex: 1 }}>{ep.product_name}</span>
                  <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>
                    {isLabels ? 'requested' : 'sent'}: <strong style={{ color: 'rgba(232,234,242,0.8)' }}>{Number(refQty).toLocaleString()}</strong>
                    {!isLabels && ep.qty_requested > 0 && parseFloat(ep.qty_requested) !== parseFloat(ep.qty_sent) && (
                      <> · req: <strong style={{ color: 'rgba(232,234,242,0.6)' }}>{Number(ep.qty_requested).toLocaleString()}</strong></>
                    )}
                    {ep.qty_returned > 0 && <> · received: <strong style={{ color: isDone ? '#4ade80' : '#fbbf24' }}>{Number(ep.qty_returned).toLocaleString()}</strong></>}
                    {isPartial && <> · <span style={{ color: '#fbbf24' }}>{Number(remaining).toLocaleString()} outstanding</span></>}
                  </span>
                  {ep.expected_return && (
                    <span style={{ fontSize: 11, color: overdue ? '#f87171' : 'rgba(232,234,242,0.5)', fontWeight: overdue ? 700 : 400 }}>
                      ETA: {fmt(ep.expected_return)}{overdue ? ' ⚠' : ''}
                    </span>
                  )}
                  {ep.supplier && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{ep.supplier}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 11, color: 'rgba(232,234,242,0.3)' }}>
        Created {fmt(order.created_at)} · ID #{order.id}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────
// CREATE ORDER MODAL
// ─────────────────────────────────────────
function CreateOrderModal({ onClose, onCreated, productTypes = [], editingOrder = null }) {
  const isEditing = !!editingOrder?.id
  const [clients, setClients]       = useState([])
  const [fragrances, setFragrances] = useState([])
  const [oilOptions, setOilOptions] = useState([]) // D14: Fragrance Library oils for the current segment
  const [components, setComponents] = useState([])
  const [labels, setLabels]         = useState({}) // clientId → labels[]
  const [readyFormulas, setReadyFormulas] = useState({}) // fragranceId|oilId → rf[]
  const [clientProducts, setClientProducts] = useState([]) // products linked to selected major client
  const [fgProducts, setFgProducts] = useState([]) // dynamic FINISHED_GOOD products (no client)

  const [clientId, setClientId]     = useState(editingOrder?.client_id ? String(editingOrder.client_id) : '')
  const [clientSearch, setClientSearch] = useState(
    editingOrder ? (editingOrder.client_id ? (editingOrder.client_name || '') : 'MUSE Internal') : ''
  )
  const [showClientDrop, setShowClientDrop] = useState(false)
  const [creatingClient, setCreatingClient] = useState(false)
  const [orderType, setOrderType]   = useState(editingOrder?.order_type || 'STANDARD')
  const [dueDate, setDueDate]       = useState(editingOrder?.due_date ? String(editingOrder.due_date).slice(0, 10) : '')
  const [notes, setNotes]           = useState(editingOrder?.notes || '')
  // D14: which of the 4 usage buckets this order belongs to — same formula
  // used per-line below for masterOptions; hoisted so the Fragrance Library
  // picker only needs to (re)fetch when it actually changes, not per line.
  const orderSegment = orderType === 'LARGE_CLIENT' ? 'MAJOR' : (clientId ? 'STANDARD' : 'MUSE')
  const [lines, setLines]           = useState(() => {
    if (editingOrder?.lines?.length) {
      return editingOrder.lines.map((l, i) => ({
        _id: Date.now() + i,
        product_type: l.product_type || '',
        fragrance_id: l.fragrance_id ? String(l.fragrance_id) : '',
        oil_id: l.oil_id || '',
        variant_name: l.variant_name || '',
        oil_pct: l.oil_pct ?? 25,
        quantity: l.quantity != null ? String(l.quantity) : '',
        packaging_component_id: l.packaging_component_id ? String(l.packaging_component_id) : '',
        label_client_label_id: l.label_client_label_id ? String(l.label_client_label_id) : '',
        use_ready_formula: !!l.use_ready_formula,
        ready_formula_id: l.ready_formula_id ? String(l.ready_formula_id) : '',
        labels_supplier: l.labels_supplier || '',
        labels_eta: l.labels_eta ? String(l.labels_eta).slice(0, 10) : '',
        labels_order_qty: l.labels_order_qty != null ? String(l.labels_order_qty) : '',
        needs_labeling: !!l.needs_labeling,
        needs_packing: !!l.needs_packing,
      }))
    }
    return [{ ...EMPTY_LINE, _id: Date.now() }]
  })
  const [saving, setSaving]         = useState(false)
  const [bomPreview, setBomPreview] = useState([])
  const [bomOverrides, setBomOverrides] = useState({})
  const [bomRemoved, setBomRemoved] = useState({}) // key: `${lineIdx}_${product_id}` → true
  const [bomExpanded, setBomExpanded] = useState({})
  const [displacementPreview, setDisplacementPreview] = useState(null) // array of displacements (Major Client only)
  const [pendingPayload, setPendingPayload] = useState(null)
  const bomDebounce = useRef(null)
  const { addToast } = useToast()

  useEffect(() => {
    loadClients()
    loadFragrances()
    loadComponents()
    loadFgProducts()
    if (editingOrder?.client_id) {
      loadLabels(String(editingOrder.client_id))
      if (editingOrder.order_type === 'LARGE_CLIENT') loadClientProducts(editingOrder.client_id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // D14: (re)fetch the Fragrance Library picker whenever the order's usage
  // bucket changes — MUSE/STANDARD/MAJOR each see a different exclusivity-filtered list.
  useEffect(() => {
    loadOilOptions(orderSegment)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSegment])

  // Debounced BOM preview fetch
  useEffect(() => {
    if (bomDebounce.current) clearTimeout(bomDebounce.current)
    bomDebounce.current = setTimeout(async () => {
      const validLines = lines.filter(l => l.product_type && parseInt(l.quantity) > 0)
      if (validLines.length === 0) { setBomPreview([]); return }
      try {
        const payload = validLines.map((l, i) => {
          const pt = productTypes.find(p => p.key === l.product_type)
          const volume_ml = pt?.volume ?? null
          return {
            product_type: l.product_type,
            fragrance_id: l.oil_id ? null : (l.fragrance_id ? parseInt(l.fragrance_id) : null),
            oil_id: l.oil_id || null,
            oil_pct: parseFloat(l.oil_pct) || 25,
            quantity: parseInt(l.quantity),
            volume_ml,
            label_client_label_id: l.label_client_label_id ? parseInt(l.label_client_label_id) : null,
            use_client_stock: orderType === 'LARGE_CLIENT',
            is_large_client: orderType === 'LARGE_CLIENT',
            client_id: clientId ? parseInt(clientId) : null,
            needs_packing: l.needs_packing,
            needs_labeling: l.needs_labeling,
            use_ready_formula: l.use_ready_formula || false,
            ready_formula_id: l.ready_formula_id ? parseInt(l.ready_formula_id) : null,
            _lineIdx: lines.indexOf(l),
          }
        })
        const res = await axios.post('/api/bom-preview', { lines: payload }, api())
        // Map back to original line indices
        const preview = new Array(lines.length).fill([])
        validLines.forEach((l, i) => { preview[lines.indexOf(l)] = res.data[i] || [] })
        setBomPreview(preview)
        // Auto-expand BOM preview for all lines that have components
        setBomExpanded(prev => {
          const next = { ...prev }
          validLines.forEach(l => { next[lines.indexOf(l)] = true })
          return next
        })
      } catch {}
    }, 600)
  }, [lines, orderType])

  async function loadClients() {
    const res = await axios.get('/api/clients', api())
    setClients(res.data)
  }
  async function loadFragrances() {
    const res = await axios.get('/api/products', { ...api(), params: { category: 'FRAGRANCE' } })
    setFragrances(res.data)
  }
  // D14: Fragrance Library oil picker — segment-scoped (exclusivity-filtered) list.
  async function loadOilOptions(segment) {
    try {
      const res = await axios.get('/api/fragrance-library', { ...api(), params: { segment } })
      setOilOptions(res.data)
    } catch { setOilOptions([]) }
  }
  async function loadComponents() {
    const res = await axios.get('/api/products', { ...api(), params: { category: 'COMPONENT' } })
    setComponents(res.data)
  }
  async function loadClientProducts(cId) {
    const res = await axios.get('/api/products', { ...api(), params: { client_id: cId } })
    setClientProducts(res.data)
  }
  async function loadFgProducts() {
    try {
      const res = await axios.get('/api/products', { ...api(), params: { category: 'FINISHED_GOOD' } })
      setFgProducts(res.data.filter(p => !p.client_id))
    } catch {}
  }
  async function loadLabels(cId) {
    if (!cId || labels[cId]) return
    const res = await axios.get(`/api/clients/${cId}/labels`, api())
    setLabels(prev => ({ ...prev, [cId]: res.data.filter(l => !l.is_obsolete) }))
  }
  // D14: Ready Formula is keyed by whichever identity produced it — legacy sm
  // fragrance_id or a Fragrance Library oil_id — so the map is shared and just
  // needs the right query param for the lookup.
  async function loadReadyFormula(id, isOil = false) {
    if (!id || readyFormulas[id] !== undefined) return
    const res = await axios.get('/api/ready-formula/available', { ...api(), params: isOil ? { oil_id: id } : { fragrance_id: id } })
    setReadyFormulas(prev => ({ ...prev, [id]: res.data }))
  }

  async function handleInlineCreateClient() {
    const name = clientSearch.trim()
    if (!name || name === 'MUSE Internal') return
    setCreatingClient(true)
    try {
      const res = await axios.post('/api/clients', { name }, api())
      const newClient = res.data
      setClients(prev => [...prev, newClient].sort((a, b) => a.name.localeCompare(b.name)))
      onClientChange(newClient)
      addToast(`Client "${newClient.name}" created`)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to create client', 'error')
    } finally {
      setCreatingClient(false)
    }
  }

  function setLine(idx, updates) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...updates } : l))
  }

  function addLine() { setLines(prev => [...prev, { ...EMPTY_LINE, _id: Date.now() }]) }
  function removeLine(idx) { setLines(prev => prev.filter((_, i) => i !== idx)) }

  // When fragrance changes on a line, load ready formula
  function onFragranceChange(idx, fragId) {
    setLine(idx, { fragrance_id: fragId, use_ready_formula: false, ready_formula_id: '' })
    if (fragId) loadReadyFormula(fragId)
  }

  // When client changes, load their labels and (for major clients) their products
  function onClientChange(client) {
    setClientId(client.id)
    setClientSearch(client.name)
    setShowClientDrop(false)
    if (client.is_large_client) {
      setOrderType('LARGE_CLIENT')
      loadClientProducts(client.id)
    } else {
      setOrderType('STANDARD')
      setClientProducts([])
    }
    loadLabels(client.id)
  }

  // Formula calc for a line
  function calcFormula(line) {
    const pt = productTypes.find(p => p.key === line.product_type)
    const volume = pt?.volume ?? null
    if (!volume) return null
    const qty = parseInt(line.quantity) || 0
    if (qty === 0) return null

    if (pt?.is_candle) {
      const oilPctCandle = parseFloat(pt.default_oil_pct) || 12
      const oilMl = volume * (oilPctCandle / 100)
      return { oilMl: oilMl * qty, ethanolMl: 0, totalMl: oilMl * qty, isCandle: true }
    }
    if (pt?.is_pure_oil) {
      return { oilMl: volume * qty, ethanolMl: 0, totalMl: volume * qty, fullOil: true }
    }
    const oilPct = parseFloat(line.oil_pct) || 25
    const oilMl = volume * (oilPct / 100) * qty
    const ethanolMl = volume * ((100 - oilPct) / 100) * qty

    // Subtract ready formula if used
    let rf = null
    if (line.use_ready_formula && line.ready_formula_id) {
      const rfList = readyFormulas[line.oil_id || line.fragrance_id] || []
      rf = rfList.find(r => r.id === parseInt(line.ready_formula_id))
    }
    const rfMl = rf ? Math.min(rf.current_stock, oilMl + ethanolMl) : 0
    const remainingTotal = (oilMl + ethanolMl) - rfMl
    const remainingOil = remainingTotal * (oilPct / 100)
    const remainingEthanol = remainingTotal * ((100 - oilPct) / 100)

    return { oilMl, ethanolMl, totalMl: oilMl + ethanolMl, rfMl, remainingOil, remainingEthanol, remainingTotal }
  }

  // Group lines by fragrance/oil to show combined formula
  function getCombinedFormula() {
    const byFrag = {}
    for (const line of lines) {
      const key = line.oil_id || line.fragrance_id
      if (!key || !line.quantity) continue
      const pt = productTypes.find(p => p.key === line.product_type)
      if (!pt || pt.is_candle) continue
      const qty = parseInt(line.quantity) || 0
      const oilPct = pt.is_pure_oil ? 100 : (parseFloat(line.oil_pct) || 25)
      const oilMl = pt.volume * (oilPct / 100) * qty
      const ethanolMl = pt.is_pure_oil ? 0 : pt.volume * ((100 - oilPct) / 100) * qty
      if (!byFrag[key]) {
        const fragName = line.oil_id
          ? oilOptions.find(o => o.id === line.oil_id)?.name
          : fragrances.find(f => f.id === parseInt(line.fragrance_id))?.name
        byFrag[key] = { oilMl: 0, ethanolMl: 0, fragName }
      }
      byFrag[key].oilMl += oilMl
      byFrag[key].ethanolMl += ethanolMl
    }
    return byFrag
  }

  async function handleSave() {
    if (!lines.length) { addToast('Add at least one line item', 'error'); return }
    for (const l of lines) {
      if (!l.product_type || !l.quantity || parseInt(l.quantity) < 1) {
        addToast('All lines need a product type and quantity', 'error'); return
      }
    }
    setSaving(true)
    try {
      const payload = {
        client_id: clientId || null,
        order_type: orderType,
        due_date: dueDate || null,
        notes: notes || null,
        lines: lines.map((l, idx) => {
          // Collect overrides for this line
          const lineOverrides = Object.entries(bomOverrides)
            .filter(([key]) => key.startsWith(`${idx}_`))
            .map(([key, ovr]) => {
              const suffix = key.slice(`${idx}_`.length)
              return suffix.startsWith('label_')
                ? { label_id: parseInt(suffix.replace('label_', '')), ...ovr }
                : { product_id: parseInt(suffix), ...ovr }
            })
          // Add removed components as qty=0 overrides (server will DELETE them)
          Object.entries(bomRemoved)
            .filter(([key]) => key.startsWith(`${idx}_`))
            .forEach(([key]) => {
              const productId = parseInt(key.slice(`${idx}_`.length))
              if (!lineOverrides.find(o => o.product_id === productId))
                lineOverrides.push({ product_id: productId, quantity_required: 0, override_reason: 'Removed from order' })
            })
          const pt2 = productTypes.find(p => p.key === l.product_type)
          const volume_ml = pt2?.volume ?? null
          return {
            product_type: l.product_type,
            fragrance_id: l.oil_id ? null : (l.fragrance_id ? parseInt(l.fragrance_id) : null),
            oil_id: l.oil_id || null,
            variant_name: l.variant_name || null,
            oil_pct: parseFloat(l.oil_pct) || 25,
            quantity: parseInt(l.quantity),
            volume_ml,
            label_client_label_id: l.label_client_label_id ? parseInt(l.label_client_label_id) : null,
            labels_supplier: l.labels_supplier || null,
            labels_eta: l.labels_eta || null,
            labels_order_qty: l.labels_order_qty ? parseInt(l.labels_order_qty) : null,
            use_client_stock: orderType === 'LARGE_CLIENT',
            needs_packing: l.needs_packing,
            needs_labeling: l.needs_labeling,
            use_ready_formula: !!l.use_ready_formula,
            ready_formula_id: l.ready_formula_id ? parseInt(l.ready_formula_id) : null,
            component_overrides: lineOverrides,
          }
        })
      }
      // Major Client: check for displacement before submitting
      if (orderType === 'LARGE_CLIENT' && clientId && bomPreview.length > 0) {
        const allComps = []
        bomPreview.flat().forEach(c => {
          if (c.product_id && c.source === 'general_stock') {
            const existing = allComps.find(x => x.product_id === c.product_id)
            if (existing) existing.quantity_required += parseFloat(c.quantity_required || 0)
            else allComps.push({ product_id: c.product_id, quantity_required: parseFloat(c.quantity_required || 0) })
          }
        })
        if (allComps.length > 0) {
          const check = await axios.post('/api/reservations/check-displacement', {
            client_id: parseInt(clientId),
            components: allComps,
          }, api())
          if (check.data.any_displacement) {
            // Pause — show modal
            setDisplacementPreview(check.data.displacements)
            setPendingPayload(payload)
            setSaving(false)
            return
          }
        }
      }

      // No displacement needed (or not Major Client) — save directly
      await actuallyCreateOrder(payload, false)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to create order', 'error')
      setSaving(false)
    }
  }

  async function actuallyCreateOrder(payload, displaceLowPriority) {
    setSaving(true)
    try {
      let res
      if (isEditing) {
        res = await axios.put(`/api/production-orders/${editingOrder.id}`, payload, api())
        addToast(`Order ${editingOrder.order_number} updated`)
      } else {
        res = await axios.post('/api/production-orders', { ...payload, displace_low_priority: displaceLowPriority }, api())
        addToast(displaceLowPriority ? 'Order created — MUSE/Standard reservations displaced' : 'Production order created')
      }
      onCreated(res.data)
    } catch (e) {
      addToast(e.response?.data?.error || (isEditing ? 'Failed to update order' : 'Failed to create order'), 'error')
    } finally { setSaving(false) }
  }

  function confirmDisplacement() {
    const payload = pendingPayload
    setDisplacementPreview(null)
    setPendingPayload(null)
    if (payload) actuallyCreateOrder(payload, true)
  }

  function cancelDisplacement() {
    setDisplacementPreview(null)
    setPendingPayload(null)
  }

  const selectedClient = clients.find(c => c.id === parseInt(clientId))
  const filteredClients = clients.filter(c => c.name.toLowerCase().includes(clientSearch.toLowerCase()))
  const combined = getCombinedFormula()

  return (
    <div className="modal-overlay" onClick={onClose} style={{ alignItems: 'flex-start', overflowY: 'auto', paddingTop: 40, paddingBottom: 40 }}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2>{isEditing ? `Edit Order — ${editingOrder.order_number}` : 'New Production Order'}</h2>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal-body">

        {/* Order info */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 24 }}>
          {/* Client search */}
          <div style={{ gridColumn: '1 / -1', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <label style={{ ...lbl, marginBottom: 0 }}>Client</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#4ade80', cursor: 'pointer' }}>
                <input type="checkbox" checked={!clientId && clientSearch === 'MUSE Internal'} onChange={e => {
                  if (e.target.checked) { setClientId(''); setClientSearch('MUSE Internal'); setOrderType('STANDARD') }
                  else { setClientSearch('') }
                }} style={{ accentColor: '#4ade80' }} />
                MUSE Internal (no client)
              </label>
            </div>
            <input
              value={clientSearch === 'MUSE Internal' ? 'MUSE Internal — stock production' : clientSearch}
              onChange={e => { setClientSearch(e.target.value); setClientId(''); setShowClientDrop(true) }}
              onFocus={() => { if (clientSearch !== 'MUSE Internal') setShowClientDrop(true) }}
              onBlur={() => setTimeout(() => setShowClientDrop(false), 150)}
              placeholder="Search client... or tick MUSE Internal above"
              style={{ ...inp, color: clientSearch === 'MUSE Internal' ? '#4ade80' : '#e8eaf2' }}
              readOnly={clientSearch === 'MUSE Internal'}
            />
            {showClientDrop && (filteredClients.length > 0 || (clientSearch.trim() && clientSearch !== 'MUSE Internal' && !clients.find(c => c.name.toLowerCase() === clientSearch.trim().toLowerCase()))) && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--popover-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 8, zIndex: 100, maxHeight: 200, overflowY: 'auto' }}>
                {filteredClients.map(c => (
                  <div key={c.id} onMouseDown={() => onClientChange(c)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    {c.name}
                    {c.is_large_client && <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 700 }}>MAJOR</span>}
                  </div>
                ))}
                {clientSearch.trim() && clientSearch !== 'MUSE Internal' && !clients.find(c => c.name.toLowerCase() === clientSearch.trim().toLowerCase()) && (
                  <div onMouseDown={handleInlineCreateClient} style={{ padding: '8px 12px', cursor: creatingClient ? 'not-allowed' : 'pointer', fontSize: 13, color: '#4ade80', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, borderTop: filteredClients.length > 0 ? '1px solid rgba(255,255,255,0.06)' : undefined }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(34,197,94,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <Plus size={13} /> {creatingClient ? 'Creating...' : `Create "${clientSearch.trim()}"`}
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <label style={lbl}>Order Type</label>
            {(() => {
              const isMuse = clientSearch === 'MUSE Internal'
              const hasClient = !!selectedClient
              if (!isMuse && !hasClient) {
                return (
                  <div style={{ ...inp, color: 'rgba(232,234,242,0.35)', display: 'flex', alignItems: 'center', minHeight: 36, boxSizing: 'border-box', cursor: 'not-allowed' }}>
                    Select a client first
                  </div>
                )
              }
              const meta = isMuse
                ? { label: 'MUSE Internal', color: '#4ade80', bg: 'rgba(34,197,94,0.14)', hint: 'Internal stock production' }
                : selectedClient?.is_large_client
                  ? { label: 'Major Client', color: '#fbbf24', bg: 'rgba(251,191,36,0.14)', hint: 'Locked by client — change in Clients page' }
                  : { label: 'Standard', color: '#60a5fa', bg: 'rgba(96,165,250,0.14)', hint: 'Locked by client — change in Clients page' }
              return (
                <div title={meta.hint} style={{ ...inp, display: 'flex', alignItems: 'center', gap: 10, minHeight: 36, boxSizing: 'border-box', cursor: 'default' }}>
                  <span style={{ background: meta.bg, color: meta.color, padding: '3px 11px', borderRadius: 20, fontSize: 11, fontWeight: 800, letterSpacing: 0.3 }}>
                    {meta.label}
                  </span>
                  <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)' }}>{meta.hint}</span>
                </div>
              )
            })()}
          </div>
          <div>
            <label style={lbl}>Due Date</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={inp} />
          </div>
          <div>
            <label style={lbl}>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional — special instructions, observations..." rows={4} style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>

        {/* Line Items */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>Line Items</div>

          {lines.map((line, idx) => {
            const pt = productTypes.find(p => p.key === line.product_type)
            const formula = calcFormula(line)
            const rfKey = line.oil_id || line.fragrance_id
            const rfList = rfKey ? (readyFormulas[rfKey] || []) : []
            const clientLabels = clientId
              ? (labels[clientId] || []).filter(l => !l.is_obsolete && (!l.applicable_product_type || l.applicable_product_type === line.product_type))
              : []

            // Filter master options by current segment + client
            const segmentFor = orderType === 'LARGE_CLIENT' ? 'MAJOR' : (clientId ? 'STANDARD' : 'MUSE')
            const containerLabel = (p) => [
              p?.container_name,
              p?.volume ? `${p.volume}${p.volume_unit || 'ml'}` : null,
            ].filter(Boolean).join(' · ')
            const masterOptions = productTypes
              .filter(p => p.segment === segmentFor)
              .filter(p => segmentFor !== 'MAJOR' || p.client_id === parseInt(clientId || 0))
              .map(p => ({ value: p.key, label: p.label, sub: containerLabel(p) || undefined }))

            const lc = LINE_COLORS[idx % LINE_COLORS.length]
            return (
              <div key={line._id} style={{ background: `${lc}0f`, border: `1px solid ${lc}55`, borderLeft: `4px solid ${lc}`, borderRadius: 10, padding: 16, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: lc, textTransform: 'uppercase', letterSpacing: 0.6 }}>Line {idx + 1}</span>
                  {lines.length > 1 && (
                    <button onClick={() => removeLine(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171' }}><X size={14} /></button>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={lbl}>Master ({segmentFor})</label>
                    <SearchSelect
                      value={line.product_type}
                      onChange={v => {
                        const npt = productTypes.find(p => p.key === v)
                        const oilPct = npt?.is_pure_oil ? 100 : (npt?.default_oil_pct ?? 25)
                        const allowed = Array.isArray(npt?.fragrance_ids) ? npt.fragrance_ids : []
                        const patch = { product_type: v, oil_pct: oilPct }
                        // Auto-set fragrance for MUSE/MAJOR masters: lock to the single linked one,
                        // or clear if the current pick is no longer valid for this master.
                        if (allowed.length === 1) {
                          patch.fragrance_id = allowed[0]
                        } else if (allowed.length > 1 && line.fragrance_id && !allowed.includes(parseInt(line.fragrance_id))) {
                          patch.fragrance_id = ''
                        }
                        setLine(idx, patch)
                        if (patch.fragrance_id) onFragranceChange(idx, patch.fragrance_id)
                      }}
                      options={masterOptions}
                      clearable={false}
                      placeholder={masterOptions.length === 0 ? `No ${segmentFor} masters yet` : 'Select a master...'}
                    />
                    {pt && containerLabel(pt) && (
                      <div style={{ marginTop: 5 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'rgba(167,139,250,0.12)', color: '#a78bfa', padding: '2px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                          {containerLabel(pt)}
                          {pt.is_candle ? ' · Candle' : pt.is_pure_oil ? ' · Pure Oil' : ''}
                        </span>
                      </div>
                    )}
                  </div>
                  <div>
                    <label style={lbl}>Fragrance Library Oil</label>
                    <SearchSelect
                      value={line.oil_id}
                      onChange={v => {
                        setLine(idx, { oil_id: v, fragrance_id: '', use_ready_formula: false, ready_formula_id: '' })
                        if (v) loadReadyFormula(v, true)
                      }}
                      options={oilOptions.map(o => ({ value: o.id, label: o.name, sub: `${o.code} · ${Number(o.current_stock).toLocaleString()} ${o.unit}` }))}
                      clearable
                      placeholder={oilOptions.length === 0 ? `No oils available for ${segmentFor}` : 'Select an oil...'}
                    />
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', marginTop: 4 }}>
                      Shared Fragrance Library, filtered to {segmentFor} — exclusive oils from other businesses are hidden
                    </div>
                  </div>
                  <div>
                    <label style={lbl}>Qty</label>
                    <input type="number" min={1} value={line.quantity} onChange={e => setLine(idx, { quantity: e.target.value })} placeholder="0" style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>Oil %</label>
                    <input type="number" min={1} max={100} value={line.oil_pct} onChange={e => setLine(idx, { oil_pct: e.target.value })}
                      disabled={pt?.is_candle || pt?.is_pure_oil} style={{ ...inp, opacity: (pt?.is_candle || pt?.is_pure_oil) ? 0.5 : 1 }} />
                  </div>
                </div>

                {segmentFor === 'MUSE' && (
                  <div style={{ marginBottom: 12 }}>
                    <label style={lbl}>Commercial Name (optional)</label>
                    <input
                      value={line.variant_name}
                      onChange={e => setLine(idx, { variant_name: e.target.value })}
                      placeholder={`Defaults to the oil's own name (e.g. leave blank for "${oilOptions.find(o => o.id === line.oil_id)?.name || 'Santal'}")`}
                      style={inp}
                    />
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', marginTop: 4 }}>
                      The finished product can be sold under a different name than the oil itself — e.g. oil "Santal" sold as "Afterglow"
                    </div>
                  </div>
                )}

                {/* Label */}
                <div style={{ marginBottom: 12 }}>
                  <div>
                    <label style={lbl}>Label (optional)</label>
                    <SearchSelect
                      value={line.label_client_label_id}
                      onChange={v => setLine(idx, { label_client_label_id: v })}
                      options={clientLabels.map(l => ({ value: l.id, label: l.label_name, sub: `${l.artwork_version}${l.applicable_product_type ? ` · ${l.applicable_product_type}` : ''} · ${Number(l.quantity).toLocaleString()} units` }))}
                      placeholder="— None —"
                    />
                    {!clientId && <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', marginTop: 4 }}>Select a client to see labels</div>}
                    {(() => {
                      const selLabel = line.label_client_label_id ? clientLabels.find(l => l.id === parseInt(line.label_client_label_id)) : null
                      const deficit = selLabel && line.quantity ? parseInt(line.quantity) - parseInt(selLabel.quantity) : 0
                      if (!selLabel || deficit <= 0) return null
                      return (
                        <div style={{ marginTop: 6, padding: '10px 12px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 7 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>
                            ⚠ Insufficient labels — need {parseInt(line.quantity).toLocaleString()}, have {parseInt(selLabel.quantity).toLocaleString()} ({deficit} short)
                          </div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.55)', marginTop: 4 }}>
                            Request the missing labels in the <strong style={{ color: '#a78bfa' }}>External Processing</strong> step that opens after you create the order.
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                </div>

                {/* Manufacturing steps */}
                <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'rgba(232,234,242,0.75)', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={line.needs_labeling} onChange={e => setLine(idx, { needs_labeling: e.target.checked })} />
                    Needs Labeling
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'rgba(232,234,242,0.75)', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={line.needs_packing} onChange={e => setLine(idx, { needs_packing: e.target.checked })} />
                    Needs Packing
                  </label>
                </div>

                {/* Ready Formula suggestion */}
                {rfKey && rfList.length > 0 && !pt?.is_candle && !pt?.is_pure_oil && (
                  <div style={{ padding: '10px 12px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)', borderRadius: 8, marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: '#fb923c', fontWeight: 700, marginBottom: 6 }}>
                      ⚡ Ready Formula available — {rfList[0].name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(232,234,242,0.7)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={line.use_ready_formula} onChange={e => setLine(idx, { use_ready_formula: e.target.checked })} />
                        Use Ready Formula
                      </label>
                      {line.use_ready_formula && (
                        <div style={{ flex: 1 }}>
                          <SearchSelect
                            value={line.ready_formula_id}
                            onChange={v => setLine(idx, { ready_formula_id: v })}
                            options={rfList.map(rf => ({ value: rf.id, label: rf.name, sub: `${Number(rf.current_stock).toLocaleString()} ml available` }))}
                            placeholder="Select formula..."
                            clearable={false}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Formula preview */}
                {formula && line.quantity > 0 && (
                  <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 12 }}>
                    {formula.isCandle ? (
                      <span style={{ color: 'rgba(232,234,242,0.6)' }}>Fragrance needed: <strong style={{ color: '#a78bfa' }}>{formula.oilMl.toFixed(1)} ml</strong> · Candle jar × {line.quantity}</span>
                    ) : formula.fullOil ? (
                      <span style={{ color: 'rgba(232,234,242,0.6)' }}>Oil (100%): <strong style={{ color: '#a78bfa' }}>{formula.oilMl.toFixed(1)} ml</strong></span>
                    ) : (
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <span style={{ color: 'rgba(232,234,242,0.6)' }}>Total formula: <strong style={{ color: '#a78bfa' }}>{formula.totalMl.toFixed(1)} ml</strong></span>
                        {formula.rfMl > 0 && <span style={{ color: '#fb923c' }}>Ready Formula: {formula.rfMl.toFixed(1)} ml</span>}
                        <span style={{ color: 'rgba(232,234,242,0.6)' }}>Oil: <strong style={{ color: '#a78bfa' }}>{(formula.rfMl > 0 ? formula.remainingOil : formula.oilMl).toFixed(1)} ml</strong></span>
                        <span style={{ color: 'rgba(232,234,242,0.6)' }}>Ethanol: <strong style={{ color: '#60a5fa' }}>{(formula.rfMl > 0 ? formula.remainingEthanol : formula.ethanolMl).toFixed(1)} ml</strong></span>
                      </div>
                    )}
                  </div>
                )}

                {/* BOM Preview (editable) */}
                {(bomPreview[idx] || []).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => setBomExpanded(prev => ({ ...prev, [idx]: !prev[idx] }))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.5)', fontSize: 11, fontWeight: 700, padding: 0, textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      {bomExpanded[idx] ? '▼' : '▶'} BOM Preview
                    </button>

                    {bomExpanded[idx] && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {(bomPreview[idx] || []).map((comp, ci) => {
                          // Client-provided components (Large Client reserved stock) — informational only
                          if (comp.is_client_provided) {
                            const sufficient = parseFloat(comp.current_stock) >= parseFloat(comp.quantity_required)
                            return (
                              <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.15)', borderRadius: 7 }}>
                                <span style={{ fontSize: 12, minWidth: 14, color: '#a78bfa' }}>◈</span>
                                <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.8)', flex: 1 }}>{comp.product_name}</span>
                                <span style={{ fontSize: 10, color: sufficient ? 'rgba(167,139,250,0.7)' : '#f87171' }}>{Number(comp.current_stock).toLocaleString()} in client stock</span>
                                <span style={{ fontSize: 9, color: '#a78bfa', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: 4, padding: '1px 5px' }}>CLIENT</span>
                              </div>
                            )
                          }

                          const ovrKey = comp.product_id ? `${idx}_${comp.product_id}` : `${idx}_label_${comp.label_id}`
                          const ovr = bomOverrides[ovrKey]
                          const isRemoved = bomRemoved[ovrKey]
                          const displayQty = ovr ? ovr.quantity_required : comp.quantity_required
                          const effectiveStock = comp.available_stock ?? comp.current_stock
                          const sufficient = effectiveStock === null || parseFloat(effectiveStock) >= parseFloat(comp.quantity_required)
                          const reservedByOthers = comp.current_stock !== null && comp.available_stock !== undefined && comp.available_stock < comp.current_stock
                          if (isRemoved) return (
                            <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 7, opacity: 0.45 }}>
                              <span style={{ fontSize: 12, textDecoration: 'line-through', color: 'rgba(232,234,242,0.5)', flex: 1 }}>{comp.product_name} — {Number(comp.quantity_required).toLocaleString()} {comp.unit}</span>
                              <span style={{ fontSize: 10, color: '#f87171', fontWeight: 700 }}>REMOVED</span>
                              <button type="button" onClick={() => setBomRemoved(prev => { const n = { ...prev }; delete n[ovrKey]; return n })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4ade80', fontSize: 11, fontWeight: 700 }}>↩</button>
                            </div>
                          )
                          return (
                            <div key={ci} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px', background: sufficient ? 'rgba(255,255,255,0.03)' : 'rgba(220,38,38,0.06)', border: `1px solid ${sufficient ? 'rgba(255,255,255,0.07)' : 'rgba(220,38,38,0.2)'}`, borderRadius: 7 }}>
                              <span style={{ fontSize: 12, minWidth: 14 }}>{sufficient ? '✓' : '⚠'}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 12, color: '#e8eaf2', fontWeight: 600 }}>{comp.product_name}</span>
                                  <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    value={displayQty === null ? '' : Number(displayQty).toFixed(comp.unit === 'ml' ? 1 : 0)}
                                    onChange={e => {
                                      const val = parseFloat(e.target.value)
                                      if (!isNaN(val) && val !== comp.quantity_required) {
                                        setBomOverrides(prev => ({ ...prev, [ovrKey]: { ...prev[ovrKey], quantity_required: val, product_id: comp.product_id, label_id: comp.label_id } }))
                                      } else if (isNaN(val) || val === comp.quantity_required) {
                                        setBomOverrides(prev => { const n = { ...prev }; delete n[ovrKey]; return n })
                                      }
                                    }}
                                    style={{ width: 80, background: ovr ? 'rgba(251,191,36,0.08)' : 'rgba(255,255,255,0.06)', border: `1px solid ${ovr ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.1)'}`, borderRadius: 5, padding: '2px 6px', color: ovr ? '#fbbf24' : '#e8eaf2', fontSize: 11 }}
                                  />
                                  <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{comp.unit}</span>
                                  {comp.current_stock !== null && (
                                    <span style={{ fontSize: 10, color: sufficient ? 'rgba(74,222,128,0.7)' : '#f87171' }}>
                                      {Number(effectiveStock).toLocaleString()} available
                                      {reservedByOthers && (
                                        <span style={{ color: '#fbbf24', marginLeft: 4 }}>
                                          ({Number(comp.current_stock).toLocaleString()} total, {Number(comp.current_stock - effectiveStock).toLocaleString()} reserved)
                                        </span>
                                      )}
                                    </span>
                                  )}
                                  {ovr && <span style={{ fontSize: 10, color: '#fbbf24', fontWeight: 700 }}>OVERRIDDEN</span>}
                                </div>
                                {ovr && (
                                  <input
                                    placeholder="Reason for override..."
                                    value={ovr.override_reason || ''}
                                    onChange={e => setBomOverrides(prev => ({ ...prev, [ovrKey]: { ...prev[ovrKey], override_reason: e.target.value } }))}
                                    style={{ marginTop: 4, width: '100%', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 5, padding: '2px 6px', color: 'rgba(232,234,242,0.8)', fontSize: 11, outline: 'none' }}
                                  />
                                )}
                              </div>
                              {comp.product_id && (
                                <button type="button" title="Remove from this order"
                                  onClick={() => setBomRemoved(prev => ({ ...prev, [ovrKey]: true }))}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(248,113,113,0.5)', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                                  onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                                  onMouseLeave={e => e.currentTarget.style.color = 'rgba(248,113,113,0.5)'}
                                >×</button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          <button onClick={addLine} style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 10, padding: '10px 0', cursor: 'pointer', color: 'rgba(232,234,242,0.5)', fontSize: 13, fontWeight: 600 }}>
            + Add Line Item
          </button>
        </div>

        {/* Combined formula summary */}
        {Object.keys(combined).length > 0 && (
          <div style={{ marginBottom: 20, padding: 16, background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.15)', borderRadius: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Formula Summary</div>
            {Object.entries(combined).map(([fragId, data]) => (
              <div key={fragId} style={{ marginBottom: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: '#e8eaf2' }}>{data.fragName || `Fragrance #${fragId}`}</span>
                <span style={{ color: 'rgba(232,234,242,0.5)', marginLeft: 8 }}>
                  Total: <strong style={{ color: '#a78bfa' }}>{(data.oilMl + data.ethanolMl).toFixed(1)} ml</strong>
                  {' · '}Oil: <strong style={{ color: '#a78bfa' }}>{data.oilMl.toFixed(1)} ml</strong>
                  {data.ethanolMl > 0 && <>{' · '}Ethanol: <strong style={{ color: '#60a5fa' }}>{data.ethanolMl.toFixed(1)} ml</strong></>}
                </span>
              </div>
            ))}
          </div>
        )}

        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? (isEditing ? 'Saving...' : 'Creating...') : (isEditing ? 'Save Changes' : 'Create Order')}
          </button>
        </div>
      </div>

      {/* Displacement Confirmation Modal (Major Client priority) */}
      {displacementPreview && (
        <div className="modal-overlay" onClick={cancelDisplacement}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2><span style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 800, marginRight: 10, verticalAlign: 'middle' }}>MAJOR CLIENT PRIORITY</span>Stock Reservation Conflict</h2>
                <p>This Major Client order needs more stock than currently available. Confirming will <strong style={{ color: '#fbbf24' }}>displace lower-priority MUSE/Standard reservations</strong>.</p>
              </div>
              <button className="modal-close" onClick={cancelDisplacement}><X size={14} /></button>
            </div>
            <div className="modal-body">

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {displacementPreview.map((d, i) => (
                <div key={i} style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{d.product_name}</div>
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)', marginTop: 2 }}>{d.product_code}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>Need: <strong style={{ color: '#fbbf24' }}>{Number(d.required || 0).toLocaleString()}</strong> · Free: {Number(d.available || 0).toLocaleString()} {d.unit || 'units'}</div>
                      <div style={{ fontSize: 11, color: '#f87171', marginTop: 2 }}>Shortfall: {Number(d.shortfall || 0).toLocaleString()} {d.unit || 'units'}</div>
                    </div>
                  </div>
                  <div style={{ borderTop: '1px solid rgba(248,113,113,0.15)', paddingTop: 8, marginTop: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Will displace:</div>
                    {d.would_displace.map((w, wi) => (
                      <div key={wi} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
                        <span style={{ color: 'rgba(232,234,242,0.75)' }}>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{w.order_number}</span>
                          {w.client_name ? <span style={{ color: 'rgba(232,234,242,0.5)' }}> · {w.client_name}</span> : <span style={{ color: '#fbbf24' }}> · MUSE</span>}
                        </span>
                        <span style={{ color: '#f87171', fontWeight: 700 }}>−{Number(w.quantity_to_displace).toLocaleString()} {d.unit || 'units'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={cancelDisplacement}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmDisplacement}>Displace & Create Order</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }
const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none' }
const sel = { ...inp, cursor: 'pointer' }

// ─────────────────────────────────────────
// SHIPPING MODAL
// ─────────────────────────────────────────
const CARRIERS = ['Australia Post', 'DHL', 'FedEx', 'UPS', 'TNT', 'Toll', 'StarTrack', 'Other']

function ShippingModal({ order, onClose, onStatusChange }) {
  const [labels, setLabels]                   = useState([])
  const [easypostConfigured, setEasypost]     = useState(false)
  const [loading, setLoading]                 = useState(true)
  const [mode, setMode]                       = useState(null) // null | 'rates' | 'manual'
  const [currentStatus, setCurrentStatus]     = useState(order.status)
  const [markingReady, setMarkingReady]       = useState(false)

  // EasyPost states
  const [shipTo, setShipTo]   = useState('')
  const [weightKg, setWeightKg] = useState('')
  const [dims, setDims]         = useState({ l: '', w: '', h: '' })
  const [rates, setRates]       = useState([])
  const [shipmentId, setShipmentId] = useState('')
  const [gettingRates, setGettingRates] = useState(false)
  const [buyingRate, setBuyingRate]     = useState(null)

  // Manual states
  const [manualForm, setManualForm] = useState({ carrier: 'Australia Post', service: '', tracking_number: '', notes: '' })
  const [savingManual, setSavingManual] = useState(false)

  const { addToast } = useToast()

  useEffect(() => { loadLabels() }, [])

  async function loadLabels() {
    setLoading(true)
    try {
      const r = await axios.get(`/api/production-orders/${order.id}/shipping`, api())
      setLabels(r.data.labels)
      setEasypost(r.data.easypost_configured)
    } catch {}
    finally { setLoading(false) }
  }

  async function markReady() {
    setMarkingReady(true)
    try {
      await axios.put(`/api/production-orders/${order.id}/status`, { status: 'ready_to_ship' }, api())
      setCurrentStatus('ready_to_ship')
      onStatusChange?.()
      addToast(`${order.order_number} marked as Ready to Ship`)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setMarkingReady(false) }
  }

  async function getRates() {
    if (!shipTo.trim()) return addToast('Ship-to address required', 'error')
    setGettingRates(true)
    setRates([])
    try {
      const r = await axios.post('/api/shipping/rates', {
        production_order_id: order.id,
        to_address_string: shipTo,
        weight_kg: parseFloat(weightKg) || 1,
        length_cm: parseFloat(dims.l) || 30,
        width_cm:  parseFloat(dims.w) || 20,
        height_cm: parseFloat(dims.h) || 15,
      }, api())
      if (!r.data.configured) { addToast('EasyPost API key not configured', 'error'); return }
      setShipmentId(r.data.shipment_id)
      setRates(r.data.rates || [])
      if (!r.data.rates?.length) addToast('No rates returned for this address', 'error')
    } catch (e) { addToast(e.response?.data?.error || 'Failed to get rates', 'error') }
    finally { setGettingRates(false) }
  }

  async function buyRate(rate) {
    setBuyingRate(rate.id)
    try {
      await axios.post('/api/shipping/buy', {
        production_order_id: order.id,
        shipment_id: shipmentId,
        rate_id: rate.id,
        carrier: rate.carrier,
        service: rate.service,
        rate_amount: parseFloat(rate.rate),
        currency: rate.currency,
      }, api())
      addToast('Label purchased!')
      setMode(null)
      setRates([])
      loadLabels()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to buy label', 'error') }
    finally { setBuyingRate(null) }
  }

  async function saveManual() {
    if (!manualForm.tracking_number.trim()) return addToast('Tracking number required', 'error')
    setSavingManual(true)
    try {
      await axios.post('/api/shipping/manual', { production_order_id: order.id, ...manualForm }, api())
      addToast('Label saved')
      setMode(null)
      setManualForm({ carrier: 'Australia Post', service: '', tracking_number: '', notes: '' })
      loadLabels()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSavingManual(false) }
  }

  async function voidLabel(label) {
    try {
      await axios.delete(`/api/shipping/${label.id}`, api())
      addToast('Label voided')
      loadLabels()
    } catch { addToast('Failed to void', 'error') }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Package size={18} color="#60a5fa" />
              Shipping — {order.order_number}
            </h2>
            <p>
              {order.client_name || 'MUSE Internal'}
              {order.order_type === 'LARGE_CLIENT' && <span style={{ marginLeft: 8, color: '#a78bfa', fontSize: 10, fontWeight: 700 }}>MAJOR CLIENT</span>}
            </p>
          </div>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">

        {/* Status banner */}
        {currentStatus !== 'ready_to_ship' ? (
          <div style={{ marginBottom: 20, padding: 16, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 10 }}>
            <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.6)', marginBottom: 10 }}>
              Order is <strong style={{ color: '#4ade80' }}>Completed</strong>. Mark it as Ready to Ship to enable shipping.
            </div>
            <button onClick={markReady} disabled={markingReady} style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: 8, padding: '8px 18px', color: '#34d399', fontSize: 13, fontWeight: 700, cursor: markingReady ? 'not-allowed' : 'pointer', opacity: markingReady ? 0.7 : 1 }}>
              {markingReady ? 'Updating...' : '✓ Mark as Ready to Ship'}
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8 }}>
            <span style={{ fontSize: 12, color: '#34d399', fontWeight: 700 }}>✓ Ready to Ship</span>
          </div>
        )}

        {/* Labels list */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
            Shipping Labels {labels.length > 0 && <span style={{ color: '#60a5fa' }}>({labels.length})</span>}
          </div>
          {loading ? (
            <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.3)' }}>Loading...</div>
          ) : labels.length === 0 ? (
            <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.3)', padding: '10px 0' }}>No labels yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {labels.map(sl => (
                <div key={sl.id} style={{ padding: '10px 14px', background: sl.status === 'voided' ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)', border: `1px solid ${sl.status === 'voided' ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.1)'}`, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12, opacity: sl.status === 'voided' ? 0.5 : 1 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2' }}>{sl.carrier || 'Manual'}</span>
                      {sl.service && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{sl.service}</span>}
                      {sl.status === 'voided' && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 700, background: 'rgba(220,38,38,0.12)', padding: '1px 6px', borderRadius: 10 }}>VOIDED</span>}
                      {sl.rate && <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>${Number(sl.rate).toFixed(2)} {sl.currency || 'AUD'}</span>}
                    </div>
                    {sl.tracking_number && (
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#60a5fa', marginTop: 3 }}>{sl.tracking_number}</div>
                    )}
                    {sl.notes && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>{sl.notes}</div>}
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', marginTop: 2 }}>{new Date(sl.created_at).toLocaleDateString('en-AU')}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {sl.label_url && (
                      <a href={sl.label_url} target="_blank" rel="noreferrer" style={{ background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 6, padding: '4px 10px', color: '#60a5fa', fontSize: 11, fontWeight: 700, textDecoration: 'none' }}>Print</a>
                    )}
                    {sl.status !== 'voided' && (
                      <button onClick={() => voidLabel(sl)} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 6, padding: '4px 10px', color: '#f87171', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Void</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add label — action buttons */}
        {mode === null && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            {easypostConfigured && (
              <button onClick={() => setMode('rates')} style={{ flex: 1, background: 'rgba(96,165,250,0.08)', border: '1px dashed rgba(96,165,250,0.25)', borderRadius: 8, padding: '10px 0', color: '#60a5fa', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                + Generate Label via EasyPost
              </button>
            )}
            <button onClick={() => setMode('manual')} style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 0', color: 'rgba(232,234,242,0.6)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              + Enter Manually
            </button>
          </div>
        )}

        {/* EasyPost Rates */}
        {mode === 'rates' && (
          <div style={{ padding: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: 0.5 }}>Generate Label — EasyPost</span>
              <button onClick={() => { setMode(null); setRates([]) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.4)', fontSize: 11 }}>Cancel</button>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={lbl}>Ship-to Address</label>
              <textarea value={shipTo} onChange={e => setShipTo(e.target.value)} rows={3} placeholder="Full street address, city, state, postcode, country" style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
              <div><label style={lbl}>Weight (kg)</label><input type="number" min={0.1} step={0.1} value={weightKg} onChange={e => setWeightKg(e.target.value)} style={inp} placeholder="1.0" /></div>
              <div><label style={lbl}>L (cm)</label><input type="number" min={1} value={dims.l} onChange={e => setDims(d => ({ ...d, l: e.target.value }))} style={inp} placeholder="30" /></div>
              <div><label style={lbl}>W (cm)</label><input type="number" min={1} value={dims.w} onChange={e => setDims(d => ({ ...d, w: e.target.value }))} style={inp} placeholder="20" /></div>
              <div><label style={lbl}>H (cm)</label><input type="number" min={1} value={dims.h} onChange={e => setDims(d => ({ ...d, h: e.target.value }))} style={inp} placeholder="15" /></div>
            </div>
            <button onClick={getRates} disabled={gettingRates || !shipTo.trim()} style={{ background: '#2563eb', border: 'none', borderRadius: 8, padding: '8px 18px', color: 'white', fontSize: 13, fontWeight: 700, cursor: gettingRates || !shipTo.trim() ? 'not-allowed' : 'pointer', opacity: gettingRates || !shipTo.trim() ? 0.6 : 1, marginBottom: rates.length ? 14 : 0 }}>
              {gettingRates ? 'Getting Rates...' : 'Get Rates'}
            </button>
            {rates.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...rates].sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate)).map(rate => (
                  <div key={rate.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{rate.carrier}</span>
                      <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', marginLeft: 8 }}>{rate.service}</span>
                      {rate.delivery_days && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginLeft: 8 }}>{rate.delivery_days}d</span>}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>${parseFloat(rate.rate).toFixed(2)} {rate.currency}</span>
                    <button onClick={() => buyRate(rate)} disabled={!!buyingRate} style={{ background: '#2563eb', border: 'none', borderRadius: 6, padding: '6px 14px', color: 'white', fontSize: 12, fontWeight: 700, cursor: buyingRate ? 'not-allowed' : 'pointer', opacity: buyingRate ? 0.7 : 1 }}>
                      {buyingRate === rate.id ? '...' : 'Buy'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Manual entry */}
        {mode === 'manual' && (
          <div style={{ padding: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Manual Entry</span>
              <button onClick={() => setMode(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.4)', fontSize: 11 }}>Cancel</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={lbl}>Carrier</label>
                <select value={manualForm.carrier} onChange={e => setManualForm(f => ({ ...f, carrier: e.target.value }))} style={{ ...inp, cursor: 'pointer' }}>
                  {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Service (optional)</label>
                <input value={manualForm.service} onChange={e => setManualForm(f => ({ ...f, service: e.target.value }))} style={inp} placeholder="Express Post, Road Express..." />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Tracking Number *</label>
              <input value={manualForm.tracking_number} onChange={e => setManualForm(f => ({ ...f, tracking_number: e.target.value }))} style={inp} placeholder="Enter tracking number..." />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Notes (optional)</label>
              <input value={manualForm.notes} onChange={e => setManualForm(f => ({ ...f, notes: e.target.value }))} style={inp} placeholder="Any additional notes..." />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setMode(null)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 18px', color: '#e8eaf2', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={saveManual} disabled={savingManual || !manualForm.tracking_number.trim()} style={{ background: '#2563eb', border: 'none', borderRadius: 8, padding: '8px 18px', color: 'white', fontSize: 13, fontWeight: 700, cursor: savingManual || !manualForm.tracking_number.trim() ? 'not-allowed' : 'pointer', opacity: savingManual || !manualForm.tracking_number.trim() ? 0.6 : 1 }}>
                {savingManual ? 'Saving...' : 'Save Label'}
              </button>
            </div>
          </div>
        )}

        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
