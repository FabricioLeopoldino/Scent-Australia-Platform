import { useState, useEffect } from 'react'
import { Search, X, ClipboardList, Package, ImageIcon } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import { fmt } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export default function PackingRecords() {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await axios.get('/api/packing-records', api())
      setRecords(res.data)
    } catch { addToast('Failed to load packing records', 'error') }
    finally { setLoading(false) }
  }

  const displayed = records.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    return (r.order_number || '').toLowerCase().includes(s) ||
      (r.client_name || r.client_name_joined || '').toLowerCase().includes(s) ||
      (r.packed_by || '').toLowerCase().includes(s)
  })

  return (
    <div style={{ padding: 28 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="ed-title">Packing Records</h1>
          <p className="ed-sub">Every parcel, logged as it leaves.</p>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{records.length} record{records.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="ed-rule" style={{ margin: '22px 0 24px' }} />

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 380 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', zIndex: 1 }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by order, client or packed by..."
          className="input"
          style={{ paddingLeft: 34 }}
        />
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)' }}>
          <ClipboardList size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div style={{ fontSize: 14 }}>No packing records yet</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Records are created automatically when a production order is completed</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {displayed.map(r => {
            const photos = Array.isArray(r.photos) ? r.photos : (r.photos ? JSON.parse(r.photos) : [])
            const clientName = r.client_name || r.client_name_joined || '—'
            return (
              <div key={r.id} onClick={() => setSelected(r)} style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', cursor: 'pointer', transition: 'border-color 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-h)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>{r.order_number || `PO-${r.production_order_id}`}</span>
                      {!r.client_name && !r.client_name_joined
                        ? <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em' }}>MUSE</span>
                        : <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{clientName}</span>
                      }
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Stat label="Pallets" value={r.pallet_count} color="#60a5fa" />
                      {r.boxes_per_pallet && <Stat label="Boxes/Pallet" value={r.boxes_per_pallet} color="#a78bfa" />}
                      {r.total_boxes && <Stat label="Total Boxes" value={r.total_boxes} color="#fbbf24" />}
                      {r.products_per_box && <Stat label="Products/Box" value={r.products_per_box} color="#4ade80" />}
                      {r.total_products_packed && <Stat label="Total Products" value={Number(r.total_products_packed).toLocaleString()} color="#4ade80" />}
                    </div>
                    {(() => {
                      const li = Array.isArray(r.line_items) ? r.line_items : (r.line_items ? JSON.parse(r.line_items) : [])
                      const variances = li.filter(l => l.total_packed && l.quantity_ordered && Number(l.total_packed) !== Number(l.quantity_ordered))
                      if (!variances.length) return null
                      return (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {variances.map((v, i) => {
                            const diff = Number(v.total_packed) - Number(v.quantity_ordered)
                            return (
                              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 10px', background: 'rgba(200,168,94,0.07)', border: '1px solid rgba(200,168,94,0.2)', borderRadius: 6 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', paddingTop: 1 }}>Variance L{v.line_number}:</span>
                                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                  {diff > 0 ? '+' : ''}{diff} units
                                  {v.quantity_variance_reason && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>— {v.quantity_variance_reason}</span>}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                    <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                      {r.packed_by && <span>Packed by: <strong style={{ color: 'var(--text-secondary)' }}>{r.packed_by}</strong></span>}
                      <span>{fmt(r.created_at)}</span>
                      {photos.length > 0 && <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><ImageIcon size={11} /> {photos.length} photo{photos.length !== 1 ? 's' : ''}</span>}
                    </div>
                  </div>
                  <Package size={18} color="rgba(232,234,242,0.2)" style={{ flexShrink: 0, marginTop: 2 }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selected && <PackingDetail record={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
    </div>
  )
}

function ptLabel(pt) { return (pt || '').replace(/_/g, ' ') }

// Same palette used in ProductionOrders / ManufacturingQueue / Dashboard.
const LINE_COLORS = ['#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c']

function PackingDetail({ record, onClose }) {
  const photos = Array.isArray(record.photos) ? record.photos : (record.photos ? JSON.parse(record.photos) : [])
  const lineItems = Array.isArray(record.line_items) ? record.line_items : (record.line_items ? JSON.parse(record.line_items) : [])
  const clientName = record.client_name || record.client_name_joined || '—'
  const [zoomPhoto, setZoomPhoto] = useState(null)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }}>
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 14, padding: 32, width: '100%', maxWidth: 620, maxHeight: '92vh', overflowY: 'auto', overflowX: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 17, color: '#e8eaf2' }}>Packing Record #{record.id}</h2>
            <div style={{ fontSize: 12, color: '#a78bfa', marginTop: 4 }}>{record.order_number || `PO-${record.production_order_id}`} — {clientName}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.5)' }}><X size={18} /></button>
        </div>

        {/* Top summary */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatCard label="Pallets" value={record.pallet_count} color="#60a5fa" />
          {record.total_products_packed && <StatCard label="Total Products" value={Number(record.total_products_packed).toLocaleString()} color="#4ade80" />}
        </div>

        {/* Per-line items */}
        {lineItems.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Products Packed</div>
            {lineItems.map((li, i) => {
              const partials = Array.isArray(li.partial_boxes) ? li.partial_boxes : []
              const lc = LINE_COLORS[i % LINE_COLORS.length]
              return (
                <div key={i} style={{ marginBottom: 10, padding: '12px 14px', background: `${lc}08`, border: `1px solid ${lc}22`, borderLeft: `3px solid ${lc}`, borderRadius: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: lc, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Line {li.line_number}</span>
                    <span>{li.product_name || ptLabel(li.product_type)} × {li.quantity_ordered}</span>
                    {li.fragrance_name && <span style={{ color: '#a78bfa', fontWeight: 400 }}>— {li.fragrance_name}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {li.boxes_for_line && <Stat label="Boxes" value={li.boxes_for_line} color="#60a5fa" />}
                    {li.products_per_box && <Stat label="Products/Box" value={li.products_per_box} color="#a78bfa" />}
                    {li.total_packed && <Stat label="Total Packed" value={Number(li.total_packed).toLocaleString()} color={li.total_packed !== li.quantity_ordered ? '#fbbf24' : '#4ade80'} />}
                    {li.quantity_ordered && <Stat label="Ordered" value={Number(li.quantity_ordered).toLocaleString()} color="rgba(232,234,242,0.4)" />}
                  </div>
                  {li.total_packed && li.quantity_ordered && Number(li.total_packed) !== Number(li.quantity_ordered) && (
                    <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.4 }}>Variance:</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: Number(li.total_packed) > Number(li.quantity_ordered) ? '#4ade80' : '#f87171' }}>
                          {Number(li.total_packed) > Number(li.quantity_ordered) ? '+' : ''}{Number(li.total_packed) - Number(li.quantity_ordered)} units
                        </span>
                      </div>
                      {li.quantity_variance_reason && (
                        <div style={{ marginTop: 4, fontSize: 12, color: '#e8eaf2', lineHeight: 1.4 }}>
                          <span style={{ color: 'rgba(232,234,242,0.45)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>Reason: </span>
                          {li.quantity_variance_reason}
                        </div>
                      )}
                    </div>
                  )}
                  {partials.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', alignSelf: 'center' }}>Partial:</span>
                      {partials.map((pb, pi) => (
                        <span key={pi} style={{ background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.25)', color: '#fb923c', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>{pb.products} units</span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Meta */}
        <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap', fontSize: 12 }}>
          {record.packed_by && (
            <div><span style={{ color: 'rgba(232,234,242,0.4)' }}>Packed by: </span><span style={{ color: '#e8eaf2', fontWeight: 600 }}>{record.packed_by}</span></div>
          )}
          <div><span style={{ color: 'rgba(232,234,242,0.4)' }}>Recorded: </span><span style={{ color: '#e8eaf2' }}>{fmt(record.created_at)}</span></div>
          {record.created_by_name && (
            <div><span style={{ color: 'rgba(232,234,242,0.4)' }}>By: </span><span style={{ color: '#e8eaf2' }}>{record.created_by_name}</span></div>
          )}
        </div>

        {/* Notes — one card per source, color-coded so they don't blur together */}
        {(() => {
          const epNotes = Array.isArray(record.external_processing_notes)
            ? record.external_processing_notes
            : (record.external_processing_notes ? JSON.parse(record.external_processing_notes) : [])
          const epWithNotes      = epNotes.filter(ep => ep.notes && ep.notes.trim())
          const epShortReturns   = epNotes.filter(ep => ep.short_return_reason && ep.short_return_reason.trim())
          const hasAny = record.order_notes || record.notes_on_completion || record.notes || epWithNotes.length || epShortReturns.length
          if (!hasAny) return null
          return (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Notes Timeline</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {record.order_notes && (
                  <NoteCard label="Order" color="#60a5fa" text={record.order_notes} />
                )}
                {epWithNotes.map(ep => (
                  <NoteCard
                    key={`ep-${ep.id}`}
                    label={`External Processing — ${(ep.processing_type || '').toUpperCase()}`}
                    sub={[ep.product_name, ep.supplier].filter(Boolean).join(' · ')}
                    color="#fb923c"
                    text={ep.notes}
                  />
                ))}
                {epShortReturns.map(ep => (
                  <NoteCard
                    key={`epr-${ep.id}`}
                    label={`Mark Return — ${(ep.processing_type || '').toUpperCase()}`}
                    sub={[ep.product_name, ep.qty_returned ? `returned ${Number(ep.qty_returned).toLocaleString()}` : null].filter(Boolean).join(' · ')}
                    color="#f472b6"
                    text={ep.short_return_reason}
                  />
                ))}
                {record.notes_on_completion && (
                  <NoteCard label="Completion" color="#4ade80" text={record.notes_on_completion} />
                )}
                {record.notes && (
                  <NoteCard label="Packing" color="#a78bfa" text={record.notes} />
                )}
              </div>
            </div>
          )
        })()}

        {/* Leftover summary */}
        {(() => {
          const leftovers = lineItems.filter(li => li.leftover_formula_ml || li.leftover_labels_qty)
          if (!leftovers.length) return null
          return (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Leftover Materials</div>
              {leftovers.map((li, i) => (
                <div key={i} style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 9, marginBottom: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#e8eaf2', marginBottom: 6 }}>
                    Linha {li.line_number}{li.fragrance_name ? ` — ${li.fragrance_name}` : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {li.leftover_formula_ml > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)', borderRadius: 7, padding: '4px 10px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#fb923c' }}>{Number(li.leftover_formula_ml).toLocaleString()} ml</span>
                        <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.45)' }}>→ Ready Formula Stock</span>
                      </div>
                    )}
                    {li.leftover_labels_qty > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(232,121,249,0.08)', border: '1px solid rgba(232,121,249,0.2)', borderRadius: 7, padding: '4px 10px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#e879f9' }}>{Number(li.leftover_labels_qty).toLocaleString()} labels</span>
                        <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.45)' }}>→ Client Labels</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        })()}

        {/* Photos */}
        {photos.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Pallet Photos ({photos.length})</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
              {photos.map((photo, i) => (
                <img key={i} src={photo} alt={`Pallet ${i + 1}`}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', cursor: 'zoom-in' }}
                  onClick={() => setZoomPhoto(photo)}
                />
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '9px 24px', color: '#e8eaf2', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>Close</button>
        </div>
      </div>

      {/* Full-size photo zoom */}
      {zoomPhoto && (
        <div onClick={() => setZoomPhoto(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, cursor: 'zoom-out' }}>
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative', maxWidth: '92vw', maxHeight: '92vh' }}>
            <button onClick={() => setZoomPhoto(null)} style={{ position: 'absolute', top: -12, right: -12, width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>×</button>
            <img src={zoomPhoto} alt="Pallet photo" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 10, objectFit: 'contain', display: 'block' }} />
          </div>
        </div>
      )}
    </div>
  )
}

function NoteCard({ label, sub, color, text }) {
  return (
    <div style={{ background: `${color}0a`, border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
        {sub && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)' }}>{sub}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.85)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{text}</div>
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 3 }}>{label}</div>
    </div>
  )
}
