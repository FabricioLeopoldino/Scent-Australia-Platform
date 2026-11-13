import { useState, useEffect } from 'react'
import { Truck, RotateCw } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import { fmtDate as fmt } from '../utils/date.js'
import { getStoredUser } from '../../shell/api.js'

// Oil is typed in litres and stored in mL (D17 Block B).
const litres = (ml) => Number((Number(ml || 0) / 1000).toFixed(3))
const fmtL = (ml) => `${litres(ml).toLocaleString()} L`

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }
function isOverdue(d) { return d && new Date(d) < new Date() }

// Dedicated page for items out at external suppliers (filling / labels / candle work).
// Same data + actions as the Dashboard "External Processing" widget, with room to breathe.
// Friendly labels for the processing_type values that actually occur.
const TYPE_LABELS = { labels: 'Labels', candle_filling: 'Candle Filling', filling: 'Filling' }
const typeLabel = (t) => TYPE_LABELS[t] || String(t || '').replace(/_/g, ' ')

export default function ExternalProcessing() {
  const [items, setItems]         = useState([])
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [loading, setLoading]     = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [epMarkSentModal, setEpMarkSentModal]   = useState(null)
  const [epMarkSentQty, setEpMarkSentQty]       = useState('')
  const [epMarkSentSaving, setEpMarkSentSaving] = useState(false)
  const [epReturnModal, setEpReturnModal]       = useState(null)
  const [epReturnQty, setEpReturnQty]           = useState('')
  const [epReturnNotes, setEpReturnNotes]       = useState('')
  const [epReturning, setEpReturning]           = useState(false)
  const [epReturnOil, setEpReturnOil]           = useState('')
  // The oil a candle record sent to the filler: { item, oil, litres } while its window is open.
  const [oilModal, setOilModal]                 = useState(null)
  const [oilSaving, setOilSaving]               = useState(false)
  // Moving oil is admin/root only (D17.14); the server enforces it, this hides the controls.
  const canMoveOil = ['admin', 'root'].includes(getStoredUser()?.role)
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

      {/* Type filter — this is the "labels pending" / "candles at the filler" view:
          labels sent to the print shop are processing_type='labels', candles out for
          filling are 'candle_filling'. One page, filtered, instead of separate screens. */}
      {!loading && items.length > 0 && (() => {
        const types = [...new Set(items.map(i => i.processing_type).filter(Boolean))].sort()
        if (types.length < 2) return null
        const chips = ['ALL', ...types]
        return (
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
            {chips.map(t => {
              const active = typeFilter === t
              const count = t === 'ALL' ? items.length : items.filter(i => i.processing_type === t).length
              return (
                <button key={t} onClick={() => setTypeFilter(t)} style={{
                  background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                  border: active ? '1px solid var(--border-h)' : '1px solid var(--border)',
                  color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
                  borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>
                  {t === 'ALL' ? 'All' : typeLabel(t)} ({count})
                </button>
              )
            })}
          </div>
        )
      })()}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-muted)' }}>
          <Truck size={38} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
          <div style={{ fontSize: 14 }}>No items currently at external suppliers</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Records appear here when you send an order for external processing.</div>
        </div>
      ) : items.filter(i => typeFilter === 'ALL' || i.processing_type === typeFilter).length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 14 }}>
          Nothing out at suppliers for “{typeLabel(typeFilter)}” right now.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {items.filter(i => typeFilter === 'ALL' || i.processing_type === typeFilter).map(item => {
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
                    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{typeLabel(item.processing_type)}</span>
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
                {item.processing_type === 'candle_filling' && item.production_order_line_id && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 11 }}>
                    {item.oil_qty_sent_ml != null ? (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Oil: <strong style={{ color: 'var(--text-primary)' }}>{item.oil_name || item.oil_id}</strong> · {fmtL(item.oil_qty_sent_ml)} sent
                        {Number(item.oil_qty_returned_ml) > 0 ? ` · ${fmtL(item.oil_qty_returned_ml)} back` : ''}
                      </span>
                    ) : item.status !== 'requested' ? (
                      <>
                        <span style={{ color: '#f87171', fontWeight: 700 }}>Oil not recorded</span>
                        {canMoveOil && (
                          <button onClick={async () => {
                            const oil = await axios.get(`/api/manufacturing/${item.production_order_id}/lines/${item.production_order_line_id}/candle-oil`, api()).then(r => r.data).catch(() => null)
                            setOilModal({ item, oil, litres: oil && !oil.debited_at_start ? String(litres(oil.calculated_ml)) : '' })
                          }} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '4px 9px', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                            Record oil sent
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  {item.status === 'requested' && item.processing_type !== 'labels' ? (
                    <button onClick={() => { setEpMarkSentModal(item); setEpMarkSentQty('') }}
                      style={{ flex: 1, background: 'var(--accent-soft)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '7px 0', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Mark Sent
                    </button>
                  ) : (
                    <button onClick={() => { setEpReturnModal(item); setEpReturnQty(''); setEpReturnNotes(''); setEpReturnOil('') }}
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
                placeholder={`max ${epReturnModal.qty_sent ?? epReturnModal.qty_requested ?? ""}`} className="input" />
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
            {epReturnModal.oil_qty_sent_ml != null && canMoveOil && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Oil returned (litres, optional)</label>
                <input type="number" min="0" step="0.001" value={epReturnOil} onChange={e => setEpReturnOil(e.target.value)} className="input" />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 5 }}>
                  {epReturnModal.oil_name || 'Oil'}: {fmtL(epReturnModal.oil_qty_sent_ml)} was sent{Number(epReturnModal.oil_qty_returned_ml) > 0 ? `, ${fmtL(epReturnModal.oil_qty_returned_ml)} is already back` : ''}. Leave empty if none came back.
                </div>
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
                    oil_returned_ml: parseFloat(epReturnOil) > 0 ? Math.round(parseFloat(epReturnOil) * 1000) : undefined,
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
    {/* ── Record oil sent (candle filling, D17 Block B) ── */}
    {oilModal && (
      <div className="modal-overlay" onClick={() => setOilModal(null)}>
        <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h2>Record oil sent</h2>
              <p>{oilModal.item.product_name}{oilModal.item.order_number ? ` — ${oilModal.item.order_number}` : ''}</p>
            </div>
            <button className="modal-close" onClick={() => setOilModal(null)}>×</button>
          </div>
          <div className="modal-body">
            {!oilModal.oil ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>This candle line names no Fragrance Library oil, so there is nothing to record.</div>
            ) : oilModal.oil.debited_at_start ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>This line's oil was already taken when production started. Nothing more is taken now.</div>
            ) : (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 10 }}>
                  Oil: <strong>{oilModal.oil.name}</strong> <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{oilModal.oil.code}</span>
                  {oilModal.oil.is_candle_version && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#fbbf24' }}>CANDLE VERSION</span>}
                </div>
                <label className="label">Oil sent (litres) *</label>
                <input type="number" min="0" step="0.001" autoFocus value={oilModal.litres} onChange={e => setOilModal(m => ({ ...m, litres: e.target.value }))} className="input" />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 5 }}>
                  The recipe asks for {fmtL(oilModal.oil.calculated_ml)}. Type what actually left. It comes off the stock now and can be recorded once.
                </div>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setOilModal(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={oilSaving || !oilModal.oil || oilModal.oil.debited_at_start || !(parseFloat(oilModal.litres) > 0)}
              onClick={async () => {
                setOilSaving(true)
                try {
                  await axios.put(`/api/external-processing/${oilModal.item.id}/oil-sent`, { oil_sent_ml: Math.round(parseFloat(oilModal.litres) * 1000) }, api())
                  addToast(`Oil recorded: ${oilModal.litres} L of ${oilModal.oil.name}`)
                  setOilModal(null)
                  load(true)
                } catch (err) {
                  addToast(err.response?.data?.error || 'Failed to record the oil', 'error')
                } finally { setOilSaving(false) }
              }}>
              {oilSaving ? 'Saving...' : 'Record'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
