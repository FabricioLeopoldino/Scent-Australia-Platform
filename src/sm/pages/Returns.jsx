import { useState, useEffect } from 'react'
import { Plus, X, Search } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import { useToast } from '../SMModule.jsx'
import MlHint from '../components/MlHint.jsx'
import { fmt } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const CAT_COLORS = { FRAGRANCE:'#a78bfa', RAW_MATERIALS:'#fbbf24', COMPONENTS:'#60a5fa', FINISHED_GOODS:'#4ade80', READY_FORMULA:'#fb923c' }

export default function Returns() {
  const [products, setProducts]   = useState([])
  const [returns, setReturns]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [search, setSearch]       = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [showDrop, setShowDrop]   = useState(false)
  const [form, setForm]           = useState({ product_id: '', quantity: '', notes: '' })
  const [saving, setSaving]       = useState(false)
  const { addToast } = useToast()

  useEffect(() => { loadReturns(); loadProducts() }, [])

  async function loadProducts() {
    const res = await axios.get('/api/products', api())
    setProducts(res.data)
  }

  async function loadReturns() {
    setLoading(true)
    try {
      const res = await axios.get('/api/transactions', { ...api(), params: { type: 'return' } })
      setReturns(res.data)
    } catch { addToast('Failed to load returns', 'error') }
    finally { setLoading(false) }
  }

  function selectProduct(p) {
    setForm(f => ({ ...f, product_id: p.id }))
    setProductSearch(p.name)
    setShowDrop(false)
  }

  async function handleSubmit() {
    if (!form.product_id || !form.quantity || parseFloat(form.quantity) <= 0) {
      addToast('Product and quantity required', 'error'); return
    }
    setSaving(true)
    try {
      await axios.post('/api/stock/return', {
        product_id: form.product_id,
        quantity: parseFloat(form.quantity),
        notes: form.notes || null
      }, api())
      addToast('Return registered — stock updated')
      setShowModal(false)
      setForm({ product_id: '', quantity: '', notes: '' })
      setProductSearch('')
      loadReturns()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.product_code.toLowerCase().includes(productSearch.toLowerCase())
  )

  const displayed = returns.filter(r =>
    !search || (r.product_name || '').toLowerCase().includes(search.toLowerCase())
  )


  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Returns</h1>
          <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 4 }}>Stock returned to inventory</p>
        </div>
        <Button onClick={() => setShowModal(true)}>
          <Plus size={15} /> Register Return
        </Button>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 320 }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search product..." style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 12px 7px 28px', color: '#e8eaf2', fontSize: 13, outline: 'none' }} />
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Date', 'Product', 'Category', 'Quantity', 'Balance After', 'Notes', 'User'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: '32px 14px', textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No returns registered</td></tr>
              ) : displayed.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '9px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', whiteSpace: 'nowrap' }}>
                    {fmt(r.created_at)}
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)' }}>{new Date(r.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}</div>
                  </td>
                  <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{r.product_name || '—'}</td>
                  <td style={{ padding: '9px 14px' }}>
                    {r.category && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: CAT_COLORS[r.category], fontSize: 10, fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: CAT_COLORS[r.category], flexShrink: 0 }} />{r.category.replace('_',' ')}</span>}
                  </td>
                  <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 700, color: '#a78bfa' }}>+{Number(r.quantity).toLocaleString()} {r.unit}</td>
                  <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{r.balance_after !== null ? `${Number(r.balance_after).toLocaleString()} ${r.unit}` : '—'}</td>
                  <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.45)', maxWidth: 200 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</div>
                  </td>
                  <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.4)' }}>{r.user_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {displayed.length} return{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Register Return Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Register Return</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}><X size={14} /></button>
            </div>
            <div className="modal-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <F label="Product *">
                <div style={{ position: 'relative' }}>
                  <input value={productSearch} onChange={e => { setProductSearch(e.target.value); setForm(f => ({ ...f, product_id: '' })); setShowDrop(true) }} onFocus={() => setShowDrop(true)} onBlur={() => setTimeout(() => setShowDrop(false), 150)} placeholder="Search product..." style={inp} autoFocus />
                  {showDrop && filteredProducts.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--popover-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 8, zIndex: 100, maxHeight: 200, overflowY: 'auto' }}>
                      {filteredProducts.slice(0, 20).map(p => (
                        <div key={p.id} onMouseDown={() => selectProduct(p)} style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <span>{p.name}</span>
                          <span style={{ color: '#4ade80', fontSize: 11 }}>{Number(p.current_stock).toLocaleString()} {p.unit}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </F>
              <F label="Quantity *">
                <input type="number" min={0.01} step="any" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} placeholder="0" style={inp} />
                <MlHint value={form.quantity} unit={products.find(p => p.id === form.product_id)?.unit} />
              </F>
              <F label="Notes">
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Reason, order number, client..." style={inp} />
              </F>
            </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>{saving ? 'Saving...' : 'Register Return'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function F({ label, children }) {
  return (
    <div>
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
