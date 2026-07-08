import { useState, useEffect, useRef } from 'react'
import { Play, CheckCircle, Clock, X, AlertTriangle, ChevronDown, ChevronRight, Package, ClipboardList, ImageIcon, Flame, Tag, Truck, Undo2, RotateCw } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import SearchSelect from '../components/SearchSelect.jsx'
import { fmt, fmtDate } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

function ptLabel(line) { return line.fg_product_name || (line.product_type || '').replace(/_/g, ' ') }
function isOverdue(d) { return d && new Date(d) < new Date() }

// Quiet status chip — a small dot + label (refined), no filled pill, no emoji.
function Chip({ color, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {children}
    </span>
  )
}

// Same palette as the New Production Order form — keeps Line 1/2/3… consistent.
const LINE_COLORS = ['#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c']
const NOTES_PREVIEW_CHARS = 240

export default function ManufacturingQueue() {
  const [orders, setOrders]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [sortBy, setSortBy] = useState('due_date')
  const [expanded, setExpanded]   = useState(null)
  const [details, setDetails]     = useState({})
  const [modal, setModal]         = useState(null) // { type: 'complete'|'waiting', order }
  // line_leftovers[lineId] = { leftover_formula_ml, leftover_labels_qty, extra_fragrance_ml, extra_fragrance_reason }
  // extra_fragrance_ml: how many ml of the line's fragrance were added beyond the BOM
  //   (top-up during production). Backend debits that exact amount from the fragrance stock.
  //   Replaces the older "oil_adjusted + actual_oil_pct" flow which was harder to reason about.
  const [completeForm, setCompleteForm] = useState({ line_leftovers: {}, notes: '' })
  const [waitingForm, setWaitingForm]   = useState({ external_type: 'filling', external_supplier: '', external_expected_at: '' })
  const [notesExpanded, setNotesExpanded] = useState({}) // order.id → true when "Show more" clicked
  const [completionLeftovers, setCompletionLeftovers] = useState([])
  const [packingOrder, setPackingOrder] = useState(null)
  const [packingForm, setPackingForm]   = useState({ pallet_count: 1, packed_by: '', notes: '' })
  const [packingLineItems, setPackingLineItems] = useState({}) // { [line_id]: { boxes_for_line, products_per_box, partial_boxes } }
  const [packingPhotos, setPackingPhotos] = useState([])
  const [saving, setSaving]       = useState(false)
  const [packingSaving, setPackingSaving] = useState(false)
  const [lineModal, setLineModal]  = useState(null) // { type, orderId, lineId, lineNumber }
  const [lineModalForm, setLineModalForm] = useState({ supplier: '', eta: '' })
  const packingPhotoRef = useRef(null)
  const { addToast } = useToast()

  useEffect(() => { loadQueue() }, [typeFilter, sortBy])

  async function loadQueue() {
    setLoading(true)
    try {
      const params = { ...(typeFilter !== 'ALL' ? { order_type: typeFilter } : {}), sort: sortBy }
      const res = await axios.get('/api/manufacturing/queue', { ...api(), params })
      setOrders(res.data)
    } catch { addToast('Failed to load queue', 'error') }
    finally { setLoading(false) }
  }

  async function loadDetail(id) {
    try {
      const res = await axios.get(`/api/production-orders/${id}`, api())
      setDetails(prev => ({ ...prev, [id]: res.data }))
    } catch {}
  }

  function toggleExpand(id) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    loadDetail(id)
  }

  async function startProduction(order) {
    try {
      await axios.post(`/api/manufacturing/${order.id}/start`, {}, api())
      addToast(`Production started — ${order.order_number}`)
      loadQueue()
      if (expanded === order.id) loadDetail(order.id)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  // Move a queued order back to draft (Production Orders) so it can be cancelled/discarded
  // there. Only available before Start Production (status === 'queued'). Keeps line items
  // and reservations intact — the order simply leaves the warehouse queue.
  async function returnToDraft(order) {
    if (!confirm(`Return ${order.order_number} to Production Orders (draft)?\n\nThe order will leave the Manufacturing Queue. You can cancel or discard it from there.`)) return
    try {
      await axios.put(`/api/production-orders/${order.id}/status`, { status: 'draft' }, api())
      addToast(`${order.order_number} returned to Production Orders`)
      loadQueue()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleComplete() {
    setSaving(true)
    try {
      const line_leftovers = Object.entries(completeForm.line_leftovers)
        .map(([line_id, v]) => ({
          line_id: parseInt(line_id),
          leftover_formula_ml: parseFloat(v.leftover_formula_ml) || null,
          leftover_labels_qty: parseInt(v.leftover_labels_qty) || null,
          extra_fragrance_ml: parseFloat(v.extra_fragrance_ml) || null,
          extra_fragrance_reason: v.extra_fragrance_reason?.trim() || null,
        }))
        .filter(ll => ll.leftover_formula_ml || ll.leftover_labels_qty || ll.extra_fragrance_ml)

      await axios.post(`/api/manufacturing/${modal.order.id}/complete`, {
        line_leftovers,
        notes_on_completion: completeForm.notes || null,
      }, api())
      const hasFormula = line_leftovers.some(ll => ll.leftover_formula_ml)
      const hasLabels  = line_leftovers.some(ll => ll.leftover_labels_qty)
      const hasExtra   = line_leftovers.some(ll => ll.extra_fragrance_ml)
      let toastMsg = `Order ${modal.order.order_number} completed`
      if (hasFormula) toastMsg += ' · Formula → Ready Formula stock'
      if (hasLabels)  toastMsg += ' · Labels → Client stock'
      if (hasExtra)   toastMsg += ' · Extra fragrance debited'
      addToast(toastMsg)
      const completedOrder = modal.order
      setCompletionLeftovers(line_leftovers)
      setModal(null)
      loadQueue()
      // Open packing record — init per-line items
      setPackingOrder(completedOrder)
      const initItems = {}
      completedOrder.lines?.forEach(l => { initItems[l.id] = { boxes_for_line: '', products_per_box: '', partial_boxes: [] } })
      setPackingLineItems(initItems)
      setPackingForm({ pallet_count: 1, packed_by: '', notes: '' })
      setPackingPhotos([])
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleSavePacking() {
    if (!packingOrder) return
    // Validate: lines with quantity variance must have a reason
    for (const line of (packingOrder.lines || [])) {
      const li = packingLineItems[line.id] || {}
      const boxes = parseInt(li.boxes_for_line) || 0
      const perBox = parseInt(li.products_per_box) || 0
      const partialTotal = (li.partial_boxes || []).reduce((s, pb) => s + (parseInt(pb.products) || 0), 0)
      const totalPacked = boxes * perBox + partialTotal
      const ordered = parseInt(line.quantity) || 0
      if (totalPacked > 0 && totalPacked !== ordered && !li.quantity_variance_reason?.trim()) {
        addToast(`Line ${line.line_number}: reason required when packed quantity differs from ordered`, 'error')
        return
      }
    }
    setPackingSaving(true)
    try {
      const line_items = (packingOrder.lines || []).map(line => {
        const li = packingLineItems[line.id] || {}
        const boxes = parseInt(li.boxes_for_line) || 0
        const perBox = parseInt(li.products_per_box) || 0
        const partials = (li.partial_boxes || []).filter(pb => pb.products)
        const partialTotal = partials.reduce((s, pb) => s + (parseInt(pb.products) || 0), 0)
        const totalPacked = boxes * perBox + partialTotal
        const lo = completionLeftovers.find(l => l.line_id === line.id) || {}
        return {
          line_id: line.id,
          line_number: line.line_number,
          product_type: line.product_type,
          product_name: ptLabel(line),
          fragrance_name: line.fragrance_name || null,
          quantity_ordered: line.quantity,
          boxes_for_line: boxes || null,
          products_per_box: perBox || null,
          partial_boxes: partials,
          total_packed: totalPacked || null,
          quantity_variance_reason: li.quantity_variance_reason || null,
          leftover_formula_ml: lo.leftover_formula_ml || null,
          leftover_labels_qty: lo.leftover_labels_qty || null,
        }
      })
      await axios.post('/api/packing-records', {
        production_order_id: packingOrder.id,
        pallet_count: packingForm.pallet_count === '' ? 0 : (parseInt(packingForm.pallet_count) ?? 0),
        packed_by: packingForm.packed_by || null,
        notes: packingForm.notes || null,
        photos: packingPhotos,
        line_items,
      }, api())
      addToast('Packing record saved')
      setPackingOrder(null)
    } catch (e) { addToast(e.response?.data?.error || 'Save failed', 'error') }
    finally { setPackingSaving(false) }
  }

  function resizePackingPhoto(file) {
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = e => {
        const img = new Image()
        img.onload = () => {
          const MAX = 1200
          let w = img.width, h = img.height
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX }
            else { w = Math.round(w * MAX / h); h = MAX }
          }
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.75))
        }
        img.src = e.target.result
      }
      reader.readAsDataURL(file)
    })
  }

  async function handlePackingPhotos(files) {
    const arr = Array.from(files)
    const resized = await Promise.all(arr.map(f => resizePackingPhoto(f)))
    setPackingPhotos(prev => [...prev, ...resized])
  }

  function addLinePartialBox(lineId) {
    setPackingLineItems(prev => ({ ...prev, [lineId]: { ...prev[lineId], partial_boxes: [...(prev[lineId]?.partial_boxes || []), { products: '' }] } }))
  }
  function updateLinePartialBox(lineId, i, val) {
    setPackingLineItems(prev => {
      const pb = [...(prev[lineId]?.partial_boxes || [])]
      pb[i] = { products: val }
      return { ...prev, [lineId]: { ...prev[lineId], partial_boxes: pb } }
    })
  }
  function removeLinePartialBox(lineId, i) {
    setPackingLineItems(prev => ({ ...prev, [lineId]: { ...prev[lineId], partial_boxes: (prev[lineId]?.partial_boxes || []).filter((_, idx) => idx !== i) } }))
  }

  async function lineAction(orderId, lineId, action, body = {}) {
    try {
      await axios.post(`/api/manufacturing/${orderId}/lines/${lineId}/${action}`, body, api())
      addToast(`Line updated`)
      loadQueue()
      if (expanded === orderId) loadDetail(orderId)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleLineModal() {
    if (!lineModal) return
    setSaving(true)
    try {
      await axios.post(`/api/manufacturing/${lineModal.orderId}/lines/${lineModal.lineId}/${lineModal.type}`, lineModalForm, api())
      addToast('Updated')
      setLineModal(null)
      loadQueue()
      if (expanded === lineModal.orderId) loadDetail(lineModal.orderId)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleMarkWaiting() {
    setSaving(true)
    try {
      await axios.put(`/api/production-orders/${modal.order.id}/status`, {
        status: 'waiting_external',
        external_type: waitingForm.external_type,
        external_supplier: waitingForm.external_supplier || null,
        external_expected_at: waitingForm.external_expected_at || null,
      }, api())
      addToast('Marked as Waiting External')
      setModal(null)
      loadQueue()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  const statusLabel = { queued: 'Queued', in_production: 'In Production', waiting_external: 'Waiting External' }
  const statusColor = { queued: '#fbbf24', in_production: '#f472b6', waiting_external: '#a78bfa' }

  return (
    <div style={{ padding: 28 }}>
      <div className="ed-head">
        <h1 className="ed-title">Manufacturing Queue</h1>
        <p className="ed-sub">Orders with reserved stock, ready for the bench.</p>
        <div className="ed-rule" />
      </div>

      {/* Filters + Sort */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['ALL','All'],['STANDARD','Standard'],['LARGE_CLIENT','Major Client'],['CANDLE','Candle']].map(([k,l]) => (
          <button key={k} onClick={() => setTypeFilter(k)} style={{
            background: typeFilter === k ? 'var(--accent)' : 'var(--surface-2)',
            color: typeFilter === k ? '#fff' : 'var(--text-secondary)',
            border: typeFilter === k ? '1px solid var(--accent)' : '1px solid var(--border)',
            borderRadius: 20, padding: '5px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer'
          }}>{l}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="eyebrow" style={{ marginRight: 2 }}>Sort</span>
          {[['due_date','Due Date'],['client','Client'],['created','Created']].map(([k,l]) => (
            <button key={k} onClick={() => setSortBy(k)} style={{
              background: sortBy === k ? 'var(--accent-soft)' : 'var(--surface-2)',
              color: sortBy === k ? 'var(--accent-text)' : 'var(--text-secondary)',
              border: sortBy === k ? '1px solid var(--border-h)' : '1px solid var(--border)',
              borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer'
            }}>{l}</button>
          ))}
          <button onClick={loadQueue} title="Refresh" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><RotateCw size={14} /></button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'rgba(232,234,242,0.3)' }}>
          <CheckCircle size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
          <div style={{ fontSize: 14 }}>Queue is empty</div>
        </div>
      ) : (() => {
        const GROUP_ORDER = ['queued', 'in_production', 'waiting_external']
        const grouped = {}
        GROUP_ORDER.forEach(s => { grouped[s] = [] })
        orders.forEach(o => { if (grouped[o.status]) grouped[o.status].push(o) })
        const activeGroups = GROUP_ORDER.filter(s => grouped[s].length > 0)

        const renderOrderCard = (order) => {
          const detail = details[order.id]
          const status = order.status
          const sc = statusColor[status] || '#e8eaf2'
          const hasLabelsShort = order.labels_short
          const labelsEta = order.labels_eta
          return (
            <div key={order.id} style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                {/* Main row */}
                <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
                  <button onClick={() => toggleExpand(order.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.5)', padding: 0 }}>
                    {expanded === order.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>

                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 5, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{order.order_number}</span>
                      <Chip color={sc}>{statusLabel[status]}</Chip>
                      {order.order_type === 'LARGE_CLIENT' && <Chip color="#a78bfa">Major Client</Chip>}
                      {!order.client_id && <Chip color="#fbbf24">MUSE</Chip>}
                      {order.stock_reserved
                        ? <Chip color="#4ade80">Stock reserved</Chip>
                        : <Chip color="#f87171">Stock not reserved</Chip>
                      }
                      {hasLabelsShort && (
                        <Chip color="#fbbf24">Labels short{labelsEta ? ` — ETA ${fmtDate(labelsEta)}` : ''}</Chip>
                      )}
                      {order.lines?.some(l => l.labels_ep_id) && (() => {
                        const epLines = order.lines.filter(l => l.labels_ep_id)
                        const allDone = epLines.every(l => l.labels_ep_status === 'done' || l.labels_ep_status === 'closed')
                        const anyPartial = epLines.some(l => l.labels_ep_status === 'partial')
                        if (allDone) return <Chip color="#4ade80">Labels received</Chip>
                        if (anyPartial) return <Chip color="#fbbf24">Labels partial</Chip>
                        const eta = epLines.map(l => l.labels_ep_eta).filter(Boolean).sort()[0]
                        return <Chip color="#a78bfa">Labels requested{eta ? ` — ETA ${fmtDate(eta)}` : ''}</Chip>
                      })()}
                    </div>
                    <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                      {order.client_name || 'MUSE Internal'}
                      {order.due_date && (
                        <span style={{ marginLeft: 10, color: isOverdue(order.due_date) ? '#f87171' : 'rgba(232,234,242,0.4)' }}>
                          · Due {fmtDate(order.due_date)}
                        </span>
                      )}
                    </div>
                    {order.lines && (
                      <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', marginTop: 3 }}>
                        {order.lines.map(l => `${ptLabel(l)} ×${l.quantity}`).join(' + ')}
                      </div>
                    )}
                    {order.job && (
                      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginTop: 3 }}>
                        Started {fmt(order.job.started_at)}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    {status === 'queued' && (
                      <>
                        <button onClick={() => returnToDraft(order)} title="Send back to Production Orders (cancel/discard there)" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', color: 'rgba(232,234,242,0.6)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Undo2 size={13} /> Return to Orders
                        </button>
                        <button onClick={() => startProduction(order)} style={{ background: 'rgba(244,114,182,0.15)', border: '1px solid rgba(244,114,182,0.3)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', color: '#f472b6', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Play size={13} /> Start Production
                        </button>
                      </>
                    )}
                    {status === 'in_production' && (() => {
                      const allLinesDone = detail?.lines?.length > 0 && detail.lines.every(l => l.line_status === 'done')
                      const linesLoaded = !!detail?.lines
                      const canComplete = !linesLoaded || allLinesDone
                      return (
                        <>
                          <button onClick={() => { setModal({ type: 'waiting', order }); setWaitingForm({ external_type: 'filling', external_supplier: '', external_expected_at: '' }) }} style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', color: '#a78bfa', fontSize: 11, fontWeight: 700 }}>
                            Mark Waiting
                          </button>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                            <button onClick={() => { if (!canComplete) return; const initLL = {}; order.lines?.forEach(l => { initLL[l.id] = { leftover_formula_ml: '', leftover_labels_qty: '', extra_fragrance_ml: '', extra_fragrance_reason: '' } }); setModal({ type: 'complete', order }); setCompleteForm({ line_leftovers: initLL, notes: '' }) }} style={{ background: canComplete ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${canComplete ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)'}`, borderRadius: 8, padding: '7px 14px', cursor: canComplete ? 'pointer' : 'not-allowed', color: canComplete ? '#4ade80' : 'rgba(232,234,242,0.25)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                              <CheckCircle size={13} /> Complete
                            </button>
                            {linesLoaded && !allLinesDone && (
                              <span style={{ fontSize: 10, color: '#fbbf24' }}>
                                {detail.lines.filter(l => l.line_status !== 'done').length} line(s) pending
                              </span>
                            )}
                          </div>
                        </>
                      )
                    })()}
                    {status === 'waiting_external' && (
                      <button onClick={() => { axios.put(`/api/production-orders/${order.id}/status`, { status: 'in_production' }, api()).then(() => { addToast('Back to In Production'); loadQueue() }) }} style={{ background: 'rgba(244,114,182,0.12)', border: '1px solid rgba(244,114,182,0.25)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', color: '#f472b6', fontSize: 11, fontWeight: 700 }}>
                        Resume Production
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded — Line Steps + BOM */}
                {expanded === order.id && detail && (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.12)' }}>

                    {/* Order Notes */}
                    {detail.notes && (() => {
                      const isLong = detail.notes.length > NOTES_PREVIEW_CHARS
                      const expanded = !!notesExpanded[order.id]
                      const shown = isLong && !expanded ? detail.notes.slice(0, NOTES_PREVIEW_CHARS).trimEnd() + '…' : detail.notes
                      return (
                        <div style={{ padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', marginTop: 1 }}>Notes</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.6)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{shown}</span>
                            {isLong && (
                              <button onClick={() => setNotesExpanded(prev => ({ ...prev, [order.id]: !expanded }))}
                                style={{ marginLeft: 6, background: 'none', border: 'none', color: '#60a5fa', fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                                {expanded ? 'Show less' : 'Show more'}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })()}

                    {/* Combined Materials Summary */}
                    {detail.lines?.some(l => l.components?.length > 0) && (() => {
                      const combined = {}
                      detail.lines.forEach(l => {
                        l.components?.forEach(c => {
                          const key = c.product_id ? `p_${c.product_id}` : `n_${c.product_name}`
                          if (!combined[key]) combined[key] = { product_name: c.product_name, unit: c.unit, quantity_required: 0, current_stock: c.current_stock, product_id: c.product_id }
                          combined[key].quantity_required += parseFloat(c.quantity_required) || 0
                        })
                      })
                      const rows = Object.values(combined)
                      if (rows.length === 0) return null
                      return (
                        <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.35)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Materials Summary</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {rows.map((c, i) => (
                              <div key={i} style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(232,234,242,0.75)' }}>
                                {c.product_name} <strong>{Number(c.quantity_required.toFixed(1)).toLocaleString()} {c.unit}</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })()}

                    {detail.lines?.map((line, li) => {
                      const isCandle = line.is_candle
                      const ls = line.line_status || 'pending'
                      const cs = line.candle_status
                      const isDone = ls === 'done'
                      const isInProd = order.status === 'in_production'
                      const needsLabel = line.needs_labeling
                      const needsPack = line.needs_packing
                      const lc = LINE_COLORS[li % LINE_COLORS.length]

                      return (
                        <div key={line.id} style={{ padding: '14px 20px', borderBottom: li < detail.lines.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', borderLeft: `3px solid ${lc}`, background: `${lc}08` }}>
                          {/* Line header */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {isCandle ? <Flame size={13} color="#fbbf24" /> : <Package size={13} color={lc} />}
                              <span style={{ fontSize: 10, fontWeight: 800, color: lc, textTransform: 'uppercase', letterSpacing: 0.5 }}>Line {line.line_number}</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2' }}>
                                {ptLabel(line)} × {line.quantity}
                              </span>
                              {line.fragrance_name && <span style={{ fontSize: 12, color: '#a78bfa' }}>— {line.fragrance_name}</span>}
                              {isDone && <span style={{ fontSize: 10, background: 'rgba(34,197,94,0.15)', color: '#4ade80', padding: '1px 8px', borderRadius: 20, fontWeight: 700 }}>✓ DONE</span>}
                            </div>
                            {/* Step pills */}
                            <div style={{ display: 'flex', gap: 4 }}>
                              {isCandle && (
                                <StepPill label="Send" done={['filling_done','labeling_done','done'].includes(ls) || cs === 'received_from_filling'} active={ls === 'sent_for_filling'} waiting />
                              )}
                              <StepPill label="Filling" done={['filling_done','labeling_done','done'].includes(ls)} active={ls === 'pending' && !isCandle} />
                              {needsLabel && <StepPill label="Label" done={['labeling_done','done'].includes(ls)} active={ls === 'filling_done'} />}
                              {needsPack && <StepPill label="Pack" done={ls === 'done'} active={ls === 'labeling_done' || (ls === 'filling_done' && !needsLabel)} />}
                              <StepPill label="Done" done={isDone} />
                            </div>
                          </div>

                          {/* BOM components */}
                          {line.components?.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                              {line.components.map((comp, ci) => (
                                <div key={ci} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(232,234,242,0.65)' }}>
                                  {comp.product_name} <strong>{Number(comp.quantity_required).toLocaleString()} {comp.unit}</strong>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Labels EP status */}
                          {line.labels_ep_id && (() => {
                            const epSt = line.labels_ep_status
                            const isDoneEp = epSt === 'done' || epSt === 'closed'
                            const isPartial = epSt === 'partial'
                            const received = parseFloat(line.labels_ep_qty_returned || 0)
                            const requested = parseFloat(line.labels_ep_qty_requested || 0)
                            const color = isDoneEp ? '#4ade80' : isPartial ? '#fbbf24' : '#a78bfa'
                            const overdue = line.labels_ep_eta && new Date(line.labels_ep_eta) < new Date()
                            return (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', background: isDoneEp ? 'rgba(34,197,94,0.06)' : 'rgba(167,139,250,0.07)', border: `1px solid ${color}30`, borderRadius: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 10, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                  {isDoneEp ? '✓ Labels received' : isPartial ? '⚠ Labels partial' : '⏳ Labels requested'}
                                </span>
                                {line.labels_ep_supplier && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.55)' }}>{line.labels_ep_supplier}</span>}
                                {requested > 0 && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{received}/{requested} received</span>}
                                {!isDoneEp && line.labels_ep_eta && (
                                  <span style={{ fontSize: 11, fontWeight: 700, color: overdue ? '#f87171' : '#fbbf24' }}>
                                    ETA: {fmtDate(line.labels_ep_eta)}{overdue ? ' ⚠' : ''}
                                  </span>
                                )}
                              </div>
                            )
                          })()}

                          {/* Action buttons — only when in_production */}
                          {isInProd && !isDone && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              {/* Step 1: Candle — send for external filling */}
                              {isCandle && ls === 'pending' && (
                                <LineBtn color="#fbbf24" onClick={() => { setLineModal({ type: 'send-for-filling', orderId: order.id, lineId: line.id, lineNumber: line.line_number }); setLineModalForm({ supplier: '', eta: '' }) }}>
                                  <Truck size={14} /> Send for Filling
                                </LineBtn>
                              )}
                              {/* Candle waiting for return */}
                              {isCandle && ls === 'sent_for_filling' && (
                                <>
                                  <span style={{ fontSize: 11, color: '#fbbf24' }}>Sent to {line.filling_supplier || '?'} · {fmt(line.sent_for_filling_at)}</span>
                                  <LineBtn color="#4ade80" onClick={() => lineAction(order.id, line.id, 'receive-from-filling')}>
                                    <CheckCircle size={14} /> Received from Filling
                                  </LineBtn>
                                </>
                              )}
                              {/* Step 1: Non-candle — filling done */}
                              {!isCandle && ls === 'pending' && (
                                <LineBtn color="#60a5fa" onClick={() => lineAction(order.id, line.id, 'filling-done')}>
                                  <CheckCircle size={14} /> Filling Done
                                </LineBtn>
                              )}
                              {/* Step 2: Labeling (only if needs_labeling and filling done) */}
                              {needsLabel && ls === 'filling_done' && (
                                <LineBtn color="#e879f9" onClick={() => lineAction(order.id, line.id, 'labeling-done')}>
                                  <Tag size={14} /> Labeling Done
                                </LineBtn>
                              )}
                              {/* Step 3: Packing */}
                              {needsPack && (ls === 'labeling_done' || (ls === 'filling_done' && !needsLabel)) && (
                                <LineBtn color="#4ade80" onClick={() => lineAction(order.id, line.id, 'packing-done')}>
                                  <Package size={14} /> Packing Done
                                </LineBtn>
                              )}
                            </div>
                          )}
                          {isInProd && isDone && (
                            <div style={{ fontSize: 11, color: '#4ade80' }}>
                              ✓ Line complete {line.line_completed_at ? `· ${fmt(line.line_completed_at)}` : ''}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
        }

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {activeGroups.map(status => {
              const sc = statusColor[status] || '#e8eaf2'
              const grpOrders = grouped[status]
              return (
                <div key={status}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: sc, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: sc, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{statusLabel[status]}</span>
                    <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', fontWeight: 600 }}>({grpOrders.length})</span>
                    <div style={{ flex: 1, height: 1, background: `${sc}22` }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {grpOrders.map(order => renderOrderCard(order))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Complete Modal */}
      {modal?.type === 'complete' && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Complete Production</h2>
                <p style={{ color: '#a78bfa', fontWeight: 700 }}>{modal.order.order_number} — {modal.order.client_name}</p>
              </div>
              <button className="modal-close" onClick={() => setModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">

            {/* Per-line: Leftover Formula + Leftover Labels + Extra Fragrance (top-up) */}
            {(modal.order.lines || []).map((line, li) => {
              const ll = completeForm.line_leftovers[line.id] || {}
              const setLL = (field, val) => setCompleteForm(f => ({ ...f, line_leftovers: { ...f.line_leftovers, [line.id]: { ...f.line_leftovers[line.id], [field]: val } } }))
              const fragName = line.fragrance_name
              return (
                <div key={line.id} style={{ marginBottom: 14, padding: '14px 16px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2', marginBottom: 10 }}>
                    Line {line.line_number}: {ptLabel(line)} × {line.quantity}
                    {fragName && <span style={{ color: '#a78bfa', fontWeight: 400, marginLeft: 6 }}>— {fragName}</span>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: line.needs_labeling ? '1fr 1fr' : '1fr', gap: 12 }}>
                    <F label="Leftover Formula (ml)">
                      <input type="number" min={0} value={ll.leftover_formula_ml || ''} onChange={e => setLL('leftover_formula_ml', e.target.value)} placeholder="0" style={inp} />
                    </F>
                    {line.needs_labeling && (
                      <F label="Leftover Labels (units)">
                        <input type="number" min={0} value={ll.leftover_labels_qty || ''} onChange={e => setLL('leftover_labels_qty', e.target.value)} placeholder="0" style={inp} />
                      </F>
                    )}
                  </div>
                  {parseFloat(ll.leftover_formula_ml) > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: '#fb923c' }}>→ {ll.leftover_formula_ml} ml saved as Ready Formula{fragName ? ` — ${fragName}` : ''}</div>
                  )}
                  {parseInt(ll.leftover_labels_qty) > 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: '#e879f9' }}>→ {ll.leftover_labels_qty} labels returned to {modal.order.client_name}</div>
                  )}

                  {/* Extra fragrance (top-up) — only meaningful if the line has a fragrance */}
                  {fragName && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed rgba(255,255,255,0.08)' }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(232,234,242,0.45)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                        Did you add extra {fragName}?
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
                        <F label="Extra (ml)">
                          <input type="number" min={0} step="any" value={ll.extra_fragrance_ml || ''} onChange={e => setLL('extra_fragrance_ml', e.target.value)} placeholder="0" style={inp} />
                        </F>
                        <F label="Reason (optional)">
                          <input value={ll.extra_fragrance_reason || ''} onChange={e => setLL('extra_fragrance_reason', e.target.value)} placeholder="e.g. dose too weak, batch variance..." style={inp} />
                        </F>
                      </div>
                      {parseFloat(ll.extra_fragrance_ml) > 0 && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#fbbf24' }}>
                          → {ll.extra_fragrance_ml} ml will be debited from <strong>{fragName}</strong> stock
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Notes */}
            <div style={{ marginTop: 4 }}>
              <F label="Notes on Completion">
                <textarea value={completeForm.notes} onChange={e => setCompleteForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Any issues, observations..." style={{ ...inp, resize: 'vertical', width: '100%' }} />
              </F>
            </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleComplete} disabled={saving}>{saving ? 'Saving...' : 'Confirm Completion'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Packing Record Modal */}
      {packingOrder && (
        <div className="modal-overlay" onClick={() => setPackingOrder(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Packing Record</h2>
                <p style={{ color: '#4ade80' }}>✓ Production complete — fill in packing details before shipping</p>
              </div>
              <button className="modal-close" onClick={() => setPackingOrder(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">

            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '10px 14px', marginBottom: 20, fontSize: 13 }}>
              <span style={{ color: '#a78bfa', fontWeight: 700 }}>{packingOrder.order_number}</span>
              <span style={{ color: 'rgba(232,234,242,0.5)', margin: '0 8px' }}>—</span>
              <span style={{ color: '#e8eaf2' }}>{packingOrder.client_name}</span>
            </div>

            {/* Global fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <F label="Number of Pallets">
                <input type="number" min={0} value={packingForm.pallet_count} onChange={e => setPackingForm(f => ({ ...f, pallet_count: e.target.value }))} style={inp} />
              </F>
              <F label="Packed by">
                <input value={packingForm.packed_by} onChange={e => setPackingForm(f => ({ ...f, packed_by: e.target.value }))} placeholder="Warehouse staff name" style={inp} />
              </F>
            </div>

            {/* Per-line packing sections */}
            {(packingOrder.lines || []).map((line, li) => {
              const li_data = packingLineItems[line.id] || {}
              const setLI = (field, val) => setPackingLineItems(prev => ({ ...prev, [line.id]: { ...prev[line.id], [field]: val } }))
              const boxes = parseInt(li_data.boxes_for_line) || 0
              const perBox = parseInt(li_data.products_per_box) || 0
              const partialTotal = (li_data.partial_boxes || []).reduce((s, pb) => s + (parseInt(pb.products) || 0), 0)
              const totalPacked = boxes * perBox + partialTotal
              return (
                <div key={line.id} style={{ marginBottom: 14, padding: '14px 16px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2', marginBottom: 12 }}>
                    Line {line.line_number}: {ptLabel(line)} × {line.quantity}
                    {line.fragrance_name && <span style={{ color: '#a78bfa', fontWeight: 400, marginLeft: 6 }}>— {line.fragrance_name}</span>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <F label="Boxes for this product">
                      <input type="number" min={0} value={li_data.boxes_for_line || ''} onChange={e => setLI('boxes_for_line', e.target.value)} placeholder="e.g. 208" style={inp} />
                    </F>
                    <F label="Products per Box">
                      <input type="number" min={0} value={li_data.products_per_box || ''} onChange={e => setLI('products_per_box', e.target.value)} placeholder="e.g. 24" style={inp} />
                    </F>
                  </div>
                  {/* Totals for this line */}
                  {(boxes > 0 || perBox > 0) && (() => {
                    const ordered = parseInt(line.quantity) || 0
                    const hasVariance = totalPacked > 0 && totalPacked !== ordered
                    const isShort = totalPacked < ordered
                    return (
                      <div style={{ margin: '10px 0' }}>
                        <div style={{ padding: '8px 12px', background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.15)', borderRadius: 8, display: 'flex', gap: 20 }}>
                          <div><span style={{ fontSize: 15, fontWeight: 700, color: '#60a5fa' }}>{boxes}</span><span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', marginLeft: 5 }}>Boxes</span></div>
                          {perBox > 0 && <div><span style={{ fontSize: 15, fontWeight: 700, color: hasVariance ? (isShort ? '#f87171' : '#fbbf24') : '#4ade80' }}>{totalPacked.toLocaleString()}</span><span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', marginLeft: 5 }}>Total Products</span></div>}
                          {hasVariance && <div style={{ marginLeft: 'auto', fontSize: 11, color: isShort ? '#f87171' : '#fbbf24', fontWeight: 700 }}>
                            {isShort ? '▼' : '▲'} {Math.abs(totalPacked - ordered)} {isShort ? 'short' : 'over'} (ordered {ordered})
                          </div>}
                        </div>
                        {hasVariance && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ padding: '6px 10px', background: isShort ? 'rgba(248,113,113,0.08)' : 'rgba(251,191,36,0.08)', border: `1px solid ${isShort ? 'rgba(248,113,113,0.25)' : 'rgba(251,191,36,0.25)'}`, borderRadius: 6, marginBottom: 6, fontSize: 11, color: isShort ? '#f87171' : '#fbbf24' }}>
                              ⚠ Quantity differs from order — reason required
                            </div>
                            <textarea
                              value={li_data.quantity_variance_reason || ''}
                              onChange={e => setLI('quantity_variance_reason', e.target.value)}
                              placeholder="Explain why packed quantity differs (damage, shortage, overrun...)"
                              rows={2}
                              style={{ ...inp, resize: 'vertical', width: '100%', borderColor: isShort ? 'rgba(248,113,113,0.4)' : 'rgba(251,191,36,0.4)' }}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  {/* Partial boxes for this line */}
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Partial Boxes</span>
                      <button onClick={() => addLinePartialBox(line.id)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, padding: '2px 8px', fontSize: 10, color: '#e8eaf2', cursor: 'pointer', fontWeight: 600 }}>+ Add</button>
                    </div>
                    {(li_data.partial_boxes || []).length === 0 ? (
                      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.25)' }}>None — all boxes full</div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {(li_data.partial_boxes || []).map((pb, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="number" min={1} value={pb.products} onChange={e => updateLinePartialBox(line.id, i, e.target.value)} placeholder="qty" style={{ ...inp, width: 70, textAlign: 'center', padding: '5px 8px' }} />
                            <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>units</span>
                            <button onClick={() => removeLinePartialBox(line.id, i)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Notes */}
            <div style={{ marginBottom: 14 }}>
              <F label="Notes">
                <textarea value={packingForm.notes} onChange={e => setPackingForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Any observations about the shipment..." style={{ ...inp, resize: 'vertical', width: '100%' }} />
              </F>
            </div>

            {/* Photos */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Pallet Photos</label>
                <button onClick={() => packingPhotoRef.current?.click()} style={{ background: 'rgba(37,99,235,0.12)', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 6, padding: '4px 12px', fontSize: 11, color: '#60a5fa', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ImageIcon size={11} /> Add Photos
                </button>
                <input ref={packingPhotoRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => handlePackingPhotos(e.target.files)} />
              </div>
              {packingPhotos.length === 0 ? (
                <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)', padding: '8px 0' }}>No photos yet</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {packingPhotos.map((photo, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <img src={photo} alt={`Pallet ${i + 1}`} style={{ width: 80, height: 80, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.12)' }} />
                      <button onClick={() => setPackingPhotos(prev => prev.filter((_, idx) => idx !== i))} style={{ position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: '50%', background: '#dc2626', border: 'none', color: 'white', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPackingOrder(null)}>Skip for Now</button>
              <button className="btn btn-primary" onClick={handleSavePacking} disabled={packingSaving}>{packingSaving ? 'Saving...' : 'Save Packing Record'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Line Action Modal — Send for Filling */}
      {lineModal && (
        <div className="modal-overlay" onClick={() => setLineModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Send for Filling <span style={{ color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', fontSize: 12, fontWeight: 400, marginLeft: 8 }}>Line {lineModal.lineNumber}</span></h2>
              <button className="modal-close" onClick={() => setLineModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gap: 12 }}>
                <F label="Filling Supplier">
                  <input value={lineModalForm.supplier} onChange={e => setLineModalForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Supplier name..." style={inp} />
                </F>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setLineModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleLineModal} disabled={saving}>{saving ? 'Saving...' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Mark Waiting Modal */}
      {modal?.type === 'waiting' && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Mark as Waiting</h2>
              <button className="modal-close" onClick={() => setModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gap: 12 }}>
                <F label="Waiting for">
                  <SearchSelect
                    value={waitingForm.external_type}
                    onChange={v => setWaitingForm(f => ({ ...f, external_type: v }))}
                    options={[
                      { value: 'filling', label: 'Filling (Candle supplier)' },
                      { value: 'labels', label: 'Labels' },
                      { value: 'other', label: 'Other' },
                    ]}
                    clearable={false}
                  />
                </F>
                <F label="Supplier / Contact">
                  <input value={waitingForm.external_supplier} onChange={e => setWaitingForm(f => ({ ...f, external_supplier: e.target.value }))} placeholder="Supplier name..." style={inp} />
                </F>
                <F label="Expected back (ETA)">
                  <input type="date" value={waitingForm.external_expected_at} onChange={e => setWaitingForm(f => ({ ...f, external_expected_at: e.target.value }))} style={inp} />
                </F>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleMarkWaiting} disabled={saving}>{saving ? 'Saving...' : 'Confirm'}</button>
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
const sel = { ...inp, cursor: 'pointer' }

function StepPill({ label, done, active, waiting }) {
  const color = done ? '#4ade80' : active ? '#60a5fa' : waiting ? '#e879f9' : 'rgba(232,234,242,0.25)'
  return (
    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, padding: '2px 7px', borderRadius: 20, background: done ? 'rgba(34,197,94,0.12)' : active ? 'rgba(37,99,235,0.15)' : waiting ? 'rgba(232,121,249,0.1)' : 'rgba(255,255,255,0.04)', color, border: `1px solid ${color}40` }}>
      {done ? '✓ ' : ''}{label}
    </div>
  )
}

function LineBtn({ children, onClick, color = '#60a5fa' }) {
  return (
    <button onClick={onClick} style={{ background: `${color}15`, border: `1px solid ${color}40`, borderRadius: 8, padding: '8px 18px', cursor: 'pointer', color, fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
      {children}
    </button>
  )
}
