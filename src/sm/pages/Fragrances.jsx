import { useState, useEffect } from 'react'
import { Plus, Search, FlaskConical, TrendingUp, TrendingDown, Edit2, X } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import MlHint from '../components/MlHint.jsx'
import { splitVolume } from '../utils/volume.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const EMPTY_FORM = { name: '', product_code: '', min_stock_level: '', supplier: '', notes: '' }

export default function Fragrances() {
  const [fragrances, setFragrances] = useState([])
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [showLow, setShowLow]       = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm]             = useState(EMPTY_FORM)
  const [saving, setSaving]         = useState(false)
  const [adjModal, setAdjModal]     = useState(null) // { fragrance, mode }
  const [adjQty, setAdjQty]         = useState('')
  const [adjNotes, setAdjNotes]     = useState('')
  const [adjSaving, setAdjSaving]   = useState(false)
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  // /fragrances?new=1 opens the create form straight away — the MUSE Dashboard's
  // "Add Fragrance" quick action used to just drop you on the list, leaving you
  // to find the New Fragrance button yourself. Runs after load so suggestCode()
  // sees the existing codes.
  useEffect(() => {
    if (!fragrances.length) return
    if (new URLSearchParams(window.location.search).get('new') !== '1') return
    setForm({ ...EMPTY_FORM, product_code: suggestCode() })
    setShowCreate(true)
  }, [fragrances])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get('/api/products', { ...api(), params: { category: 'FRAGRANCE' } })
      setFragrances(r.data)
    } catch { addToast('Failed to load fragrances', 'error') }
    finally { setLoading(false) }
  }

  function suggestCode() {
    const prefix = 'FRAG_'
    const last = fragrances
      .filter(f => f.product_code?.startsWith(prefix))
      .map(f => parseInt(f.product_code.replace(prefix, '')) || 0)
      .sort((a, b) => b - a)[0] || 0
    return prefix + String(last + 1).padStart(5, '0')
  }

  async function handleCreate() {
    if (!form.name.trim()) { addToast('Name is required', 'error'); return }
    setSaving(true)
    try {
      await axios.post('/api/products', {
        name: form.name.trim(),
        product_code: (form.product_code || suggestCode()).toUpperCase().trim(),
        category: 'FRAGRANCE',
        unit: 'ml',
        current_stock: 0,
        min_stock_level: parseFloat(form.min_stock_level) || 0,
        supplier: form.supplier || null,
        notes: form.notes || null,
      }, api())
      addToast(`Fragrance "${form.name}" created`)
      setShowCreate(false); setForm(EMPTY_FORM)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleAdj() {
    const qty = parseFloat(adjQty)
    if (!qty || qty <= 0) { addToast('Enter a valid quantity', 'error'); return }
    setAdjSaving(true)
    try {
      const endpoint = adjModal.mode === 'add' ? '/api/stock/add' : '/api/stock/remove'
      await axios.post(endpoint, { product_id: adjModal.fragrance.id, quantity: qty, notes: adjNotes || undefined }, api())
      addToast(`Stock ${adjModal.mode === 'add' ? 'added' : 'removed'}`)
      setAdjModal(null); setAdjQty(''); setAdjNotes('')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setAdjSaving(false) }
  }

  const displayed = fragrances.filter(f => {
    if (showLow && parseFloat(f.current_stock) >= parseFloat(f.min_stock_level || 0)) return false
    if (!search) return true
    const s = search.toLowerCase()
    return f.name.toLowerCase().includes(s) || f.product_code.toLowerCase().includes(s)
  })

  const totalMl  = fragrances.reduce((sum, f) => sum + parseFloat(f.current_stock || 0), 0)
  const lowCount = fragrances.filter(f => parseFloat(f.current_stock) < parseFloat(f.min_stock_level || 0)).length

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FlaskConical size={20} color="#a78bfa" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Fragrances</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Shared fragrance pool — used across MUSE, Standard and Major segments</p>
          </div>
        </div>
        <button onClick={() => { setForm({ ...EMPTY_FORM, product_code: suggestCode() }); setShowCreate(true) }} style={{ background: '#a78bfa', color: '#0e0e1a', border: 'none', borderRadius: 8, padding: '9px 18px', fontWeight: 800, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={15} /> New Fragrance
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24, maxWidth: 560 }}>
        <Stat label="Fragrances" value={fragrances.length} color="#a78bfa" />
        <Stat label="Total Stock" value={(() => { const s = splitVolume(totalMl, 'ml'); return `${s.value} ${s.unit}` })()} color="#60a5fa" />
        <Stat label="Low Stock" value={lowCount} color={lowCount > 0 ? '#f87171' : '#4ade80'} />
      </div>

      {/* Filter + search */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)} placeholder="Search fragrances..."
            style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
          />
        </div>
        <button onClick={() => setShowLow(v => !v)} style={{
          background: showLow ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.05)',
          border: showLow ? '1px solid rgba(248,113,113,0.4)' : '1px solid rgba(255,255,255,0.1)',
          color: showLow ? '#f87171' : 'rgba(232,234,242,0.6)',
          borderRadius: 20, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}>
          Low Stock Only
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <FlaskConical size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>{fragrances.length === 0 ? 'No fragrances yet' : 'No matches'}</div>
          {fragrances.length === 0 && <div style={{ fontSize: 12, marginTop: 6 }}>Click "New Fragrance" to add your first fragrance</div>}
        </div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Name', 'Code', 'Stock', 'Min Level', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(f => {
                const stock = parseFloat(f.current_stock || 0)
                const min   = parseFloat(f.min_stock_level || 0)
                const isLow = stock < min
                const isEmpty = stock <= 0
                return (
                  <tr key={f.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, color: '#a78bfa' }}>{f.name}</td>
                    <td style={{ padding: '10px 16px', fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)' }}>{f.product_code}</td>
                    <td style={{ padding: '10px 16px' }}>
                      {(() => {
                        const s = splitVolume(stock, 'ml')
                        return <>
                          <span style={{ fontSize: 14, fontWeight: 700, color: isEmpty ? '#f87171' : isLow ? '#fbbf24' : '#4ade80' }}>{s.value}</span>
                          <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginLeft: 4 }}>{s.unit}</span>
                        </>
                      })()}
                    </td>
                    <td style={{ padding: '10px 16px', fontSize: 12, color: 'rgba(232,234,242,0.45)' }}>
                      {(() => {
                        if (min <= 0) return '—'
                        const s = splitVolume(min, 'ml')
                        return `${s.value} ${s.unit}`
                      })()}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {isEmpty
                        ? <span style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>OUT</span>
                        : isLow
                        ? <span style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>LOW</span>
                        : <span style={{ background: 'rgba(34,197,94,0.1)', color: '#4ade80', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>OK</span>
                      }
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => { setAdjModal({ fragrance: f, mode: 'add' }); setAdjQty(''); setAdjNotes('') }}
                          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#4ade80', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700 }}>
                          <Plus size={11} /> Add
                        </button>
                        <button onClick={() => { setAdjModal({ fragrance: f, mode: 'remove' }); setAdjQty(''); setAdjNotes('') }}
                          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#f87171', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700 }}>
                          <TrendingDown size={11} /> Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {displayed.length} fragrance{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Fragrance</h2>
              <button className="modal-close" onClick={() => setShowCreate(false)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Name *">
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Santal Black" autoFocus style={inp} />
                </Field>
                <Field label="Product Code">
                  <input value={form.product_code} onChange={e => setForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} placeholder="FRAG_00001" style={{ ...inp, fontFamily: 'monospace' }} />
                </Field>
                <Field label="Min Stock Level (ml)">
                  <input type="number" min={0} value={form.min_stock_level} onChange={e => setForm(f => ({ ...f, min_stock_level: e.target.value }))} placeholder="0" style={inp} />
                  <MlHint value={form.min_stock_level} unit="ml" />
                </Field>
                <Field label="Supplier">
                  <input value={form.supplier} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Optional" style={inp} />
                </Field>
                <Field label="Notes">
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes..." rows={2} style={{ ...inp, resize: 'vertical' }} />
                </Field>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
                {saving ? 'Creating...' : 'Create Fragrance'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust stock modal */}
      {adjModal && (
        <div className="modal-overlay" onClick={() => setAdjModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>{adjModal.mode === 'add' ? 'Add Stock' : 'Remove Stock'}</h2>
                <p style={{ color: '#a78bfa' }}>{adjModal.fragrance.name}</p>
              </div>
              <button className="modal-close" onClick={() => setAdjModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Quantity (ml) *">
                  <input type="number" min={0.01} step="any" value={adjQty} onChange={e => setAdjQty(e.target.value)} autoFocus placeholder="0" style={inp} />
                  <MlHint value={adjQty} unit="ml" />
                </Field>
                <Field label="Notes">
                  <input value={adjNotes} onChange={e => setAdjNotes(e.target.value)} placeholder="Optional reason..." style={inp} />
                </Field>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setAdjModal(null)}>Cancel</button>
              <button onClick={handleAdj} disabled={adjSaving} className={adjModal.mode === 'add' ? 'btn btn-primary' : 'btn btn-danger'} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {adjModal.mode === 'add' ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                {adjSaving ? 'Saving...' : adjModal.mode === 'add' ? 'Add Stock' : 'Remove Stock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderLeft: `3px solid ${color}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 22, fontFamily: 'Archivo Black, sans-serif', color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginTop: 4 }}>{label}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</label>
      {children}
    </div>
  )
}

const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
