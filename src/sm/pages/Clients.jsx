import { useState, useEffect, useRef } from 'react'
import { Plus, Edit2, Trash2, X, ChevronDown, ChevronRight, Tag, Package, ClipboardList, ImageIcon, Layers } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import { useToast } from '../SMModule.jsx'
import SearchSelect from '../components/SearchSelect.jsx'
import MlHint from '../components/MlHint.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const EMPTY_FORM = { name: '', email: '', phone: '', address: '', is_large_client: false, notes: '' }
const EMPTY_LABEL_FORM = { label_name: '', artwork_version: 'v1', supplier: '', quantity: '', notes: '', applicable_product_type: '', image_data: '' }

function resizeImageFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        const MAX = 800
        let w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX }
          else { w = Math.round(w * MAX / h); h = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.72))
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}
const EMPTY_STOCK_FORM = { product_code: '', product_name: '', category: 'COMPONENT', unit: 'units', quantity: '', barcode: '', notes: '' }

export default function Clients() {
  const [clients, setClients] = useState([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('ALL') // ALL | STANDARD | LARGE_CLIENT
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [labels, setLabels] = useState({})
  const [clientStock, setClientStock] = useState({})
  const [clientOrders, setClientOrders] = useState({})
  const [showLabelModal, setShowLabelModal] = useState(null)
  const [labelForm, setLabelForm] = useState(EMPTY_LABEL_FORM)
  const [labelSaving, setLabelSaving] = useState(false)
  const [stockModal, setStockModal] = useState(null) // client_id
  const [stockForm, setStockForm] = useState(EMPTY_STOCK_FORM)
  const [stockSaving, setStockSaving] = useState(false)
  const [clientProducts, setClientProducts] = useState({}) // { [clientId]: products[] }
  const [bomModal, setBomModal] = useState(null) // { product, clientId }
  const [bomEntries, setBomEntries] = useState([])
  const [bomLoading, setBomLoading] = useState(false)
  const [bomAddMode, setBomAddMode] = useState(null) // 'client_stock' | 'general'
  const [bomAddForm, setBomAddForm] = useState({ client_stock_id: '', general_product_id: '', quantity_per_unit: 1, unit: 'units', notes: '' })
  const [bomAddSaving, setBomAddSaving] = useState(false)
  const [generalProducts, setGeneralProducts] = useState([])
  const [newProductModal, setNewProductModal] = useState(null) // client_id
  const [newProductForm, setNewProductForm] = useState({ name: '', product_code: '', category: 'FINISHED_GOOD', unit: 'units', current_stock: 0, min_stock_level: 0, notes: '', image_data: '' })
  const [newProductSaving, setNewProductSaving] = useState(false)
  const [npCodeLoading, setNpCodeLoading] = useState(false)
  const newProductImageRef = useRef(null)
  const [deleteTarget, setDeleteTarget] = useState(null) // { type: 'label'|'stock'|'product', id, clientId, label }
  const [adjustStockModal, setAdjustStockModal] = useState(null) // { item, clientId }
  const [adjustForm, setAdjustForm] = useState({ new_qty: '', notes: '' })
  const [adjustSaving, setAdjustSaving] = useState(false)
  const [editStockModal, setEditStockModal] = useState(null) // { item, clientId }
  const [editStockForm, setEditStockForm] = useState({ product_code: '', product_name: '', category: 'COMPONENT', unit: 'units', barcode: '', notes: '' })
  const [editStockSaving, setEditStockSaving] = useState(false)
  const [allProducts, setAllProducts] = useState([])
  const [productTypes, setProductTypes] = useState([])  // dynamic masters for label form
  const { addToast } = useToast()

  useEffect(() => { loadClients() }, [filter, search])
  useEffect(() => {
    axios.get('/api/product-types', api()).then(r => setProductTypes(r.data)).catch(() => {})
  }, [])

  async function loadClients() {
    setLoading(true)
    try {
      const params = {}
      if (search) params.search = search
      if (filter === 'LARGE_CLIENT') params.is_large_client = 'true'
      if (filter === 'STANDARD') params.is_large_client = 'false'
      const res = await axios.get('/api/clients', { ...api(), params })
      setClients(res.data)
    } catch { addToast('Failed to load clients', 'error') }
    finally { setLoading(false) }
  }

  async function loadClientDetail(clientId, isLarge) {
    try {
      const reqs = [
        axios.get(`/api/clients/${clientId}/labels`, api()),
        axios.get(`/api/clients/${clientId}/stock`, api()),
        axios.get(`/api/clients/${clientId}/orders`, api()),
      ]
      if (isLarge) reqs.push(axios.get(`/api/clients/${clientId}/products`, api()))
      const [lblRes, stkRes, ordRes, prdRes] = await Promise.all(reqs)
      setLabels(prev => ({ ...prev, [clientId]: lblRes.data }))
      setClientStock(prev => ({ ...prev, [clientId]: stkRes.data }))
      setClientOrders(prev => ({ ...prev, [clientId]: ordRes.data }))
      if (prdRes) setClientProducts(prev => ({ ...prev, [clientId]: prdRes.data }))
    } catch {}
  }

  function resizeProductImage(file) {
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = e => {
        const img = new Image()
        img.onload = () => {
          const MAX = 900
          let w = img.width, h = img.height
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX }
            else { w = Math.round(w * MAX / h); h = MAX }
          }
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.7))
        }
        img.src = e.target.result
      }
      reader.readAsDataURL(file)
    })
  }

  async function handleNewProductImage(file) {
    if (!file || !file.type.startsWith('image/')) return
    const b64 = await resizeProductImage(file)
    setNewProductForm(f => ({ ...f, image_data: b64 }))
  }

  async function openBomModal(product, clientId) {
    setBomModal({ product, clientId })
    setBomAddMode(null)
    setBomAddForm({ client_stock_id: '', general_product_id: '', quantity_per_unit: 1, unit: 'units', notes: '' })
    setBomLoading(true)
    try {
      const [bomRes, gpRes] = await Promise.all([
        axios.get(`/api/client-products/${product.id}/bom`, api()),
        axios.get('/api/products', { ...api(), params: { category: 'ALL' } }),
      ])
      setBomEntries(bomRes.data)
      setGeneralProducts(gpRes.data.filter(p => !p.client_id)) // only non-client-exclusive general products
    } catch { addToast('Failed to load BOM', 'error') }
    finally { setBomLoading(false) }
  }

  async function handleBomAddEntry() {
    if (!bomModal) return
    const { client_stock_id, general_product_id, quantity_per_unit, unit, notes } = bomAddForm
    if (!client_stock_id && !general_product_id) { addToast('Select a component', 'error'); return }
    const isDup = bomEntries.some(e =>
      (client_stock_id && e.client_stock_id === parseInt(client_stock_id)) ||
      (general_product_id && e.general_product_id === parseInt(general_product_id))
    )
    if (isDup) { addToast('This component is already in the BOM', 'error'); return }
    setBomAddSaving(true)
    try {
      await axios.post(`/api/client-products/${bomModal.product.id}/bom`, {
        client_stock_id: client_stock_id ? parseInt(client_stock_id) : null,
        general_product_id: general_product_id ? parseInt(general_product_id) : null,
        quantity_per_unit: parseFloat(quantity_per_unit) || 1,
        unit: unit || 'units',
        notes: notes || null,
      }, api())
      const res = await axios.get(`/api/client-products/${bomModal.product.id}/bom`, api())
      setBomEntries(res.data)
      setBomAddMode(null)
      setBomAddForm({ client_stock_id: '', general_product_id: '', quantity_per_unit: 1, unit: 'units', notes: '' })
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setBomAddSaving(false) }
  }

  async function handleBomRemoveEntry(entryId) {
    if (!bomModal) return
    try {
      await axios.delete(`/api/client-products/${bomModal.product.id}/bom/${entryId}`, api())
      setBomEntries(prev => prev.filter(e => e.id !== entryId))
    } catch { addToast('Failed to remove entry', 'error') }
  }

  async function suggestClientCode(category) {
    const prefix = category === 'FINISHED_GOOD' ? 'FG_LC_' : 'LC_'
    setNpCodeLoading(true)
    try {
      const res = await axios.get('/api/products', { ...api(), params: { search: prefix } })
      const nums = res.data
        .filter(p => p.product_code?.startsWith(prefix))
        .map(p => parseInt(p.product_code.replace(prefix, '')) || 0)
        .sort((a, b) => b - a)
      setNewProductForm(f => ({ ...f, product_code: prefix + String((nums[0] || 0) + 1).padStart(5, '0') }))
    } catch {}
    finally { setNpCodeLoading(false) }
  }

  async function handleSaveNewProduct() {
    if (!newProductForm.name.trim() || !newProductForm.product_code.trim()) {
      addToast('Name and product code are required', 'error'); return
    }
    const cid = newProductModal
    setNewProductSaving(true)
    try {
      await axios.post('/api/products', {
        ...newProductForm,
        client_id: cid,
        current_stock: parseFloat(newProductForm.current_stock) || 0,
        min_stock_level: parseFloat(newProductForm.min_stock_level) || 0,
      }, api())
      addToast('Product created')
      setNewProductModal(null)
      setNewProductForm({ name: '', product_code: '', category: 'FINISHED_GOOD', unit: 'units', current_stock: 0, min_stock_level: 0, notes: '', image_data: '' })
      const res = await axios.get(`/api/clients/${cid}/products`, api())
      setClientProducts(prev => ({ ...prev, [cid]: res.data }))
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setNewProductSaving(false) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      if (deleteTarget.type === 'label') {
        await axios.delete(`/api/clients/${deleteTarget.clientId}/labels/${deleteTarget.id}`, api())
        setLabels(prev => ({ ...prev, [deleteTarget.clientId]: (prev[deleteTarget.clientId] || []).filter(l => l.id !== deleteTarget.id) }))
        addToast('Label deleted')
      } else if (deleteTarget.type === 'stock') {
        await axios.delete(`/api/client-stock/${deleteTarget.id}`, api())
        setClientStock(prev => ({ ...prev, [deleteTarget.clientId]: (prev[deleteTarget.clientId] || []).filter(s => s.id !== deleteTarget.id) }))
        addToast('Stock item deleted')
      } else if (deleteTarget.type === 'product') {
        await axios.delete(`/api/products/${deleteTarget.id}`, api())
        setClientProducts(prev => ({ ...prev, [deleteTarget.clientId]: (prev[deleteTarget.clientId] || []).filter(p => p.id !== deleteTarget.id) }))
        addToast('Product deleted')
      } else if (deleteTarget.type === 'client') {
        await axios.delete(`/api/clients/${deleteTarget.id}`, api())
        setClients(prev => prev.filter(c => c.id !== deleteTarget.id))
        setExpanded(null)
        addToast('Customer deleted')
      }
    } catch (e) { addToast(e.response?.data?.error || 'Delete failed', 'error') }
    setDeleteTarget(null)
  }

  async function handleAdjustStock() {
    if (!adjustStockModal) return
    const { item, clientId } = adjustStockModal
    const new_qty = parseFloat(adjustForm.new_qty)
    if (isNaN(new_qty) || new_qty < 0) { addToast('Enter a valid quantity', 'error'); return }
    setAdjustSaving(true)
    try {
      const res = await axios.post(`/api/client-stock/${item.id}/adjust`, { new_stock: new_qty, notes: adjustForm.notes || null }, api())
      setClientStock(prev => ({ ...prev, [clientId]: (prev[clientId] || []).map(s => s.id === item.id ? { ...s, quantity: res.data.quantity } : s) }))
      addToast('Stock adjusted')
      setAdjustStockModal(null)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setAdjustSaving(false) }
  }

  function toggleExpand(client) {
    if (expanded === client.id) { setExpanded(null); return }
    setExpanded(client.id)
    loadClientDetail(client.id, client.is_large_client)
  }

  function openCreate() {
    setEditing(null); setForm(EMPTY_FORM); setShowModal(true)
  }

  function openEdit(client) {
    setEditing(client)
    setForm({ name: client.name, email: client.email || '', phone: client.phone || '', address: client.address || '', is_large_client: client.is_large_client, notes: client.notes || '' })
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { addToast('Name is required', 'error'); return }
    setSaving(true)
    try {
      if (editing) {
        await axios.put(`/api/clients/${editing.id}`, form, api())
        addToast('Client updated')
      } else {
        await axios.post('/api/clients', form, api())
        addToast('Client created')
      }
      setShowModal(false); loadClients()
    } catch (e) { addToast(e.response?.data?.error || 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleSaveLabel() {
    if (!labelForm.label_name.trim()) { addToast('Label name required', 'error'); return }
    setLabelSaving(true)
    try {
      await axios.post(`/api/clients/${showLabelModal}/labels`, {
        ...labelForm, quantity: parseFloat(labelForm.quantity) || 0
      }, api())
      addToast('Label created')
      setShowLabelModal(null)
      setLabelForm(EMPTY_LABEL_FORM)
      loadClientDetail(showLabelModal)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setLabelSaving(false) }
  }

  async function toggleObsolete(clientId, label) {
    try {
      await axios.put(`/api/clients/${clientId}/labels/${label.id}/obsolete`, { is_obsolete: !label.is_obsolete }, api())
      addToast(label.is_obsolete ? 'Label restored' : 'Label marked obsolete')
      loadClientDetail(clientId)
    } catch { addToast('Failed', 'error') }
  }

  async function openStockModal(clientId) {
    setStockModal(clientId)
    setStockForm(EMPTY_STOCK_FORM)
    try {
      const res = await axios.get('/api/client-stock/next-lc-code', api())
      setStockForm(f => ({ ...f, product_code: res.data.code }))
    } catch {}
  }

  async function handleEditStock() {
    if (!editStockModal) return
    const { item, clientId } = editStockModal
    if (!editStockForm.product_code.trim() || !editStockForm.product_name.trim()) {
      addToast('Product code and name are required', 'error'); return
    }
    setEditStockSaving(true)
    try {
      const res = await axios.put(`/api/client-stock/${item.id}`, editStockForm, api())
      setClientStock(prev => ({ ...prev, [clientId]: (prev[clientId] || []).map(s => s.id === item.id ? res.data : s) }))
      addToast('Stock item updated')
      setEditStockModal(null)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setEditStockSaving(false) }
  }

  async function handleReceiveStock() {
    if (!stockModal) return
    if (!stockForm.product_code || !stockForm.product_name || !stockForm.quantity) {
      addToast('Product code, name and quantity are required', 'error'); return
    }
    setStockSaving(true)
    try {
      await axios.post(`/api/clients/${stockModal}/stock/receive`, {
        product_code: stockForm.product_code.trim(),
        product_name: stockForm.product_name.trim(),
        category: stockForm.category || 'COMPONENT',
        unit: stockForm.unit || 'units',
        quantity: parseFloat(stockForm.quantity),
        barcode: stockForm.barcode || null,
        notes: stockForm.notes || null,
      }, api())
      addToast('Stock received')
      setStockModal(null)
      loadClientDetail(stockModal)
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setStockSaving(false) }
  }

  const displayed = clients.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.email || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Customers</h1>
        <Button onClick={openCreate}>
          <Plus size={15} /> New Customer
        </Button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[['ALL','All'], ['STANDARD','Standard'], ['LARGE_CLIENT','Major Client']].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            background: filter === k ? '#2563eb' : 'rgba(255,255,255,0.05)',
            color: filter === k ? 'white' : 'rgba(232,234,242,0.6)',
            border: filter === k ? 'none' : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 20, padding: '5px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer'
          }}>{l}</button>
        ))}
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customers..."
          style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none', width: 240 }}
        />
      </div>

      {/* Client list */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {displayed.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No customers found</div>
          )}
          {displayed.map(client => (
            <div key={client.id} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
              {/* Client row */}
              <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <button onClick={() => toggleExpand(client)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.5)', padding: 0, display: 'flex' }}>
                  {expanded === client.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf2' }}>{client.name}</span>
                    {client.is_large_client && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#a78bfa', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#a78bfa', flexShrink: 0 }} />
                        Major Client
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)', marginTop: 2 }}>
                    {[client.email, client.phone].filter(Boolean).join(' · ') || 'No contact info'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <IconButton onClick={() => openEdit(client)} title="Edit customer"><Edit2 size={13} /></IconButton>
                  <IconButton variant="danger" onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'client', id: client.id, label: client.name }) }} title="Delete customer"><Trash2 size={13} /></IconButton>
                </div>
              </div>

              {/* Expanded details */}
              {expanded === client.id && (() => {
                const clientLabels = labels[client.id] || []
                const stock = clientStock[client.id] || []
                const orders = clientOrders[client.id] || []
                const products = clientProducts[client.id] || []
                const STATUS_COLOR = { draft: 'rgba(232,234,242,0.4)', confirmed: '#60a5fa', queued: '#fbbf24', in_production: '#f472b6', waiting_external: '#a78bfa', completed: '#4ade80', ready_to_ship: '#34d399', fulfilled: 'rgba(232,234,242,0.3)', cancelled: '#f87171' }

                const SectionHeader = ({ icon, label, color, count, action }) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ color, display: 'flex', alignItems: 'center' }}>{icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
                    {count !== undefined && <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', fontWeight: 600 }}>({count})</span>}
                    <div style={{ flex: 1, height: 1, background: `${color}20` }} />
                    {action}
                  </div>
                )

                return (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: '20px 20px', background: 'rgba(0,0,0,0.15)' }}>
                    {/* Notes banner */}
                    {client.notes && (
                      <div style={{ marginBottom: 16, padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, fontSize: 12, color: 'rgba(232,234,242,0.5)', fontStyle: 'italic' }}>
                        {client.notes}
                      </div>
                    )}

                    {/* Top row: Labels + Reserved Stock (side-by-side for large clients, labels only for standard) */}
                    <div style={{ display: 'grid', gridTemplateColumns: client.is_large_client ? '1fr 1fr' : '1fr', gap: 20, marginBottom: 20 }}>
                      {/* Labels */}
                      <div style={{ background: 'rgba(232,121,249,0.03)', border: '1px solid rgba(232,121,249,0.1)', borderRadius: 10, padding: '14px 16px' }}>
                        <SectionHeader
                          icon={<Tag size={13} />} label="Labels" color="#e879f9" count={clientLabels.length}
                          action={<button onClick={() => { setShowLabelModal(client.id); setLabelForm(EMPTY_LABEL_FORM) }} style={{ background: 'rgba(232,121,249,0.1)', border: '1px solid rgba(232,121,249,0.25)', borderRadius: 6, padding: '3px 10px', fontSize: 10, color: '#e879f9', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}>+ Add Label</button>}
                        />
                        {clientLabels.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.25)', padding: '6px 0', textAlign: 'center' }}>No labels yet</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {clientLabels.map(lbl => (
                              <div key={lbl.id} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: lbl.is_obsolete ? '1px solid rgba(220,38,38,0.15)' : '1px solid rgba(232,121,249,0.12)', opacity: lbl.is_obsolete ? 0.6 : 1 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                                  {lbl.image_data
                                    ? <img src={lbl.image_data} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', border: '1px solid rgba(232,121,249,0.25)', flexShrink: 0 }} />
                                    : <div style={{ width: 36, height: 36, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><ImageIcon size={13} color="rgba(232,234,242,0.2)" /></div>}
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf2', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      {lbl.label_name}
                                      <span style={{ fontSize: 10, color: '#e879f9', fontWeight: 700 }}>{lbl.artwork_version}</span>
                                      {lbl.applicable_product_type && <span style={{ fontSize: 9, background: 'rgba(232,121,249,0.1)', padding: '1px 5px', borderRadius: 8, color: '#e879f9' }}>{lbl.applicable_product_type.replace(/_/g,' ')}</span>}
                                      {lbl.is_obsolete && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 700 }}>OBSOLETE</span>}
                                    </div>
                                    <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>
                                      <strong style={{ color: lbl.quantity > 0 ? '#4ade80' : '#f87171' }}>{Number(lbl.quantity).toLocaleString()} units</strong>
                                      {lbl.supplier && ` · ${lbl.supplier}`}
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                                    <button onClick={() => toggleObsolete(client.id, lbl)} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, padding: '2px 7px', cursor: 'pointer', color: 'rgba(232,234,242,0.45)', fontSize: 10 }}>
                                      {lbl.is_obsolete ? 'Restore' : 'Obsolete'}
                                    </button>
                                    <button onClick={() => setDeleteTarget({ type: 'label', id: lbl.id, clientId: client.id, label: lbl.label_name })} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 5, padding: '2px 7px', cursor: 'pointer', color: '#f87171', fontSize: 12, lineHeight: 1 }}>×</button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Reserved Stock (Large Client only — view only, managed in Stock page) */}
                      {client.is_large_client && (
                        <div style={{ background: 'rgba(107,120,77,0.07)', border: '1px solid rgba(107,120,77,0.2)', borderRadius: 10, padding: '14px 16px' }}>
                          <SectionHeader
                            icon={<Package size={13} />} label="Reserved Stock" color="#6b784d" count={stock.length}
                            action={<a href="/sm-stock" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px', fontSize: 10, color: '#6b784d', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap', textDecoration: 'none' }}>Manage in Stock</a>}
                          />
                          {stock.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.25)', padding: '6px 0', textAlign: 'center' }}>No reserved stock</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {stock.map(s => (
                                <div key={s.id} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(167,139,250,0.12)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.product_name}</div>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                                      <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#a78bfa', fontWeight: 700 }}>{s.product_code}</span>
                                      <strong style={{ fontSize: 11, color: s.quantity > 0 ? '#4ade80' : '#f87171' }}>{Number(s.quantity).toLocaleString()} {s.unit}</strong>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Major Client product management moved to dedicated detail page */}
                    {client.is_large_client && (
                      <div style={{ background: 'rgba(97,36,40,0.06)', border: '1px solid rgba(97,36,40,0.2)', borderRadius: 10, padding: '14px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Layers size={14} color="var(--accent-text)" />
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-text)' }}>Major Client Catalog</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Masters, BOM, client stock & labels are managed in the dedicated Major Clients page.</div>
                          </div>
                        </div>
                        <a href={`/major-clients/${client.id}`} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--accent-text)', padding: '6px 12px', borderRadius: 7, fontSize: 11, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>Open Detail Page</a>
                      </div>
                    )}

                    {/* Order History */}
                    <div style={{ background: 'rgba(138,94,82,0.07)', border: '1px solid rgba(138,94,82,0.2)', borderRadius: 10, padding: '14px 16px' }}>
                      <SectionHeader icon={<ClipboardList size={13} />} label="Order History" color="#8a5e52" count={orders.length} />
                      {orders.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.25)', padding: '6px 0', textAlign: 'center' }}>No orders yet</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {orders.map(o => (
                            <div key={o.id} style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa', minWidth: 76, fontFamily: 'monospace' }}>{o.order_number}</span>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: STATUS_COLOR[o.status] || 'var(--text-secondary)', whiteSpace: 'nowrap' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLOR[o.status] || 'var(--text-muted)', flexShrink: 0 }} />{o.status.replace(/_/g, ' ')}</span>
                              <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{Number(o.total_qty).toLocaleString()} units</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Client Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing ? 'Edit Customer' : 'New Customer'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <F label="Name *" full><Input value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Client name" /></F>
              <F label="Email"><Input value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="email@..." /></F>
              <F label="Phone"><Input value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} placeholder="+61..." /></F>
              <F label="Address" full><Input value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} placeholder="Address" /></F>
              <F label="Notes" full>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...iStyle, resize: 'vertical', width: '100%' }} />
              </F>
              <F label="Client Type" full>
                <div style={{ display: 'flex', gap: 10 }}>
                  {[false, true].map(v => (
                    <button key={String(v)} onClick={() => setForm(f => ({ ...f, is_large_client: v }))} style={{
                      background: form.is_large_client === v ? (v ? 'rgba(167,139,250,0.2)' : 'rgba(37,99,235,0.2)') : 'rgba(255,255,255,0.05)',
                      border: form.is_large_client === v ? `1px solid ${v ? '#a78bfa' : '#2563eb'}` : '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                      color: form.is_large_client === v ? (v ? '#a78bfa' : '#60a5fa') : 'rgba(232,234,242,0.5)'
                    }}>{v ? 'Major Client' : 'Standard'}</button>
                  ))}
                </div>
              </F>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Customer'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Receive Client Stock Modal */}
      {stockModal && (
        <div className="modal-overlay" onClick={() => setStockModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Receive Reserved Stock</h2>
                <p style={{ color: '#a78bfa' }}>Components arriving from China — branded for this client</p>
              </div>
              <button className="modal-close" onClick={() => setStockModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <F label="Product Code *"><Input value={stockForm.product_code} onChange={v => setStockForm(f => ({ ...f, product_code: v }))} placeholder="e.g. CR-GLASS-50ML" /></F>
              <F label="Product Name *" full><Input value={stockForm.product_name} onChange={v => setStockForm(f => ({ ...f, product_name: v }))} placeholder="e.g. Coco Republic Glass Bottle 50ml" /></F>
              <F label="Category">
                <SearchSelect
                  value={stockForm.category}
                  onChange={v => setStockForm(f => ({ ...f, category: v }))}
                  options={[
                    { value: 'COMPONENT', label: 'Component (glass, lids, packaging)' },
                    { value: 'LABEL', label: 'Label' },
                    { value: 'RAW_MATERIAL', label: 'Raw Material' },
                  ]}
                  clearable={false}
                />
              </F>
              <F label="Unit">
                <SearchSelect
                  value={stockForm.unit}
                  onChange={v => setStockForm(f => ({ ...f, unit: v }))}
                  options={[
                    { value: 'units', label: 'units' },
                    { value: 'ml', label: 'ml' },
                    { value: 'g', label: 'g' },
                  ]}
                  clearable={false}
                />
              </F>
              <F label="Quantity Received *">
                <Input type="number" value={stockForm.quantity} onChange={v => setStockForm(f => ({ ...f, quantity: v }))} placeholder="0" />
                <MlHint value={stockForm.quantity} unit={stockForm.unit} />
              </F>
              <F label="Barcode (optional)"><Input value={stockForm.barcode} onChange={v => setStockForm(f => ({ ...f, barcode: v }))} placeholder="Scan or type..." /></F>
              <F label="Notes" full>
                <textarea value={stockForm.notes} onChange={e => setStockForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Shipment ref, order date..." style={{ ...iStyle, resize: 'none', width: '100%' }} />
              </F>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setStockModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReceiveStock} disabled={stockSaving}>{stockSaving ? 'Saving...' : 'Receive Stock'}</button>
            </div>
          </div>
        </div>
      )}

      {/* BOM Editor Modal */}
      {bomModal && (() => {
        const { product, clientId } = bomModal
        const stockItems = clientStock[clientId] || []
        const clientEntries = bomEntries.filter(e => e.client_stock_id)
        const generalEntries = bomEntries.filter(e => e.general_product_id)
        return (
          <div className="modal-overlay" onClick={() => setBomModal(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  {product.image_data ? (
                    <img src={product.image_data} alt="" style={{ width: 60, height: 60, borderRadius: 8, objectFit: 'cover', flexShrink: 0, border: '1px solid rgba(255,255,255,0.12)' }} />
                  ) : (
                    <div style={{ width: 60, height: 60, borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <ImageIcon size={22} color="rgba(232,234,242,0.2)" />
                    </div>
                  )}
                  <div>
                    <h2>{product.name}</h2>
                    <p style={{ fontFamily: 'monospace' }}>{product.product_code}</p>
                    <p style={{ color: product.current_stock > 0 ? '#4ade80' : '#f87171', marginTop: 2 }}>{Number(product.current_stock).toLocaleString()} {product.unit} in stock</p>
                  </div>
                </div>
                <button className="modal-close" onClick={() => setBomModal(null)}><X size={14} /></button>
              </div>
              <div className="modal-body">

              {/* BOM section label */}
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Layers size={12} /> Bill of Materials
                <span style={{ color: 'rgba(232,234,242,0.3)', fontWeight: 400, fontSize: 10 }}>— components per 1 {product.unit}</span>
              </div>

              {bomLoading ? (
                <div style={{ color: 'rgba(232,234,242,0.35)', fontSize: 13, padding: '16px 0' }}>Loading...</div>
              ) : (
                <>
                  {/* Client Reserved Stock entries */}
                  {clientEntries.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Client Reserved Stock</div>
                      {clientEntries.map(e => (
                        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 5 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf2' }}>{e.cs_name}</div>
                            <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', fontFamily: 'monospace' }}>{e.cs_code}</div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa', whiteSpace: 'nowrap' }}>{e.quantity_per_unit} {e.unit || e.cs_unit}</div>
                          <div style={{ fontSize: 10, color: e.cs_stock > 0 ? 'rgba(232,234,242,0.35)' : '#f87171' }}>{Number(e.cs_stock).toLocaleString()} avail</div>
                          <button onClick={() => handleBomRemoveEntry(e.id)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* General Stock entries */}
                  {generalEntries.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>General Stock</div>
                      {generalEntries.map(e => (
                        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 5 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf2' }}>{e.gp_name}</div>
                            <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', fontFamily: 'monospace' }}>{e.gp_code} · {(e.gp_category || '').replace(/_/g, ' ')}</div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', whiteSpace: 'nowrap' }}>{e.quantity_per_unit} {e.unit || e.gp_unit}</div>
                          <div style={{ fontSize: 10, color: e.gp_stock > 0 ? 'rgba(232,234,242,0.35)' : '#f87171' }}>{Number(e.gp_stock).toLocaleString()} avail</div>
                          <button onClick={() => handleBomRemoveEntry(e.id)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {bomEntries.length === 0 && (
                    <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)', padding: '12px 0 16px', textAlign: 'center' }}>No BOM entries yet — add components below</div>
                  )}

                  {/* Add component buttons */}
                  {!bomAddMode && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button onClick={() => { setBomAddMode('client_stock'); setBomAddForm({ client_stock_id: '', general_product_id: '', quantity_per_unit: 1, unit: 'units', notes: '' }) }} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 14px', fontSize: 11, fontWeight: 700, color: '#a78bfa', cursor: 'pointer' }}>
                        + From Client Stock
                      </button>
                      <button onClick={() => { setBomAddMode('general'); setBomAddForm({ client_stock_id: '', general_product_id: '', quantity_per_unit: 1, unit: 'units', notes: '' }) }} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 14px', fontSize: 11, fontWeight: 700, color: '#60a5fa', cursor: 'pointer' }}>
                        + From General Stock
                      </button>
                    </div>
                  )}

                  {/* Add form — Client Stock */}
                  {bomAddMode === 'client_stock' && (
                    <div style={{ marginTop: 10, padding: '14px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Add from Client Reserved Stock</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                        <div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Component</div>
                          <SearchSelect
                            value={bomAddForm.client_stock_id}
                            onChange={v => { const s = stockItems.find(x => String(x.id) === String(v)); setBomAddForm(f => ({ ...f, client_stock_id: v, unit: s?.unit || 'units' })) }}
                            options={stockItems.map(s => ({ value: s.id, label: s.product_name, sub: `${Number(s.quantity).toLocaleString()} ${s.unit} available` }))}
                            placeholder="Select component..."
                          />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Qty / unit</div>
                          <input type="number" min={0} step="any" value={bomAddForm.quantity_per_unit} onChange={e => setBomAddForm(f => ({ ...f, quantity_per_unit: e.target.value }))} style={iStyle} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Unit</div>
                          <Input value={bomAddForm.unit} onChange={v => setBomAddForm(f => ({ ...f, unit: v }))} placeholder="units" />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button onClick={() => setBomAddMode(null)} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 7, padding: '5px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', cursor: 'pointer' }}>Cancel</button>
                        <button onClick={handleBomAddEntry} disabled={bomAddSaving || !bomAddForm.client_stock_id} style={{ background: '#a78bfa', border: 'none', borderRadius: 7, padding: '5px 14px', fontSize: 11, fontWeight: 700, color: '#0e0e1a', cursor: 'pointer', opacity: bomAddSaving || !bomAddForm.client_stock_id ? 0.5 : 1 }}>
                          {bomAddSaving ? 'Adding...' : 'Add Entry'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Add form — General Stock */}
                  {bomAddMode === 'general' && (
                    <div style={{ marginTop: 10, padding: '14px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Add from General Stock</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                        <div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Product</div>
                          <SearchSelect
                            value={bomAddForm.general_product_id}
                            onChange={v => { const p = generalProducts.find(x => String(x.id) === String(v)); setBomAddForm(f => ({ ...f, general_product_id: v, unit: p?.unit || 'units' })) }}
                            options={generalProducts.map(p => ({ value: p.id, label: p.name, sub: (p.category || '').replace(/_/g, ' ') }))}
                            placeholder="Select product..."
                          />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Qty / unit</div>
                          <input type="number" min={0} step="any" value={bomAddForm.quantity_per_unit} onChange={e => setBomAddForm(f => ({ ...f, quantity_per_unit: e.target.value }))} style={iStyle} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Unit</div>
                          <Input value={bomAddForm.unit} onChange={v => setBomAddForm(f => ({ ...f, unit: v }))} placeholder="units" />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button onClick={() => setBomAddMode(null)} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 7, padding: '5px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', cursor: 'pointer' }}>Cancel</button>
                        <button onClick={handleBomAddEntry} disabled={bomAddSaving || !bomAddForm.general_product_id} style={{ background: '#60a5fa', border: 'none', borderRadius: 7, padding: '5px 14px', fontSize: 11, fontWeight: 700, color: '#0e0e1a', cursor: 'pointer', opacity: bomAddSaving || !bomAddForm.general_product_id ? 0.5 : 1 }}>
                          {bomAddSaving ? 'Adding...' : 'Add Entry'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setBomModal(null)}>Close</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* New Client Product Modal */}
      {newProductModal && (
        <div className="modal-overlay" onClick={() => setNewProductModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>New Client Product</h2>
                <p>{newProductForm.category === 'FINISHED_GOOD' ? 'Finished product — code FG_LC_XXXXX' : 'Customer stock — code LC_XXXXX'}</p>
              </div>
              <button className="modal-close" onClick={() => setNewProductModal(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="label">Product Name *</label>
                <Input value={newProductForm.name} onChange={v => setNewProductForm(f => ({ ...f, name: v }))} placeholder="e.g. Coco Republic Room Spray 100ml" />
              </div>
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="label">Category</label>
                  <SearchSelect
                    value={newProductForm.category}
                    onChange={v => setNewProductForm(f => ({ ...f, category: v, product_code: '' }))}
                    options={[
                      { value: 'FINISHED_GOOD', label: 'Finished Good (FG_LC_)' },
                      { value: 'COMPONENT', label: 'Component (LC_)' },
                      { value: 'LABEL', label: 'Label (LC_)' },
                    ]}
                    clearable={false}
                  />
                </div>
                <div className="form-group">
                  <label className="label">Unit</label>
                  <SearchSelect
                    value={newProductForm.unit}
                    onChange={v => setNewProductForm(f => ({ ...f, unit: v }))}
                    options={[{ value: 'units', label: 'units' }, { value: 'ml', label: 'ml' }]}
                    clearable={false}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Product Code *</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="input"
                    value={newProductForm.product_code}
                    onChange={e => setNewProductForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))}
                    placeholder={newProductForm.category === 'FINISHED_GOOD' ? 'FG_LC_00001' : 'LC_00001'}
                    style={{ fontFamily: 'monospace' }}
                  />
                  <button type="button" onClick={() => suggestClientCode(newProductForm.category)} disabled={npCodeLoading}
                    className="btn btn-secondary" style={{ whiteSpace: 'nowrap', padding: '8px 12px', fontSize: 12 }}>
                    {npCodeLoading ? '...' : 'Auto'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
                  {newProductForm.category === 'FINISHED_GOOD'
                    ? 'Finished product — code FG_LC_XXXXX'
                    : 'Customer stock — code LC_XXXXX'}
                </div>
              </div>
              <div className="form-group">
                <label className="label">Notes</label>
                <textarea value={newProductForm.notes} onChange={e => setNewProductForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Descrição do produto..." className="input" style={{ resize: 'none' }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Product Photo</label>
                <input ref={newProductImageRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleNewProductImage(e.target.files[0])} />
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {newProductForm.image_data ? (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={newProductForm.image_data} alt="Product" style={{ width: 68, height: 68, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                      <button onClick={() => setNewProductForm(f => ({ ...f, image_data: '' }))} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#dc2626', border: 'none', color: 'white', fontSize: 11, cursor: 'pointer' }}>×</button>
                    </div>
                  ) : (
                    <div style={{ width: 68, height: 68, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '2px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <ImageIcon size={20} color="rgba(232,234,242,0.2)" />
                    </div>
                  )}
                  <button onClick={() => newProductImageRef.current?.click()} className="btn btn-secondary" style={{ fontSize: 12 }}>
                    <ImageIcon size={12} /> {newProductForm.image_data ? 'Trocar foto' : 'Upload foto'}
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'flex-start' }}>
                 After creating it, click on the product card to configure the BOM (components).
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-secondary" onClick={() => setNewProductModal(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSaveNewProduct} disabled={newProductSaving}>{newProductSaving ? 'Saving...' : 'Create Product'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <ConfirmModal
          title={`Delete ${deleteTarget.type === 'label' ? 'Label' : deleteTarget.type === 'stock' ? 'Stock Item' : deleteTarget.type === 'client' ? 'Customer' : 'Product'}`}
          message={`Delete "${deleteTarget.label}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Adjust Stock Modal */}
      {adjustStockModal && (() => {
        const { item } = adjustStockModal
        return (
          <div className="modal-overlay" onClick={() => setAdjustStockModal(null)}>
            <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h2>Adjust Stock</h2>
                  <p style={{ color: '#a78bfa' }}>{item.product_name}</p>
                </div>
                <button className="modal-close" onClick={() => setAdjustStockModal(null)}><X size={14} /></button>
              </div>
              <div className="modal-body">
              <div style={{ display: 'flex', gap: 10, marginBottom: 12, fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                Current: <strong style={{ color: '#e8eaf2' }}>{Number(item.quantity).toLocaleString()} {item.unit}</strong>
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                <F label={`New Quantity (${item.unit})`}>
                  <Input type="number" value={adjustForm.new_qty} onChange={v => setAdjustForm(f => ({ ...f, new_qty: v }))} placeholder="0" />
                  <MlHint value={adjustForm.new_qty} unit={item.unit} />
                </F>
                <F label="Reason (optional)">
                  <textarea value={adjustForm.notes} onChange={e => setAdjustForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="e.g. Stock count correction" style={{ ...iStyle, resize: 'none', width: '100%' }} />
                </F>
              </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setAdjustStockModal(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleAdjustStock} disabled={adjustSaving}>{adjustSaving ? 'Saving...' : 'Save Adjustment'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Edit Stock Item Modal */}
      {editStockModal && (() => {
        const { item } = editStockModal
        return (
          <div className="modal-overlay" onClick={() => setEditStockModal(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Edit Reserved Stock Item</h2>
                <button className="modal-close" onClick={() => setEditStockModal(null)}><X size={14} /></button>
              </div>
              <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <F label="Product Code *">
                  <input value={editStockForm.product_code} onChange={e => setEditStockForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} placeholder="LC_00001" style={{ ...iStyle, fontFamily: 'monospace' }} />
                </F>
                <F label="Product Name *" full>
                  <Input value={editStockForm.product_name} onChange={v => setEditStockForm(f => ({ ...f, product_name: v }))} placeholder="e.g. Coco Republic Glass Bottle 50ml" />
                </F>
                <F label="Category">
                  <SearchSelect
                    value={editStockForm.category}
                    onChange={v => setEditStockForm(f => ({ ...f, category: v }))}
                    options={[
                      { value: 'COMPONENT', label: 'Component' },
                      { value: 'LABEL', label: 'Label' },
                      { value: 'RAW_MATERIAL', label: 'Raw Material' },
                    ]}
                    clearable={false}
                  />
                </F>
                <F label="Unit">
                  <SearchSelect
                    value={editStockForm.unit}
                    onChange={v => setEditStockForm(f => ({ ...f, unit: v }))}
                    options={[{ value: 'units', label: 'units' }, { value: 'ml', label: 'ml' }, { value: 'g', label: 'g' }]}
                    clearable={false}
                  />
                </F>
                <F label="Barcode" full>
                  <Input value={editStockForm.barcode} onChange={v => setEditStockForm(f => ({ ...f, barcode: v }))} placeholder="Scan or type..." />
                </F>
                <F label="Notes" full>
                  <textarea value={editStockForm.notes} onChange={e => setEditStockForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Notes..." style={{ ...iStyle, resize: 'none', width: '100%' }} />
                </F>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setEditStockModal(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleEditStock} disabled={editStockSaving}>{editStockSaving ? 'Saving...' : 'Save Changes'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Add Label Modal */}
      {showLabelModal && (
        <div className="modal-overlay" onClick={() => setShowLabelModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Label Stock</h2>
              <button className="modal-close" onClick={() => setShowLabelModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <F label="Label Name *" full><Input value={labelForm.label_name} onChange={v => setLabelForm(f => ({ ...f, label_name: v }))} placeholder="e.g. Clean Skin Black — Travel Spray 10ml" /></F>
              <F label="Product Type (optional)">
                <select value={labelForm.applicable_product_type} onChange={e => setLabelForm(f => ({ ...f, applicable_product_type: e.target.value }))} style={{ ...iStyle, background: '#1e2035', cursor: 'pointer' }}>
                  <option value="">— All product types —</option>
                  {productTypes.map(pt => <option key={pt.key} value={pt.key}>{pt.label}</option>)}
                </select>
              </F>
              <F label="Artwork Version"><Input value={labelForm.artwork_version} onChange={v => setLabelForm(f => ({ ...f, artwork_version: v }))} placeholder="v1" /></F>
              <F label="Supplier"><Input value={labelForm.supplier} onChange={v => setLabelForm(f => ({ ...f, supplier: v }))} placeholder="Print Express..." /></F>
              <F label="Initial Qty (units)"><Input type="number" value={labelForm.quantity} onChange={v => setLabelForm(f => ({ ...f, quantity: v }))} placeholder="0" /></F>
              <F label="Label Image" full>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {labelForm.image_data
                    ? <img src={labelForm.image_data} alt="" style={{ width: 48, height: 48, borderRadius: 7, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                    : <div style={{ width: 48, height: 48, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ImageIcon size={16} color="rgba(232,234,242,0.25)" /></div>}
                  <label style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,234,242,0.8)', padding: '7px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>
                    {labelForm.image_data ? 'Replace' : 'Upload'}
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) { const d = await resizeImageFile(f); setLabelForm(fm => ({ ...fm, image_data: d })) } e.target.value = '' }} />
                  </label>
                  {labelForm.image_data && (
                    <button type="button" onClick={() => setLabelForm(f => ({ ...f, image_data: '' }))} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#f87171', padding: '7px 9px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>Remove</button>
                  )}
                </div>
              </F>
              <F label="Notes" full>
                <textarea value={labelForm.notes} onChange={e => setLabelForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...iStyle, resize: 'none', width: '100%' }} />
              </F>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowLabelModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveLabel} disabled={labelSaving}>{labelSaving ? 'Saving...' : 'Add Label'}</button>
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
function Input({ value, onChange, placeholder, type = 'text', mono }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ ...iStyle, fontFamily: mono ? 'monospace' : 'inherit' }} />
}
function Btn({ children, onClick, primary, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: primary ? '#2563eb' : 'rgba(255,255,255,0.06)',
      border: primary ? 'none' : '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: '9px 20px', color: primary ? 'white' : '#e8eaf2',
      fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 700, opacity: disabled ? 0.7 : 1
    }}>{children}</button>
  )
}
const iStyle = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none' }
