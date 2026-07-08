import { useState, useEffect } from 'react'
import { Truck, RotateCw } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import { fmtDate as fmt } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }
function isOverdue(d) { return d && new Date(d) < new Date() }

// Dedicated page for items out at external suppliers (filling / labels / candle work).
// Same data + actions as the Dashboard "External Processing" widget, with room to breathe.
export default function ExternalProcessing() {
  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [epMarkSentModal, setEpMarkSentModal]   = useState(null)
  const [epMarkSentQty, setEpMarkSentQty]       = useState('')
  const [epMarkSentSaving, setEpMarkSentSaving] = useState(false)
  const [epReturnModal, setEpReturnModal]       = useState(null)
  const [epReturnQty, setEpReturnQty]           = useState('')
  const [epReturnNotes, setEpReturnNotes]       = useState('')
  const [epReturning, setEpReturning]           = useState(false)
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true); else setLoading(true)
    try {
      const res = await axios.get('/api/dashboard/external-processing', api())
      setItems(res.data)
    } catch { addToast('Failed to load external processing', 'error') }
    finally { setLoading(false); setRefreshing(false) }
  }

  return (
    <>
    <div style={{ padding: 28, maxWidth: 1400 }}>
      {/* Header (editorial) */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="ed-title">External Processing</h1>
          <p className="ed-sub">Items out at suppliers — filling, labels, candle work.</p>
        </div>
        <button onClick={() => load(true)} disabled={refreshing} title="Refresh" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RotateCw size={14} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} /> Refresh
        </button>
      </div>
      <div className="ed-rule" style={{ margin: '22px 0 28px' }} />

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-muted)' }}>
          <Truck size={38} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
          <div style={{ fontSize: 14 }}>No items currently at external suppliers</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Records appear here when you send an order for external processing.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {items.map(item => {
            const overdue = isOverdue(item.expected_return)
            const daysAway = item.expected_return ? Math.ceil((new Date(item.expected_return) - new Date()) / 86400000) : null
            return (
              <div key={item.id} style={{ background: 'var(--card-bg)', border: `1px solid ${overdue ? 'rgba(192,57,43,0.4)' : 'var(--border)'}`, borderRadius: 12, padding: '16px 18px', boxShadow: 'var(--shadow-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{item.product_name}</div>
                    {item.order_number && <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{item.order_number}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {item.status === 'requested' && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Requested</span>}
                    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{item.processing_type}</span>
                  </div>
                </div>
                {item.status === 'partial' && (() => {
                  const isLabels = item.processing_type === 'labels'
                  const refQty = isLabels ? parseFloat(item.qty_requested || 0) : parseFloat(item.qty_sent || 0)
                  const outstanding = Math.max(0, refQty - parseFloat(item.qty_returned || 0))
                  return (
                    <div style={{ background: 'rgba(200,168,94,0.08)', border: '1px solid rgba(200,168,94,0.22)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 700 }}>Partial Return</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        {Number(item.qty_returned).toLocaleString()} received · <strong style={{ color: '#fbbf24' }}>{Number(outstanding).toLocaleString()} outstanding</strong>
                      </span>
                    </div>
                  )
                })()}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                  {[
                    { label: 'Supplier', val: item.supplier || '—' },
                    (() => {
                      const isLabels = item.processing_type === 'labels'
                      const refQty = isLabels ? item.qty_requested : item.qty_sent
                      const refLabel = isLabels ? 'Requested' : 'Sent'
                      if (item.status === 'requested') return { label: 'Qty Requested', val: item.qty_requested ? Number(item.qty_requested).toLocaleString() : '—' }
                      if (item.status === 'partial') return { label: `Qty ${refLabel} / Received`, val: `${Number(refQty || 0).toLocaleString()} / ${Number(item.qty_returned || 0).toLocaleString()}` }
                      return { label: `Qty ${refLabel}`, val: Number(refQty || 0).toLocaleString() }
                    })(),
                    { label: item.status === 'requested' ? 'Created' : 'Sent', val: fmt(item.status === 'requested' ? item.created_at : item.sent_date) },
                    { label: 'Expected Return', val: item.expected_return ? (
                      <span style={{ color: overdue ? '#f87171' : daysAway !== null && daysAway <= 3 ? '#fbbf24' : 'var(--text-secondary)' }}>
                        {fmt(item.expected_return)} <span style={{ fontSize: 10 }}>{overdue ? `(${Math.abs(daysAway)}d overdue)` : daysAway === 0 ? '(today)' : daysAway != null ? `(${daysAway}d)` : ''}</span>
                      </span>
                    ) : '—' },
                  ].map(r => (
                    <div key={r.label}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{r.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {item.status === 'requested' && item.processing_type !== 'labels' ? (
                    <button onClick={() => { setEpMarkSentModal(item); setEpMarkSentQty('') }}
                      style={{ flex: 1, background: 'var(--accent-soft)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '7px 0', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Mark Sent
                    </button>
                  ) : (
                    <button onClick={() => { setEpReturnModal(item); setEpReturnQty(''); setEpReturnNotes('') }}
                      style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '7px 0', color: item.status === 'partial' ? '#fbbf24' : '#4ade80', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {item.status === 'partial' ? 'Mark Remaining Return' : 'Mark Returned'}
                    </button>
                  )}
                  {(item.status === 'partial' || item.status === 'requested') && (
                    <button onClick={async () => {
                      const isLabels = item.processing_type === 'labels'
                      const refQty = isLabels ? Number(item.qty_requested || 0) : Number(item.qty_sent || 0)
                      const outstanding = Math.max(0, refQty - Number(item.qty_returned || 0))
                      if (!confirm(`Close this EP record? ${outstanding} items still outstanding will be written off.`)) return
                      try {
                        await axios.put(`/api/external-processing/${item.id}/close`, {}, api())
                        load(true)
                      } catch {}
                    }} title="Force close — no more returns expected"
                      style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Close
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>

    {/* ── Mark Sent Modal ── */}
    {epMarkSentModal && (
      <div className="modal-overlay" onClick={() => setEpMarkSentModal(null)}>
        <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h2>Mark as Sent</h2>
              <p>{epMarkSentModal.product_name}{epMarkSentModal.qty_requested ? ` — requested: ${Number(epMarkSentModal.qty_requested).toLocaleString()}` : ''}</p>
            </div>
            <button className="modal-close" onClick={() => setEpMarkSentModal(null)}>×</button>
          </div>
          <div className="modal-body">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="label">Qty Sent *</label>
              <input type="number" value={epMarkSentQty} onChange={e => setEpMarkSentQty(e.target.value)} autoFocus
                placeholder={epMarkSentModal.qty_requested ? String(epMarkSentModal.qty_requested) : '0'} className="input" />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setEpMarkSentModal(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={epMarkSentSaving} onClick={async () => {
              const qty = parseFloat(epMarkSentQty || epMarkSentModal.qty_requested)
              if (!qty || qty <= 0) return
              setEpMarkSentSaving(true)
              try {
                await axios.put(`/api/external-processing/${epMarkSentModal.id}/mark-sent`, { qty_sent: qty }, api())
                setEpMarkSentModal(null)
                load(true)
              } catch (err) { addToast(err.response?.data?.error || 'Failed', 'error') }
              finally { setEpMarkSentSaving(false) }
            }}>
              {epMarkSentSaving ? 'Saving...' : 'Confirm Sent'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Return Modal ── */}
    {epReturnModal && (
      <div className="modal-overlay" onClick={() => setEpReturnModal(null)}>
        <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h2>Mark Return</h2>
              <p>{epReturnModal.product_name} — {epReturnModal.processing_type === 'labels' ? `requested: ${epReturnModal.qty_requested}` : `sent: ${epReturnModal.qty_sent}`}</p>
            </div>
            <button className="modal-close" onClick={() => setEpReturnModal(null)}>×</button>
          </div>
          <div className="modal-body">
            <div className="form-group">
              <label className="label">Qty Returned</label>
              <input type="number" value={epReturnQty} onChange={e => setEpReturnQty(e.target.value)}
                placeholder={`max ${epReturnModal.qty_sent}`} className="input" />
            </div>
            {(() => {
              const qtyRef = parseFloat(epReturnModal.processing_type === 'labels' ? epReturnModal.qty_requested : epReturnModal.qty_sent)
              const isShort = epReturnQty && parseFloat(epReturnQty) > 0 && parseFloat(epReturnQty) < qtyRef
              return (
                <div className="form-group">
                  <label className="label" style={isShort ? { color: '#fbbf24' } : undefined}>
                    {isShort ? 'Reason for short return (required) *' : 'Notes (optional)'}
                  </label>
                  <input type="text" value={epReturnNotes} onChange={e => setEpReturnNotes(e.target.value)}
                    placeholder={isShort ? 'e.g. 15 reprints pending, 5 damaged in transit' : 'e.g. all received in good condition'}
                    className="input"
                    style={isShort ? { background: 'rgba(251,191,36,0.06)', borderColor: 'rgba(251,191,36,0.3)' } : undefined} />
                  {isShort && (
                    <div style={{ fontSize: 10, color: 'rgba(251,191,36,0.75)', marginTop: 5 }}>
                      Returning {Number(epReturnQty).toLocaleString()} of {Number(qtyRef).toLocaleString()} — please explain the {Number(qtyRef - parseFloat(epReturnQty)).toLocaleString()} missing.
                    </div>
                  )}
                </div>
              )
            })()}
            {epReturnModal.client_label_id && (
              <div style={{ background: 'rgba(107,120,77,0.08)', border: '1px solid rgba(107,120,77,0.2)', borderRadius: 8, padding: '8px 12px', fontSize: 11, color: '#4ade80' }}>
                Label stock will be automatically updated on return
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setEpReturnModal(null)}>Cancel</button>
            <button className="btn btn-primary"
              disabled={epReturning || !epReturnQty || (parseFloat(epReturnQty) > 0 && parseFloat(epReturnQty) < parseFloat(epReturnModal.processing_type === 'labels' ? epReturnModal.qty_requested : epReturnModal.qty_sent) && !epReturnNotes.trim())}
              onClick={async () => {
                const qty = parseFloat(epReturnQty)
                if (!qty || qty <= 0) return
                const qtyRef = parseFloat(epReturnModal.processing_type === 'labels' ? epReturnModal.qty_requested : epReturnModal.qty_sent)
                const isShort = qty < qtyRef
                if (isShort && !epReturnNotes.trim()) return
                setEpReturning(true)
                try {
                  await axios.put(`/api/external-processing/${epReturnModal.id}/return`, {
                    qty_returned: qty,
                    notes: epReturnNotes || undefined,
                    short_return_reason: isShort ? epReturnNotes : undefined,
                  }, api())
                  setEpReturnModal(null)
                  load(true)
                } catch (err) {
                  addToast(err.response?.data?.error || 'Failed to record return', 'error')
                } finally { setEpReturning(false) }
              }}>
              {epReturning ? 'Saving...' : 'Confirm Return'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
