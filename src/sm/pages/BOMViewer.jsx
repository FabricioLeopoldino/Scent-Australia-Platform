import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, ChevronDown, Calculator, Beaker, History, RotateCcw } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import SearchSelect from '../components/SearchSelect.jsx'
import { InfoIcon } from '../components/Tooltip.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const CAT_COLORS = {
  RAW_MATERIAL: '#60a5fa',
  COMPONENT: '#4ade80',
  LABEL: '#f472b6',
  FRAGRANCE: '#a78bfa',
  READY_FORMULA: '#fbbf24',
  FINISHED_GOOD: '#e879f9',
}

export default function BOMViewer() {
  const [selected, setSelected] = useState(null)
  const [segmentFilter, setSegmentFilter] = useState('ALL')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [allProducts, setAllProducts] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addFormula, setAddFormula] = useState('fixed')
  const [addQty, setAddQty] = useState('1')
  const [addGroup, setAddGroup] = useState('core')
  const [addProduct, setAddProduct] = useState(null)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editVal, setEditVal] = useState('')
  const [editFormula, setEditFormula] = useState('fixed')
  const [editGroup, setEditGroup] = useState('core')
  const [calcQty, setCalcQty] = useState(100)
  const [calcOilPct, setCalcOilPct] = useState(25)

  useEffect(() => {
    const tab = allProducts.find(p => p.product_code === selected)
    if (tab?.default_oil_pct) setCalcOilPct(parseFloat(tab.default_oil_pct))
    else if (!allProducts.some(p => p.product_code === selected)) setCalcOilPct(25)
  }, [selected])
  const [showHistory, setShowHistory] = useState(false)
  const [historyData, setHistoryData] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState({})
  const [rollingBack, setRollingBack] = useState(null)
  const [showNewProduct, setShowNewProduct] = useState(false)
  const [npForm, setNpForm] = useState({ name: '', category: 'COMPONENT', product_code: '', unit: 'units' })
  const [npSaving, setNpSaving] = useState(false)
  const [showNewType, setShowNewType] = useState(false)
  const [ntForm, setNtForm] = useState({
    name: '', product_code: '', volume_ml: '', volume_unit: 'ml', default_oil_pct: '25',
    segment: 'MUSE', container_type_id: '', client_id: '',
  })
  const [ntSaving, setNtSaving] = useState(false)
  const [containerTypes, setContainerTypes] = useState([])
  const [majorClients, setMajorClients] = useState([])
  const { addToast } = useToast()

  // All masters loaded from database (dynamic). No more hardcoded list.
  const allTabs = allProducts
    .filter(p => p.is_master === true && !p.archived)
    .filter(p => segmentFilter === 'ALL' || p.segment === segmentFilter)
    .map(p => ({
      key: p.product_code,
      label: p.name,
      segment: p.segment,
      client_id: p.client_id,
      volume: p.volume_ml ? parseFloat(p.volume_ml) : null,
      volumeUnit: p.volume_unit || 'ml',
      defaultOilPct: p.default_oil_pct ? parseFloat(p.default_oil_pct) : 25,
    }))
  const selectedType = allTabs.find(p => p.key === selected)
  // Detect candle/pure_oil via container_type (loaded from products with JOIN — currently approximated by checking product code suffix)
  const selectedProduct = allProducts.find(p => p.product_code === selected && p.is_master)
  const isCandle = selectedProduct?.is_candle || false
  const isPureOil = selectedProduct?.is_pure_oil || false

  useEffect(() => {
    if (selected) loadEntries()
    else { setEntries([]); setLoading(false) }
    setShowHistory(false)
    setHistoryData([])
    setHistoryExpanded({})
  }, [selected])

  function loadAllProducts() {
    axios.get('/api/products', api()).then(r => {
      setAllProducts(r.data)
      // Auto-select first master if nothing selected
      if (!selected) {
        const firstMaster = r.data.find(p => p.is_master && !p.archived)
        if (firstMaster) setSelected(firstMaster.product_code)
      }
    }).catch(() => {})
  }

  useEffect(() => { loadAllProducts() }, [])
  useEffect(() => {
    axios.get('/api/container-types', api()).then(r => setContainerTypes(r.data)).catch(() => {})
    axios.get('/api/major-clients', api()).then(r => setMajorClients(r.data)).catch(() => {})
  }, [])

  async function loadEntries() {
    if (!selected) return
    setLoading(true)
    try {
      const r = await axios.get(`/api/product-bom/${selected}`, api())
      setEntries(r.data)
    } catch { addToast('Failed to load BOM', 'error') }
    finally { setLoading(false) }
  }

  async function handleAdd() {
    if (!addProduct) { addToast('Select a product', 'error'); return }
    if (entries.some(e => e.component_product_id === addProduct.id && e.is_active !== false)) {
      addToast(`${addProduct.name} is already in this BOM — edit the existing entry instead`, 'error'); return
    }
    setSaving(true)
    try {
      await axios.post('/api/product-bom', {
        product_type: selected,
        component_product_id: addProduct.id,
        quantity_formula: addFormula,
        quantity_per_unit: parseFloat(addQty) || 1,
        component_group: addGroup,
      }, api())
      addToast('Component added')
      setShowAdd(false)
      setAddProduct(null)
      setAddSearch('')
      setAddQty('1')
      setAddFormula('fixed')
      setAddGroup('core')
      loadEntries()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to add', 'error') }
    finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Remove this component from BOM?')) return
    try {
      await axios.delete(`/api/product-bom/${id}`, api())
      addToast('Removed')
      loadEntries()
    } catch { addToast('Failed to remove', 'error') }
  }

  function npDefaultUnit(cat) {
    if (['FRAGRANCE', 'RAW_MATERIAL', 'READY_FORMULA'].includes(cat)) return 'ml'
    return 'units'
  }

  function npSuggestCode(cat) {
    const prefixes = { FRAGRANCE: 'FRAG_', RAW_MATERIAL: 'RAW_', COMPONENT: 'COMP_', LABEL: 'LABEL_', FINISHED_GOOD: 'FG_', READY_FORMULA: 'RF-FRAG_' }
    const prefix = prefixes[cat] || 'PROD_'
    const last = allProducts
      .filter(p => p.product_code?.startsWith(prefix))
      .map(p => parseInt(p.product_code.replace(prefix, '')) || 0)
      .sort((a, b) => b - a)[0] || 0
    return prefix + String(last + 1).padStart(5, '0')
  }

  async function handleNewProduct() {
    if (!npForm.name.trim()) { addToast('Name is required', 'error'); return }
    if (!npForm.product_code.trim()) { addToast('Product code is required', 'error'); return }
    setNpSaving(true)
    try {
      const res = await axios.post('/api/products', {
        name: npForm.name.trim(),
        product_code: npForm.product_code.toUpperCase().trim(),
        category: npForm.category,
        unit: npForm.unit,
        current_stock: 0,
        min_stock_level: 0,
      }, api())
      const created = res.data
      setAllProducts(prev => [...prev, created])
      setAddProduct(created)
      setAddSearch(created.name)
      setShowNewProduct(false)
      setNpForm({ name: '', category: 'COMPONENT', product_code: '', unit: 'units' })
      setShowAdd(true)
      addToast(`"${created.name}" created — now set the quantity and save to BOM`)
    } catch (e) { addToast(e.response?.data?.error || 'Failed to create product', 'error') }
    finally { setNpSaving(false) }
  }

  async function handleNewProductType() {
    if (!ntForm.name.trim()) { addToast('Name is required', 'error'); return }
    if (!ntForm.product_code.trim()) { addToast('Product code is required', 'error'); return }
    if (ntForm.segment === 'MAJOR' && !ntForm.client_id) { addToast('Major Client requires selecting a client', 'error'); return }
    setNtSaving(true)
    try {
      const res = await axios.post('/api/masters', {
        name: ntForm.name.trim(),
        product_code: ntForm.product_code.toUpperCase().trim(),
        segment: ntForm.segment,
        client_id: ntForm.segment === 'MAJOR' ? parseInt(ntForm.client_id) : null,
        volume_ml: ntForm.volume_ml ? parseFloat(ntForm.volume_ml) : null,
        volume_unit: ntForm.volume_unit || 'ml',
        default_oil_pct: parseFloat(ntForm.default_oil_pct) || 25,
        container_type_id: ntForm.container_type_id ? parseInt(ntForm.container_type_id) : null,
        bom_components: [],
        fragrance_ids: [],
        generate_variants: false,
      }, api())
      const created = res.data.master
      // Reload all products so the new master appears in tabs
      loadAllProducts()
      setSelected(created.product_code)
      setShowNewType(false)
      setNtForm({ name: '', product_code: '', volume_ml: '', volume_unit: 'ml', default_oil_pct: '25', segment: 'MUSE', container_type_id: '', client_id: '' })
      addToast(`"${created.name}" master created — now build its BOM`)
    } catch (e) { addToast(e.response?.data?.error || 'Failed to create master', 'error') }
    finally { setNtSaving(false) }
  }

  async function saveEdit(entry) {
    setSaving(true)
    try {
      await axios.put(`/api/product-bom/${entry.id}`, { quantity_formula: editFormula, quantity_per_unit: parseFloat(editVal) || 1, component_group: editGroup }, api())
      setEditingId(null)
      loadEntries()
    } catch { addToast('Failed to save', 'error') }
    finally { setSaving(false) }
  }

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const r = await axios.get(`/api/product-bom/${selected}/history`, api())
      setHistoryData(r.data)
    } catch { addToast('Failed to load history', 'error') }
    finally { setHistoryLoading(false) }
  }

  async function handleRollback(version) {
    if (!confirm(`Restore BOM for ${selectedType?.label} to version ${version}? Current state will be replaced.`)) return
    setRollingBack(version)
    try {
      const r = await axios.post(`/api/product-bom/${selected}/rollback`, { version }, api())
      setEntries(r.data)
      addToast(`BOM restored to v${version}`)
      loadHistory()
    } catch (e) { addToast(e.response?.data?.error || 'Rollback failed', 'error') }
    finally { setRollingBack(null) }
  }

  function toggleHistory() {
    const next = !showHistory
    setShowHistory(next)
    if (next && historyData.length === 0) loadHistory()
  }

  function computeDiff(currSnap, prevSnap) {
    const prevByPid = {}
    ;(prevSnap || []).forEach(c => { prevByPid[c.component_product_id] = c })
    const currByPid = {}
    ;(currSnap || []).forEach(c => { currByPid[c.component_product_id] = c })
    const added = [], removed = [], changed = []
    for (const c of (currSnap || [])) {
      const prev = prevByPid[c.component_product_id]
      if (!prev) { added.push(c) }
      else if (Number(c.quantity_per_unit) !== Number(prev.quantity_per_unit) || c.quantity_formula !== prev.quantity_formula || c.component_group !== prev.component_group) {
        changed.push({ current: c, previous: prev })
      }
    }
    for (const c of (prevSnap || [])) {
      if (!currByPid[c.component_product_id]) removed.push(c)
    }
    return { added, removed, changed }
  }

  const filteredProducts = allProducts.filter(p =>
    !['FINISHED_GOOD', 'FRAGRANCE'].includes(p.category) &&
    !entries.find(e => e.component_product_id === p.id) &&
    (p.name.toLowerCase().includes(addSearch.toLowerCase()) || p.product_code.toLowerCase().includes(addSearch.toLowerCase()))
  ).slice(0, 20)

  // Calculator
  const calcEntries = entries.map(e => {
    let qty
    if (e.quantity_formula === 'ethanol_pct') {
      qty = calcQty * (selectedType?.volume || 0) * ((100 - calcOilPct) / 100)
    } else {
      qty = calcQty * parseFloat(e.quantity_per_unit)
    }
    return { ...e, calc_qty: qty }
  })
  const fragQty = isPureOil
    ? calcQty * (selectedType?.volume || 0)
    : calcQty * (selectedType?.volume || 0) * (calcOilPct / 100)

  return (
    <div style={{ padding: 28 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2', marginBottom: 4 }}>BOM Builder</h1>
        <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)' }}>Define which real products go into each product type. Fragrance is always selected per production line.</p>
      </div>

      {/* Segment filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginRight: 4 }}>Filter:</span>
        {[['ALL', '#e8eaf2'], ['MUSE', '#fbbf24'], ['STANDARD', '#60a5fa'], ['MAJOR', '#a78bfa']].map(([s, color]) => (
          <button key={s} onClick={() => setSegmentFilter(s)} style={{
            background: segmentFilter === s ? `${color}22` : 'rgba(255,255,255,0.04)',
            border: segmentFilter === s ? `1px solid ${color}` : '1px solid rgba(255,255,255,0.08)',
            borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            color: segmentFilter === s ? color : 'rgba(232,234,242,0.5)',
          }}>{s}</button>
        ))}
      </div>

      {/* Master tabs (dynamic from DB) */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24, alignItems: 'center' }}>
        {allTabs.length === 0 ? (
          <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.45)', fontStyle: 'italic', padding: '6px 0' }}>
            No masters yet{segmentFilter !== 'ALL' ? ` for ${segmentFilter}` : ''}. Click "New Master" to start.
          </div>
        ) : allTabs.map(pt => {
          const segColors = { MUSE: '#fbbf24', STANDARD: '#60a5fa', MAJOR: '#a78bfa' }
          const c = segColors[pt.segment] || '#e879f9'
          const active = selected === pt.key
          return (
            <button key={pt.key} onClick={() => { setSelected(pt.key); setShowAdd(false); setEditingId(null) }} style={{
              background: active ? `${c}22` : 'rgba(255,255,255,0.04)',
              border: active ? `1px solid ${c}` : '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              color: active ? c : 'rgba(232,234,242,0.55)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ fontSize: 9, opacity: 0.7 }}>{pt.segment}</span>
              {pt.label}
            </button>
          )
        })}
        <button onClick={() => setShowNewType(true)} title="Create new master" style={{ background: 'rgba(232,121,249,0.08)', border: '1px dashed rgba(232,121,249,0.3)', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#e879f9', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={12} /> New Master
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, alignItems: 'start' }}>
        {/* BOM Entries */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(232,234,242,0.45)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Components for {selectedType?.label}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={toggleHistory} style={{ background: showHistory ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.05)', border: showHistory ? '1px solid rgba(251,191,36,0.3)' : '1px solid rgba(255,255,255,0.1)', borderRadius: 7, padding: '6px 12px', color: showHistory ? '#fbbf24' : 'rgba(232,234,242,0.5)', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                <History size={13} /> History
              </button>
              <button onClick={() => setShowNewProduct(true)} style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 7, padding: '6px 12px', color: '#10b981', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                <Plus size={13} /> New Component
              </button>
              <button onClick={() => { setShowAdd(v => { if (!v) loadAllProducts(); return !v }); setEditingId(null) }} style={{ background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 7, padding: '6px 12px', color: '#60a5fa', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                <Plus size={13} /> Add Component
              </button>
            </div>
          </div>

          {/* Add panel */}
          {showAdd && (
            <div style={{ background: 'rgba(37,99,235,0.07)', border: '1px solid rgba(37,99,235,0.2)', borderRadius: 10, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 10 }}>Add Component</div>
              <input
                value={addSearch} onChange={e => setAddSearch(e.target.value)}
                placeholder="Search products by name or code..."
                style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', marginBottom: 8 }}
              />
              {addSearch && (
                <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 7, marginBottom: 10 }}>
                  {filteredProducts.length === 0 ? (
                    <div style={{ padding: '10px 12px', fontSize: 12, color: 'rgba(232,234,242,0.4)' }}>No products found</div>
                  ) : filteredProducts.map(p => (
                    <button key={p.id} onClick={() => { setAddProduct(p); setAddSearch(p.name) }} style={{
                      width: '100%', background: addProduct?.id === p.id ? 'rgba(37,99,235,0.15)' : 'transparent',
                      border: 'none', padding: '8px 12px', cursor: 'pointer', textAlign: 'left',
                      color: '#e8eaf2', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8
                    }}>
                      <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: `${CAT_COLORS[p.category] || '#888'}22`, color: CAT_COLORS[p.category] || '#888', fontWeight: 700 }}>{p.category}</span>
                      <span>{p.name}</span>
                      <span style={{ color: 'rgba(232,234,242,0.4)', marginLeft: 'auto', fontSize: 11 }}>{p.product_code}</span>
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>Formula Type</label>
                  <SearchSelect
                    value={addFormula}
                    onChange={v => setAddFormula(v)}
                    options={[
                      { value: 'fixed', label: 'Fixed (qty × N)' },
                      { value: 'ethanol_pct', label: 'Ethanol % (volume × (100 - oil%))' },
                    ]}
                    clearable={false}
                  />
                </div>
                {addFormula === 'fixed' && (
                  <div>
                    <label style={lbl}>Qty per unit</label>
                    <input type="number" min={0} step="any" value={addQty} onChange={e => setAddQty(e.target.value)} style={inp} />
                  </div>
                )}
                <div>
                  <label style={lbl}>Include when</label>
                  <SearchSelect
                    value={addGroup}
                    onChange={v => setAddGroup(v)}
                    options={[
                      { value: 'core', label: 'Always' },
                      { value: 'packing', label: 'Packing only' },
                      { value: 'labeling', label: 'Labeling only' },
                    ]}
                    clearable={false}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => { setShowAdd(false); setAddProduct(null); setAddSearch('') }} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 7, padding: '6px 14px', color: 'rgba(232,234,242,0.6)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleAdd} disabled={saving || !addProduct} style={{ background: '#2563eb', border: 'none', borderRadius: 7, padding: '6px 14px', color: 'white', fontSize: 12, fontWeight: 700, cursor: saving || !addProduct ? 'not-allowed' : 'pointer', opacity: !addProduct ? 0.5 : 1 }}>
                  {saving ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {/* Entry list */}
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
            {/* Fragrance row — always present, read-only */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(167,139,250,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Beaker size={14} style={{ color: '#a78bfa', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa' }}>Fragrance</div>
                  <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>Selected per production line · {isPureOil ? '100% oil' : 'volume × oil %'}</div>
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'rgba(167,139,250,0.6)', fontStyle: 'italic' }}>automatic</span>
            </div>

            {loading ? (
              <div style={{ padding: 24, color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>Loading...</div>
            ) : entries.length === 0 ? (
              <div style={{ padding: 24, color: 'rgba(232,234,242,0.3)', fontSize: 13, textAlign: 'center' }}>No components yet. Add the first component above.</div>
            ) : entries.map(e => {
              const isEditing = editingId === e.id
              const catColor = CAT_COLORS[e.component_category] || '#e8eaf2'
              return (
                <div key={e.id} style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{e.component_name}</div>
                      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{e.component_code} · {e.component_category}</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isEditing ? (
                      <>
                        <select value={editFormula} onChange={ev => setEditFormula(ev.target.value)} style={{ ...sel, width: 'auto', fontSize: 11, padding: '3px 6px' }}>
                          <option value="fixed">fixed</option>
                          <option value="ethanol_pct">ethanol %</option>
                        </select>
                        {editFormula === 'fixed' && (
                          <input type="number" min={0} step="any" value={editVal} onChange={ev => setEditVal(ev.target.value)} autoFocus
                            style={{ width: 65, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(96,165,250,0.5)', borderRadius: 6, padding: '3px 7px', color: '#e8eaf2', fontSize: 12, outline: 'none' }} />
                        )}
                        <select value={editGroup} onChange={ev => setEditGroup(ev.target.value)} style={{ ...sel, width: 'auto', fontSize: 11, padding: '3px 6px' }}>
                          <option value="core">Always</option>
                          <option value="packing">Packing only</option>
                          <option value="labeling">Labeling only</option>
                        </select>
                        <button onClick={() => saveEdit(e)} disabled={saving} style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', color: '#4ade80', fontSize: 11, fontWeight: 700 }}>✓</button>
                        <button onClick={() => setEditingId(null)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', color: 'rgba(232,234,242,0.5)', fontSize: 11 }}>✕</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setEditingId(e.id); setEditVal(String(e.quantity_per_unit)); setEditFormula(e.quantity_formula); setEditGroup(e.component_group || 'core') }} title="Edit"
                          style={{ background: 'none', border: '1px solid transparent', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', color: '#e8eaf2', fontSize: 12, fontWeight: 700 }}
                          onMouseEnter={ev => { ev.currentTarget.style.border = '1px solid rgba(96,165,250,0.3)'; ev.currentTarget.style.background = 'rgba(96,165,250,0.06)' }}
                          onMouseLeave={ev => { ev.currentTarget.style.border = '1px solid transparent'; ev.currentTarget.style.background = 'none' }}
                        >
                          {e.quantity_formula === 'ethanol_pct'
                            ? <span style={{ color: '#60a5fa' }}>ethanol %</span>
                            : <>{e.quantity_per_unit} <span style={{ color: 'rgba(232,234,242,0.4)', fontSize: 11 }}>{e.component_unit}</span></>}
                          <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', marginLeft: 3 }}>✏</span>
                        </button>
                        {e.component_group && e.component_group !== 'core' && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                            background: e.component_group === 'packing' ? 'rgba(74,222,128,0.12)' : 'rgba(232,121,249,0.12)',
                            color: e.component_group === 'packing' ? '#4ade80' : '#e879f9',
                            border: `1px solid ${e.component_group === 'packing' ? 'rgba(74,222,128,0.25)' : 'rgba(232,121,249,0.25)'}`,
                          }}>
                            {e.component_group === 'packing' ? 'Packing' : 'Labeling'}
                          </span>
                        )}
                        <button onClick={() => handleDelete(e.id)} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.15)', borderRadius: 6, padding: '4px 6px', cursor: 'pointer', color: '#f87171' }}>
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* History panel */}
          {showHistory && (
            <div style={{ marginTop: 16, background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(251,191,36,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <History size={14} style={{ color: '#fbbf24' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.5 }}>Version History</span>
                </div>
                <button onClick={() => loadHistory()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.4)', fontSize: 11 }}>↻ Refresh</button>
              </div>
              {historyLoading ? (
                <div style={{ padding: 20, color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>Loading...</div>
              ) : historyData.length === 0 ? (
                <div style={{ padding: 20, color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No history yet. Changes will appear here after saving.</div>
              ) : historyData.map((ver, idx) => {
                const snap = typeof ver.snapshot === 'string' ? JSON.parse(ver.snapshot) : (ver.snapshot || [])
                const prevSnap = idx < historyData.length - 1
                  ? (typeof historyData[idx + 1].snapshot === 'string' ? JSON.parse(historyData[idx + 1].snapshot) : historyData[idx + 1].snapshot || [])
                  : []
                const diff = computeDiff(snap, prevSnap)
                const hasDiff = diff.added.length + diff.removed.length + diff.changed.length > 0
                const isLatest = idx === 0
                const isExpanded = historyExpanded[ver.version]
                const actionLabel = ver.action?.startsWith('rollback') ? `↩ Rollback to v${ver.action.replace('rollback_v','')}` : ver.action

                return (
                  <div key={ver.id} style={{ borderBottom: idx < historyData.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                    <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button onClick={() => setHistoryExpanded(p => ({ ...p, [ver.version]: !p[ver.version] }))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.4)', fontSize: 11, padding: 0 }}>
                        {isExpanded ? '▼' : '▶'}
                      </button>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', fontFamily: 'monospace', minWidth: 28 }}>v{ver.version}</span>
                      <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', background: 'rgba(255,255,255,0.05)', borderRadius: 4, padding: '1px 6px' }}>{actionLabel}</span>
                      {hasDiff && (
                        <span style={{ fontSize: 10, display: 'flex', gap: 4 }}>
                          {diff.added.length > 0 && <span style={{ color: '#4ade80' }}>+{diff.added.length}</span>}
                          {diff.removed.length > 0 && <span style={{ color: '#f87171' }}>-{diff.removed.length}</span>}
                          {diff.changed.length > 0 && <span style={{ color: '#fbbf24' }}>~{diff.changed.length}</span>}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginLeft: 'auto' }}>
                        {ver.changed_by_name || 'System'} · {new Date(ver.changed_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {!isLatest && (
                        <button onClick={() => handleRollback(ver.version)} disabled={rollingBack === ver.version} style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6, padding: '3px 10px', color: '#fbbf24', fontSize: 11, fontWeight: 700, cursor: rollingBack === ver.version ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4, opacity: rollingBack === ver.version ? 0.6 : 1 }}>
                          <RotateCcw size={11} /> {rollingBack === ver.version ? '...' : 'Restore'}
                        </button>
                      )}
                      {isLatest && <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 700 }}>CURRENT</span>}
                    </div>
                    {isExpanded && (
                      <div style={{ padding: '4px 16px 12px 48px' }}>
                        {/* Diff summary */}
                        {diff.added.map((c, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#4ade80', marginBottom: 3 }}>
                            + {c.component_name} — {c.quantity_formula === 'ethanol_pct' ? 'ethanol %' : `${c.quantity_per_unit} ${c.component_unit}`}
                          </div>
                        ))}
                        {diff.removed.map((c, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#f87171', marginBottom: 3 }}>
                            − {c.component_name} — {c.quantity_formula === 'ethanol_pct' ? 'ethanol %' : `${c.quantity_per_unit} ${c.component_unit}`}
                          </div>
                        ))}
                        {diff.changed.map((c, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#fbbf24', marginBottom: 3 }}>
                            ~ {c.current.component_name}:
                            {Number(c.current.quantity_per_unit) !== Number(c.previous.quantity_per_unit) && (
                              <span> qty {c.previous.quantity_per_unit} → {c.current.quantity_per_unit}</span>
                            )}
                            {c.current.component_group !== c.previous.component_group && (
                              <span> group {c.previous.component_group} → {c.current.component_group}</span>
                            )}
                            {c.current.quantity_formula !== c.previous.quantity_formula && (
                              <span> formula {c.previous.quantity_formula} → {c.current.quantity_formula}</span>
                            )}
                          </div>
                        ))}
                        {!hasDiff && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {snap.map((c, i) => (
                              <span key={i} style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '2px 7px' }}>{c.component_name}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Formula Calculator */}
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <Calculator size={14} style={{ color: '#fbbf24' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(232,234,242,0.45)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Formula Calculator</span>
            <InfoIcon text={'Enter the batch quantity and oil percentage to calculate total materials needed.\n\nFragrance = Volume × Qty × Oil%\nEthanol = Volume × Qty × (100 − Oil%)'} maxWidth={280} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            <div>
              <label style={lbl}>
                Quantity
                <InfoIcon text="Number of units to produce in this batch." position="right" />
              </label>
              <input type="number" min={1} value={calcQty} onChange={e => setCalcQty(parseInt(e.target.value) || 1)} style={inp} />
            </div>
            <div>
              <label style={lbl}>
                Oil %
                <InfoIcon text="Essential oil percentage in total volume. Default: 25%. Can be adjusted per batch." position="right" />
              </label>
              <input type="number" min={1} max={100} value={calcOilPct} onChange={e => setCalcOilPct(Math.min(100, Math.max(1, parseInt(e.target.value) || 25)))} style={inp} />
            </div>
          </div>

          {/* Fragrance row — only for types with known volume */}
          {selectedType?.volume != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ fontSize: 12, color: '#a78bfa' }}>Fragrance</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa' }}>
                {fragQty % 1 === 0 ? fragQty.toLocaleString() : fragQty.toFixed(1)} ml
              </span>
            </div>
          )}

          {calcEntries.map((e, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.7)' }}>{e.component_name}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: CAT_COLORS[e.component_category] || '#e8eaf2' }}>
                {e.calc_qty % 1 === 0 ? e.calc_qty.toLocaleString() : e.calc_qty.toFixed(1)} {e.component_unit}
              </span>
            </div>
          ))}

          {selectedType?.volume != null && !isCandle && !isPureOil && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.45)', marginBottom: 4 }}>TOTAL FORMULA</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#a78bfa' }}>{(calcQty * (selectedType?.volume || 0)).toLocaleString()} ml</div>
              <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>
                Oil: {fragQty.toFixed(1)}ml · Ethanol: {(calcQty * (selectedType?.volume || 0) * (100 - calcOilPct) / 100).toFixed(1)}ml
              </div>
            </div>
          )}
          {selectedType && selectedType.volume == null && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, fontSize: 12, color: '#fbbf24' }}>
              ⚠ No volume defined for this master. Edit the master to set volume and enable the formula calculator.
            </div>
          )}
        </div>
      </div>

      {/* New Product Modal */}
      {showNewProduct && (
        <div className="modal-overlay" onClick={() => setShowNewProduct(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>New Component</h2>
                <p>Will be auto-added to the "Add Component" field</p>
              </div>
              <button className="modal-close" onClick={() => setShowNewProduct(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="label">Name *</label>
                <input className="input" value={npForm.name} onChange={e => setNpForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Aluminium Cap 18mm" autoFocus />
              </div>
              <div className="form-group">
                <label className="label">Category *</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[
                    { value: 'COMPONENT', label: 'Component', color: '#60a5fa' },
                    { value: 'RAW_MATERIAL', label: 'Raw Material', color: '#fbbf24' },
                    { value: 'LABEL', label: 'Label', color: '#f472b6' },
                    { value: 'FRAGRANCE', label: 'Fragrance', color: '#a78bfa' },
                  ].map(c => (
                    <button key={c.value} type="button" onClick={() => setNpForm(f => ({ ...f, category: c.value, unit: npDefaultUnit(c.value), product_code: npSuggestCode(c.value) }))} style={{
                      background: npForm.category === c.value ? `${c.color}25` : 'rgba(255,255,255,0.05)',
                      border: npForm.category === c.value ? `1px solid ${c.color}` : '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      color: npForm.category === c.value ? c.color : 'rgba(232,234,242,0.55)'
                    }}>{c.label}</button>
                  ))}
                </div>
              </div>
              <div className="form-grid-2">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="label">Product Code *</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="input" value={npForm.product_code} onChange={e => setNpForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} style={{ fontFamily: 'monospace' }} placeholder="COMP_00001" />
                    <button type="button" onClick={() => setNpForm(f => ({ ...f, product_code: npSuggestCode(f.category) }))} className="btn btn-secondary" style={{ whiteSpace: 'nowrap', padding: '8px 12px', fontSize: 11 }}>Auto</button>
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="label">Unit</label>
                  <select className="input" value={npForm.unit} onChange={e => setNpForm(f => ({ ...f, unit: e.target.value }))}>
                    {['units', 'ml', 'kg', 'g'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowNewProduct(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleNewProduct} disabled={npSaving} style={{ background: '#10b981', borderColor: '#10b981' }}>{npSaving ? 'Creating...' : 'Create & Add'}</button>
            </div>
          </div>
        </div>
      )}

      {showNewType && (
        <div className="modal-overlay" onClick={() => setShowNewType(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>New Master Product</h2>
                <p>Create a new master (template) with its own BOM</p>
              </div>
              <button className="modal-close" onClick={() => setShowNewType(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="label">Segment *</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['MUSE', '#fbbf24'], ['STANDARD', '#60a5fa'], ['MAJOR', '#a78bfa']].map(([s, color]) => (
                    <button key={s} type="button" onClick={() => setNtForm(f => ({ ...f, segment: s, client_id: '' }))}
                      style={{
                        flex: 1,
                        background: ntForm.segment === s ? `${color}22` : 'rgba(255,255,255,0.04)',
                        border: ntForm.segment === s ? `1px solid ${color}` : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 7, padding: '7px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        color: ntForm.segment === s ? color : 'rgba(232,234,242,0.5)',
                      }}>{s}</button>
                  ))}
                </div>
              </div>

              {ntForm.segment === 'MAJOR' && (
                <div className="form-group">
                  <label className="label">Major Client *</label>
                  <select className="input" value={ntForm.client_id} onChange={e => setNtForm(f => ({ ...f, client_id: e.target.value }))}>
                    <option value="">— Select client —</option>
                    {majorClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {majorClients.length === 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24' }}>No Major Clients registered yet. Add one in Clients first.</div>
                  )}
                </div>
              )}

              <div className="form-group">
                <label className="label">Name *</label>
                <input className="input" value={ntForm.name} onChange={e => setNtForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Reed Diffuser 200ml MUSE" autoFocus />
              </div>

              <div className="form-group">
                <label className="label">Product Code *</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input" value={ntForm.product_code} onChange={e => setNtForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} style={{ fontFamily: 'monospace' }} placeholder="REED_DIFFUSER_200ML_MUSE" />
                  <button type="button" onClick={() => setNtForm(f => ({ ...f, product_code: npSuggestCode('FINISHED_GOOD') }))} className="btn btn-secondary" style={{ whiteSpace: 'nowrap', padding: '8px 12px', fontSize: 11 }}>Auto</button>
                </div>
              </div>

              <div className="form-group">
                <label className="label">Container Type</label>
                <select className="input" value={ntForm.container_type_id} onChange={e => {
                  const ct = containerTypes.find(c => c.id === parseInt(e.target.value))
                  setNtForm(f => ({ ...f, container_type_id: e.target.value, volume_unit: ct?.default_unit || f.volume_unit }))
                }}>
                  <option value="">— Select container type —</option>
                  {containerTypes.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.is_candle ? '(candle)' : c.is_pure_oil ? '(pure oil)' : ''}
                    </option>
                  ))}
                </select>
                {containerTypes.length === 0 && (
                  <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>No container types yet. Create them under INVENTORY → Container Types (coming soon).</div>
                )}
              </div>

              <div className="form-grid-2">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="label">Volume</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="input" type="number" min={0} step="any" value={ntForm.volume_ml} onChange={e => setNtForm(f => ({ ...f, volume_ml: e.target.value }))} placeholder="200" style={{ flex: 1 }} />
                    <select className="input" value={ntForm.volume_unit} onChange={e => setNtForm(f => ({ ...f, volume_unit: e.target.value }))} style={{ width: 70 }}>
                      <option value="ml">ml</option>
                      <option value="g">g</option>
                      <option value="oz">oz</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="label">Default Oil %</label>
                  <input className="input" type="number" min={0} max={100} value={ntForm.default_oil_pct} onChange={e => setNtForm(f => ({ ...f, default_oil_pct: e.target.value }))} placeholder="25" />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowNewType(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleNewProductType} disabled={ntSaving} style={{ background: '#e879f9', borderColor: '#e879f9' }}>{ntSaving ? 'Creating...' : 'Create Master'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const lbl = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }
const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
const sel = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '7px 10px', color: '#e8eaf2', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
