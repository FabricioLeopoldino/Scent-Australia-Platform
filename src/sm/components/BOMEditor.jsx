import { useState, useEffect } from 'react'
import { Plus, Trash2, X, Calculator, Beaker, BookOpen, ExternalLink } from 'lucide-react'
import axios from 'axios'
import { useLocation } from 'wouter'
import { useToast } from '../SMModule.jsx'
import SearchSelect from './SearchSelect.jsx'
import IconButton from './IconButton.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

/**
 * Reusable BOM editor scoped to a single master product.
 *
 * Props:
 *   productCode  — master's product_code (the BOM key)
 *   master       — { volume_ml, default_oil_pct, is_pure_oil, is_candle, container_name } for calculator
 *   clientId     — when set, enables "+ From Client Stock" picker (Major Client masters)
 *   onChange     — callback after add/edit/delete (optional, for parent to refresh counts)
 *   compact      — if true, hides calculator (saves space in drawers)
 *   readOnly     — if true, hides add/edit/delete and links to the segment's BOM page
 *   segment      — 'MUSE' | 'SM' | 'STANDARD' | 'MAJOR'; scopes the component picker
 *                  and the read-only "Edit in BOM page" link (falls back to master.segment)
 */
export default function BOMEditor({ productCode, master = {}, clientId, onChange, compact = false, readOnly = false, segment }) {
  const [, navigate] = useLocation()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [allProducts, setAllProducts] = useState([])
  const [clientStock, setClientStock] = useState([])  // when clientId set
  const [showAdd, setShowAdd] = useState(false)
  const [addSource, setAddSource] = useState('general') // 'general' | 'client_stock'
  const [addForm, setAddForm] = useState({ product_id: '', client_stock_id: '', quantity_formula: 'fixed', quantity_per_unit: '1', component_group: 'core' })
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ quantity_per_unit: '', quantity_formula: 'fixed', component_group: 'core' })
  const [savingEdit, setSavingEdit] = useState(false)
  const [calcQty, setCalcQty] = useState(100)
  const [calcOilPct, setCalcOilPct] = useState(parseFloat(master.default_oil_pct) || 25)
  const { addToast } = useToast()

  // MUSE BOMs draw from MUSE + Shared components; SM/Standard/Major draw from
  // everything that isn't MUSE-only (i.e. SM + Shared + untagged).
  const isMuse = (segment || master.segment) === 'MUSE'

  useEffect(() => { if (productCode) load() }, [productCode])
  useEffect(() => { axios.get('/api/products', api()).then(r => setAllProducts(r.data)).catch(() => {}) }, [])
  useEffect(() => {
    if (clientId) {
      axios.get(`/api/clients/${clientId}/stock`, api()).then(r => setClientStock(r.data)).catch(() => {})
    }
  }, [clientId])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get(`/api/product-bom/${productCode}`, api())
      setEntries(r.data)
    } catch { addToast('Failed to load BOM', 'error') }
    finally { setLoading(false) }
  }

  async function handleAdd() {
    const isClientStock = addSource === 'client_stock'
    if (isClientStock && !addForm.client_stock_id) { addToast('Select a client stock item', 'error'); return }
    if (!isClientStock && !addForm.product_id) { addToast('Select a product', 'error'); return }
    // Duplicate check
    if (isClientStock && entries.some(e => e.client_stock_id === parseInt(addForm.client_stock_id))) {
      addToast('Already in this BOM — edit existing entry', 'error'); return
    }
    if (!isClientStock && entries.some(e => e.component_product_id === parseInt(addForm.product_id))) {
      addToast('Already in this BOM — edit existing entry', 'error'); return
    }
    setAdding(true)
    try {
      const payload = {
        product_type: productCode,
        quantity_formula: addForm.quantity_formula,
        quantity_per_unit: parseFloat(addForm.quantity_per_unit) || 1,
        component_group: addForm.component_group,
      }
      if (isClientStock) payload.client_stock_id = parseInt(addForm.client_stock_id)
      else payload.component_product_id = parseInt(addForm.product_id)
      await axios.post('/api/product-bom', payload, api())
      addToast('Component added')
      setShowAdd(false)
      setAddSource('general')
      setAddForm({ product_id: '', client_stock_id: '', quantity_formula: 'fixed', quantity_per_unit: '1', component_group: 'core' })
      await load()
      onChange?.()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to add', 'error') }
    finally { setAdding(false) }
  }

  function startEdit(entry) {
    setEditingId(entry.id)
    setEditForm({
      quantity_per_unit: String(entry.quantity_per_unit),
      quantity_formula: entry.quantity_formula || 'fixed',
      component_group: entry.component_group || 'core',
    })
  }

  async function saveEdit(entry) {
    setSavingEdit(true)
    try {
      await axios.put(`/api/product-bom/${entry.id}`, {
        quantity_formula: editForm.quantity_formula,
        quantity_per_unit: parseFloat(editForm.quantity_per_unit) || 1,
        component_group: editForm.component_group,
      }, api())
      addToast('Saved')
      setEditingId(null)
      await load()
      onChange?.()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSavingEdit(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Remove this component from BOM?')) return
    try {
      await axios.delete(`/api/product-bom/${id}`, api())
      addToast('Removed')
      await load()
      onChange?.()
    } catch { addToast('Failed', 'error') }
  }

  // General product options — exclude FG/Fragrance and already-added components
  const usedProductIds = new Set(entries.filter(e => e.component_product_id).map(e => e.component_product_id))
  const usedClientStockIds = new Set(entries.filter(e => e.client_stock_id).map(e => e.client_stock_id))
  const addOptions = allProducts
    .filter(p => !['FINISHED_GOOD', 'FRAGRANCE'].includes(p.category))
    .filter(p => isMuse ? (p.segment === 'MUSE' || p.segment === 'SHARED') : p.segment !== 'MUSE')
    .filter(p => !usedProductIds.has(p.id))
    .map(p => ({
      value: p.id,
      label: p.name,
      sub: `${p.product_code} · ${p.category.replace('_', ' ')}`,
    }))
  // Client stock options (only when clientId provided)
  const clientStockOptions = clientStock
    .filter(cs => !usedClientStockIds.has(cs.id))
    .map(cs => ({
      value: cs.id,
      label: cs.product_name,
      sub: `${cs.product_code} · ${Number(cs.quantity || 0).toLocaleString()} ${cs.unit || 'units'} available`,
    }))

  // Calculator
  const volume = parseFloat(master.volume_ml) || 0
  const isPureOil = master.is_pure_oil
  const fragQty = isPureOil ? calcQty * volume : calcQty * volume * (calcOilPct / 100)
  const ethanolQty = isPureOil ? 0 : calcQty * volume * ((100 - calcOilPct) / 100)
  const calcEntries = entries.map(e => {
    const qty = e.quantity_formula === 'ethanol_pct'
      ? calcQty * volume * ((100 - calcOilPct) / 100)
      : calcQty * parseFloat(e.quantity_per_unit)
    return { ...e, calc_qty: qty }
  })

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 800, color: 'rgba(232,234,242,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          <BookOpen size={14} /> BOM Components
        </div>
        {readOnly ? (
          <button onClick={() => navigate(`${isMuse ? '/bom-muse' : '/bom-sm'}#m-${encodeURIComponent(productCode || '')}`)}
            style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 6, padding: '5px 11px', cursor: 'pointer', color: '#60a5fa', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
            <ExternalLink size={11} /> Edit in BOM page
          </button>
        ) : (
          <button onClick={() => setShowAdd(s => !s)}
            style={{ background: showAdd ? 'rgba(96,165,250,0.15)' : 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 6, padding: '5px 11px', cursor: 'pointer', color: '#60a5fa', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Plus size={11} /> {showAdd ? 'Cancel' : 'Add Component'}
          </button>
        )}
      </div>

      {/* Add component form */}
      {!readOnly && showAdd && (
        <div style={{ marginBottom: 12, padding: 14, background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.18)', borderRadius: 9 }}>
          {clientId && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button onClick={() => { setAddSource('general'); setAddForm(f => ({ ...f, product_id: '', client_stock_id: '' })) }} style={{
                flex: 1, background: addSource === 'general' ? 'rgba(96,165,250,0.2)' : 'rgba(255,255,255,0.04)',
                border: addSource === 'general' ? '1px solid #60a5fa' : '1px solid rgba(255,255,255,0.1)',
                color: addSource === 'general' ? '#60a5fa' : 'rgba(232,234,242,0.5)',
                borderRadius: 7, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>+ From General Stock</button>
              <button onClick={() => { setAddSource('client_stock'); setAddForm(f => ({ ...f, product_id: '', client_stock_id: '' })) }} style={{
                flex: 1, background: addSource === 'client_stock' ? 'rgba(167,139,250,0.2)' : 'rgba(255,255,255,0.04)',
                border: addSource === 'client_stock' ? '1px solid #a78bfa' : '1px solid rgba(255,255,255,0.1)',
                color: addSource === 'client_stock' ? '#a78bfa' : 'rgba(232,234,242,0.5)',
                borderRadius: 7, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>+ From Client Stock</button>
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>{addSource === 'client_stock' ? 'Client stock item *' : 'Component *'}</label>
            {addSource === 'client_stock' ? (
              <SearchSelect
                value={addForm.client_stock_id}
                onChange={v => setAddForm(f => ({ ...f, client_stock_id: v }))}
                options={clientStockOptions}
                placeholder={clientStockOptions.length === 0 ? 'No client stock yet — add in Client Stock tab' : 'Search client stock...'}
                clearable={false}
              />
            ) : (
              <SearchSelect
                value={addForm.product_id}
                onChange={v => setAddForm(f => ({ ...f, product_id: v }))}
                options={addOptions}
                placeholder="Search component..."
                clearable={false}
              />
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              <label style={lbl}>Formula</label>
              <select value={addForm.quantity_formula} onChange={e => setAddForm(f => ({ ...f, quantity_formula: e.target.value }))} style={{ ...inp, cursor: 'pointer' }}>
                <option value="fixed">Fixed qty</option>
                <option value="ethanol_pct">Ethanol % (auto)</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Qty per unit</label>
              <input type="number" min={0} step="any" value={addForm.quantity_per_unit}
                onChange={e => setAddForm(f => ({ ...f, quantity_per_unit: e.target.value }))}
                disabled={addForm.quantity_formula === 'ethanol_pct'}
                style={{ ...inp, opacity: addForm.quantity_formula === 'ethanol_pct' ? 0.5 : 1 }}
              />
            </div>
            <div>
              <label style={lbl}>Group</label>
              <select value={addForm.component_group} onChange={e => setAddForm(f => ({ ...f, component_group: e.target.value }))} style={{ ...inp, cursor: 'pointer' }}>
                <option value="core">Core</option>
                <option value="packing">Packing</option>
                <option value="labeling">Labeling</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => { setShowAdd(false); setAddForm({ product_id: '', quantity_formula: 'fixed', quantity_per_unit: '1', component_group: 'core' }) }}
              style={btnCancel}>Cancel</button>
            <button onClick={handleAdd} disabled={adding} style={btnPrimary}>
              {adding ? 'Adding...' : 'Add to BOM'}
            </button>
          </div>
        </div>
      )}

      {/* Entries list */}
      {loading ? (
        <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', padding: '12px 0' }}>Loading...</div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic', padding: '16px 0', textAlign: 'center' }}>
          {readOnly ? 'No components yet. Use the BOM page to add them.' : 'No components yet. Click "Add Component" above.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Fragrance row (automatic, not editable) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.18)', borderRadius: 7 }}>
            <Beaker size={13} color="#a78bfa" />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa' }}>Fragrance</div>
              <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>Selected per production line · {isPureOil ? '100% oil' : 'volume × oil %'}</div>
            </div>
            <span style={{ fontSize: 10, color: 'rgba(167,139,250,0.6)', fontStyle: 'italic' }}>automatic</span>
          </div>

          {/* Editable entries */}
          {entries.map(e => {
            const isEditing = editingId === e.id
            const isClientStock = !!e.client_stock_id
            return (
              <div key={e.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: isClientStock ? 'rgba(167,139,250,0.06)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${isClientStock ? 'rgba(167,139,250,0.2)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 7,
              }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: isClientStock ? '#a78bfa' : '#4ade80', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {e.component_name}
                    {isClientStock && <span style={{ background: 'rgba(167,139,250,0.18)', color: '#a78bfa', padding: '1px 6px', borderRadius: 20, fontSize: 9, fontWeight: 800 }}>CLIENT</span>}
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>
                    {e.component_code} · {(e.component_category || '').replace('_', ' ')}
                  </div>
                </div>
                {isEditing && !readOnly ? (
                  <>
                    <select value={editForm.quantity_formula} onChange={ev => setEditForm(f => ({ ...f, quantity_formula: ev.target.value }))} style={{ ...inp, width: 130, fontSize: 11 }}>
                      <option value="fixed">Fixed</option>
                      <option value="ethanol_pct">Ethanol %</option>
                    </select>
                    <input type="number" min={0} step="any" value={editForm.quantity_per_unit}
                      onChange={ev => setEditForm(f => ({ ...f, quantity_per_unit: ev.target.value }))}
                      disabled={editForm.quantity_formula === 'ethanol_pct'}
                      style={{ ...inp, width: 70, fontSize: 11 }}
                    />
                    <select value={editForm.component_group} onChange={ev => setEditForm(f => ({ ...f, component_group: ev.target.value }))} style={{ ...inp, width: 95, fontSize: 11 }}>
                      <option value="core">Core</option>
                      <option value="packing">Packing</option>
                      <option value="labeling">Labeling</option>
                    </select>
                    <button onClick={() => saveEdit(e)} disabled={savingEdit} style={{ ...btnPrimary, padding: '5px 10px' }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ ...btnCancel, padding: '5px 10px' }}>X</button>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 12, fontWeight: 700, color: e.quantity_formula === 'ethanol_pct' ? '#fbbf24' : '#60a5fa', minWidth: 80, textAlign: 'right' }}>
                      {e.quantity_formula === 'ethanol_pct' ? 'ethanol %' : `${e.quantity_per_unit} ${e.component_unit || 'units'}`}
                    </span>
                    {e.component_group && e.component_group !== 'core' && (
                      <span style={{ background: 'rgba(34,197,94,0.12)', color: '#4ade80', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>{e.component_group}</span>
                    )}
                    {!readOnly && (
                      <>
                        <IconButton onClick={() => startEdit(e)} title="Edit"><BookOpen size={13} /></IconButton>
                        <IconButton variant="danger" onClick={() => handleDelete(e.id)} title="Remove"><Trash2 size={13} /></IconButton>
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Calculator */}
      {!compact && volume > 0 && entries.length > 0 && (
        <div style={{ marginTop: 18, padding: 14, background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.18)', borderRadius: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Calculator size={13} color="#a78bfa" />
            <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Calculator</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div>
              <label style={lbl}>Units to produce</label>
              <input type="number" min={1} value={calcQty} onChange={e => setCalcQty(parseInt(e.target.value) || 0)} style={inp} />
            </div>
            <div>
              <label style={lbl}>Oil %</label>
              <input type="number" min={0} max={100} value={calcOilPct} onChange={e => setCalcOilPct(parseFloat(e.target.value) || 0)} disabled={isPureOil} style={{ ...inp, opacity: isPureOil ? 0.5 : 1 }} />
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {!master.is_candle && !isPureOil && (
              <span style={chip('#fbbf24')}>{ethanolQty.toFixed(1)} ml ethanol</span>
            )}
            <span style={chip('#a78bfa')}>{fragQty.toFixed(1)} ml fragrance</span>
            {calcEntries.filter(e => e.quantity_formula !== 'ethanol_pct').map(e => (
              <span key={e.id} style={chip('#60a5fa')}>{Number(e.calc_qty).toLocaleString()} {e.component_unit || 'units'} {e.component_name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const lbl = { display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }
const inp = { width: '100%', background: 'var(--field-bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)', fontSize: 12, outline: 'none', boxSizing: 'border-box' }
const btnPrimary = { background: 'var(--accent)', border: 'none', borderRadius: 7, padding: '6px 14px', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }
const btnCancel = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 14px', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer', fontWeight: 600 }
const iconBtn = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', color: 'var(--text-secondary)' }
function chip(color) { return { background: `${color}1a`, color, padding: '3px 9px', borderRadius: 14, fontSize: 11, fontWeight: 700 } }
