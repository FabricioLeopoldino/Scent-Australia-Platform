import { useState, useEffect, useRef } from 'react'
import { Package, Tag, Briefcase, Search, Upload, X, Plus, Edit2 } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import { useLocation } from 'wouter'
import { useToast } from '../SMModule.jsx'
import ProductFormModal, { EMPTY_PRODUCT_FORM, ALL_PROD_CATEGORIES } from '../components/ProductFormModal.jsx'
import StockTable from '../components/StockTable.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

function resizeImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        const MAX = 600
        let w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX }
          else { w = Math.round(w * MAX / h); h = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

const CATEGORIES = ['COMPONENT', 'LABEL', 'RAW_MATERIAL']
// Category subset offered in /sm-stock's product modal (components catalog scope)
const SM_PROD_CATEGORIES = ALL_PROD_CATEGORIES.filter(c => CATEGORIES.includes(c.key))
const EMPTY_RESERVED_FORM = {
  client_id: '', product_name: '', product_code: '', category: 'COMPONENTS',
  unit: 'units', quantity: '', notes: '',
}

export default function StockScentedMerchandise() {
  const [tab, setTab] = useState('components')
  const [products, setProducts] = useState([])
  const [allProducts, setAllProducts] = useState([]) // full list — for unique code suggestion
  const [reservedStock, setReservedStock] = useState([])
  const [clientLabels, setClientLabels] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [zoomImage, setZoomImage] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [editingProd, setEditingProd] = useState(null)
  const [createForm, setCreateForm] = useState(EMPTY_PRODUCT_FORM)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const [adjustModal, setAdjustModal] = useState(null) // { product, type: 'add'|'remove'|'set' } OR { reservedItem, type } for client_stock
  const [adjustQty, setAdjustQty] = useState('')
  const [adjustNotes, setAdjustNotes] = useState('')
  const [adjustSaving, setAdjustSaving] = useState(false)
  const [showReservedCreate, setShowReservedCreate] = useState(false)
  const [reservedForm, setReservedForm] = useState(EMPTY_RESERVED_FORM)
  const [reservedSaving, setReservedSaving] = useState(false)
  const [allClients, setAllClients] = useState([])
  const [, navigate] = useLocation()
  const { addToast } = useToast()

  useEffect(() => { load() }, [])
  useEffect(() => {
    axios.get('/api/clients', api()).then(r => setAllClients(r.data)).catch(() => {})
  }, [])

  async function handleCreateReserved() {
    if (!reservedForm.client_id) { addToast('Select a client', 'error'); return }
    if (!reservedForm.product_name.trim() || !reservedForm.product_code.trim()) {
      addToast('Name and code required', 'error'); return
    }
    if (!reservedForm.quantity || parseFloat(reservedForm.quantity) < 0) {
      addToast('Quantity required', 'error'); return
    }
    setReservedSaving(true)
    try {
      await axios.post(`/api/clients/${reservedForm.client_id}/stock/receive`, {
        product_code: reservedForm.product_code.trim().toUpperCase(),
        product_name: reservedForm.product_name.trim(),
        category: reservedForm.category,
        unit: reservedForm.unit || 'units',
        quantity: parseFloat(reservedForm.quantity),
        notes: reservedForm.notes?.trim() || null,
      }, api())
      addToast('Reserved stock created')
      setShowReservedCreate(false)
      setReservedForm(EMPTY_RESERVED_FORM)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setReservedSaving(false) }
  }

  async function handleAdjustReserved(item, type, qty, notes) {
    if (type === 'set') {
      await axios.post(`/api/client-stock/${item.id}/adjust`, { new_stock: parseFloat(qty), notes: notes || null }, api())
    } else {
      await axios.post(`/api/client-stock/${item.id}/${type}`, { quantity: parseFloat(qty), notes: notes || null }, api())
    }
  }

  async function handleDeleteReserved(item) {
    if (!confirm(`Delete "${item.product_name}" from ${item.client_name || 'client'}'s reserved stock?`)) return
    try {
      await axios.delete(`/api/client-stock/${item.id}`, api())
      addToast('Removed')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  function openEditProduct(p) {
    setEditingProd(p)
    setCreateForm({
      name: p.name || '', product_code: p.product_code || '',
      category: p.category || 'COMPONENT', sub_category: p.sub_category || '',
      segment: p.segment || 'SM',
      unit: p.unit || 'units',
      current_stock: String(p.current_stock ?? 0),
      min_stock_level: String(p.min_stock_level ?? 0),
      supplier: p.supplier || '', supplier_code: p.supplier_code || '',
      bin_location: p.bin_location || '', barcode: p.barcode || '',
      lead_time: p.lead_time != null ? String(p.lead_time) : '',
      notes: p.notes || '', image_data: p.image_data || '',
      volume_ml: p.volume_ml != null ? String(p.volume_ml) : '',
      default_oil_pct: p.default_oil_pct != null ? String(p.default_oil_pct) : '',
    })
    setShowCreate(true)
  }

  async function handleCreateProduct() {
    if (!createForm.name.trim() || !createForm.product_code.trim()) {
      addToast('Name and product code required', 'error'); return
    }
    setCreating(true)
    try {
      const payload = {
        name: createForm.name.trim(),
        product_code: createForm.product_code.trim().toUpperCase(),
        category: createForm.category,
        segment: createForm.segment || 'SM',
        sub_category: createForm.sub_category?.trim() || null,
        unit: createForm.unit || 'units',
        min_stock_level: parseFloat(createForm.min_stock_level) || 0,
        supplier: createForm.supplier?.trim() || null,
        supplier_code: createForm.supplier_code?.trim() || null,
        bin_location: createForm.bin_location?.trim() || null,
        barcode: createForm.barcode?.trim() || null,
        lead_time: createForm.lead_time ? parseInt(createForm.lead_time) : null,
        notes: createForm.notes?.trim() || null,
        image_data: createForm.image_data || null,
        volume_ml: createForm.volume_ml ? parseFloat(createForm.volume_ml) : null,
        default_oil_pct: createForm.default_oil_pct ? parseFloat(createForm.default_oil_pct) : null,
      }
      if (editingProd) {
        await axios.put(`/api/products/${editingProd.id}`, payload, api())
        addToast('Product updated')
      } else if (createForm.segment === 'MAJOR' && createForm.client_id) {
        // Major segment → routes to the client's Reserved Stock (client_stock table).
        await axios.post(`/api/clients/${createForm.client_id}/stock/receive`, {
          product_code: payload.product_code,
          product_name: payload.name,
          category: payload.category,
          barcode: payload.barcode,
          unit: payload.unit,
          quantity: parseFloat(createForm.current_stock) || 0,
          notes: payload.notes,
          image_data: payload.image_data,
        }, api())
        addToast(`"${createForm.name}" added to Reserved Stock`)
        setTab('reserved')
      } else {
        await axios.post('/api/products', { ...payload, current_stock: parseFloat(createForm.current_stock) || 0 }, api())
        addToast(`"${createForm.name}" created`)
      }
      setShowCreate(false)
      setEditingProd(null)
      setCreateForm(EMPTY_PRODUCT_FORM)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setCreating(false) }
  }

  async function handleAdjust() {
    if (!adjustQty || parseFloat(adjustQty) < 0) { addToast('Quantity required', 'error'); return }
    setAdjustSaving(true)
    try {
      const { product, reservedItem, type } = adjustModal
      if (reservedItem) {
        await handleAdjustReserved(reservedItem, type, adjustQty, adjustNotes)
      } else if (type === 'set') {
        await axios.post('/api/stock/adjust', { product_id: product.id, new_stock: parseFloat(adjustQty), notes: adjustNotes || null }, api())
      } else {
        await axios.post(`/api/stock/${type}`, { product_id: product.id, quantity: parseFloat(adjustQty), notes: adjustNotes || null }, api())
      }
      addToast('Stock updated')
      setAdjustModal(null); setAdjustQty(''); setAdjustNotes('')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setAdjustSaving(false) }
  }

  async function handleDelete(product) {
    if (!confirm(`Archive "${product.name}"?\n\nThe product will be hidden but its history (transactions, reservations) is preserved. You can restore it later from Stock Management.`)) return
    try {
      await axios.delete(`/api/products/${product.id}`, api())
      addToast(`"${product.name}" archived`)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleRestore(product) {
    try {
      await axios.post(`/api/products/${product.id}/restore`, {}, api())
      addToast(`"${product.name}" restored`)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function load() {
    setLoading(true)
    try {
      const [prods, rsv, lbl] = await Promise.all([
        axios.get('/api/products', api()),
        axios.get('/api/client-stock', api()),
        axios.get('/api/client-labels', api()),
      ])
      setAllProducts(prods.data)
      // SM components only — exclude MUSE-owned components (those live in /muse-stock)
      const filtered = prods.data.filter(p => CATEGORIES.includes(p.category) && !p.is_master && p.segment !== 'MUSE')
      setProducts(filtered)
      setReservedStock(rsv.data)
      setClientLabels(lbl.data)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to load stock', 'error')
    } finally { setLoading(false) }
  }

  async function uploadProductImage(productId, file) {
    const dataUrl = await resizeImage(file)
    try {
      await axios.patch(`/api/products/${productId}/image`, { image_data: dataUrl }, api())
      addToast('Image updated')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to upload', 'error') }
  }

  async function uploadClientStockImage(itemId, file) {
    const dataUrl = await resizeImage(file)
    try {
      await axios.patch(`/api/client-stock/${itemId}/image`, { image_data: dataUrl }, api())
      addToast('Image updated')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to upload', 'error') }
  }

  async function uploadClientLabelImage(labelId, file) {
    const dataUrl = await resizeImage(file)
    try {
      await axios.patch(`/api/client-labels/${labelId}/image`, { image_data: dataUrl }, api())
      addToast('Image updated')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to upload', 'error') }
  }

  // Products filtered by tab + search
  const productsByTab = tab === 'all'
    ? products
    : tab === 'components' ? products.filter(p => p.category === 'COMPONENT')
    : tab === 'labels' ? products.filter(p => p.category === 'LABEL')
    : tab === 'raw' ? products.filter(p => p.category === 'RAW_MATERIAL')
    : products
  const productsFiltered = search.trim()
    ? productsByTab.filter(p =>
        p.name?.toLowerCase().includes(search.toLowerCase()) ||
        p.product_code?.toLowerCase().includes(search.toLowerCase())
      )
    : productsByTab

  // Filtered reserved stock by search
  const reservedFiltered = search.trim()
    ? reservedStock.filter(r =>
        r.product_name?.toLowerCase().includes(search.toLowerCase()) ||
        r.product_code?.toLowerCase().includes(search.toLowerCase()) ||
        r.client_name?.toLowerCase().includes(search.toLowerCase())
      )
    : reservedStock

  // Group reserved stock by client
  const reservedGrouped = reservedFiltered.reduce((acc, r) => {
    const key = r.client_name || 'Unknown client'
    if (!acc[key]) acc[key] = { clientId: r.client_id, items: [] }
    acc[key].items.push(r)
    return acc
  }, {})

  // Filtered client labels (per-client labels, any segment) — grouped by client
  const clientLabelsFiltered = search.trim()
    ? clientLabels.filter(l =>
        l.label_name?.toLowerCase().includes(search.toLowerCase()) ||
        l.client_name?.toLowerCase().includes(search.toLowerCase()) ||
        l.applicable_product_type?.toLowerCase().includes(search.toLowerCase())
      )
    : clientLabels
  const clientLabelsGrouped = clientLabelsFiltered.reduce((acc, l) => {
    const key = l.client_name || 'Unknown client'
    if (!acc[key]) acc[key] = { clientId: l.client_id, items: [] }
    acc[key].items.push(l)
    return acc
  }, {})

  // Counts by tab
  const componentsCount = products.filter(p => p.category === 'COMPONENT').length
  const labelsCount = products.filter(p => p.category === 'LABEL').length
  const rawCount = products.filter(p => p.category === 'RAW_MATERIAL').length

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 22 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <Package size={22} color="#4ade80" />
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Stock</h1>
          </div>
          <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.5)' }}>
            Components, labels and reserved stock for Scented Merchandise
          </div>
        </div>
        {/* Single fixed "+ New Product" button across all product tabs (parity with /stock).
            client_labels tab doesn't show it (those are created from the Clients page). */}
        {tab !== 'client_labels' && (
          <Button onClick={() => {
            setEditingProd(null)
            const defaults = { ...EMPTY_PRODUCT_FORM }
            if (tab === 'labels') defaults.category = 'LABEL'
            else if (tab === 'raw') defaults.category = 'RAW_MATERIAL'
            else if (tab === 'reserved') { defaults.category = 'COMPONENT'; defaults.segment = 'MAJOR' }
            else defaults.category = 'COMPONENT'
            setCreateForm(defaults)
            setShowCreate(true)
          }}>
            <Plus size={15} /> New Product
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.08)', flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'components'} onClick={() => setTab('components')} icon={<Package size={13} />} label="Components" count={componentsCount} color="#60a5fa" />
        <TabBtn active={tab === 'labels'} onClick={() => setTab('labels')} icon={<Tag size={13} />} label="Labels" count={labelsCount} color="#f472b6" />
        <TabBtn active={tab === 'client_labels'} onClick={() => setTab('client_labels')} icon={<Tag size={13} />} label="Client Labels" count={clientLabels.length} color="#e879f9" />
        <TabBtn active={tab === 'raw'} onClick={() => setTab('raw')} icon={<Package size={13} />} label="Raw Materials" count={rawCount} color="#fbbf24" />
        <TabBtn active={tab === 'reserved'} onClick={() => setTab('reserved')} icon={<Briefcase size={13} />} label="Reserved Stock" count={reservedStock.length} color="#a78bfa" />
      </div>

      <div style={{ position: 'relative', marginBottom: 18, maxWidth: 360 }}>
        <Search size={14} color="rgba(232,234,242,0.4)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={tab === 'reserved' ? 'Search component or client...' : 'Search products...'}
          style={{
            width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {loading ? (
        <div style={{ padding: 28, color: 'rgba(232,234,242,0.4)' }}>Loading...</div>
      ) : tab === 'reserved' ? (
        Object.keys(reservedGrouped).length === 0 ? (
          <EmptyState text={search ? `No matches for "${search}"` : 'No reserved stock yet — click "+ New Reserved Stock" to register one for a client'} />
        ) : (
          <ReservedStockView
            grouped={reservedGrouped}
            onUpload={uploadClientStockImage}
            onZoom={setZoomImage}
            onAdjust={(item, type) => { setAdjustModal({ reservedItem: item, type }); setAdjustQty(''); setAdjustNotes('') }}
            onDelete={handleDeleteReserved}
          />
        )
      ) : tab === 'client_labels' ? (
        Object.keys(clientLabelsGrouped).length === 0 ? (
          <EmptyState text={search ? `No matches for "${search}"` : 'No client labels yet — register labels for a client in the Clients page'} />
        ) : (
          <ClientLabelsView grouped={clientLabelsGrouped} onUpload={uploadClientLabelImage} onZoom={setZoomImage} />
        )
      ) : productsFiltered.length === 0 ? (
        <EmptyState text={search ? `No matches for "${search}"` : `No ${tab === 'labels' ? 'labels' : tab === 'raw' ? 'raw materials' : 'components'} yet — click "+ New Product" to add one`} />
      ) : (
        <StockTable
          products={productsFiltered}
          accent={tab === 'labels' ? '#f472b6' : tab === 'raw' ? '#fbbf24' : '#60a5fa'}
          onUpload={uploadProductImage}
          onZoom={setZoomImage}
          onAdjust={(p, type) => { setAdjustModal({ product: p, type }); setAdjustQty(''); setAdjustNotes('') }}
          onEdit={openEditProduct}
          onDelete={handleDelete}
          onRestore={handleRestore}
        />
      )}

      {showCreate && (
        <ProductFormModal
          mode={editingProd ? 'edit' : 'create'}
          form={createForm}
          setForm={setCreateForm}
          saving={creating}
          onClose={() => { setShowCreate(false); setEditingProd(null) }}
          onSave={handleCreateProduct}
          allProducts={allProducts}
          categories={SM_PROD_CATEGORIES}
        />
      )}

      {adjustModal && (
        <AdjustStockModal
          modal={adjustModal}
          qty={adjustQty} setQty={setAdjustQty}
          notes={adjustNotes} setNotes={setAdjustNotes}
          saving={adjustSaving}
          onClose={() => setAdjustModal(null)}
          onSave={handleAdjust}
        />
      )}

      {showReservedCreate && (
        <CreateReservedModal
          form={reservedForm}
          setForm={setReservedForm}
          clients={allClients}
          saving={reservedSaving}
          onClose={() => setShowReservedCreate(false)}
          onSave={handleCreateReserved}
        />
      )}

      {zoomImage && (
        <div onClick={() => setZoomImage(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9500, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <img src={zoomImage} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, boxShadow: '0 10px 60px rgba(0,0,0,0.6)' }} />
          <button onClick={() => setZoomImage(null)} style={{ position: 'absolute', top: 18, right: 18, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, width: 36, height: 36, color: '#e8eaf2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  )
}

function ImageCell({ image, name, onUpload, onZoom, accent }) {
  const inputRef = useRef(null)
  return (
    <div style={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
      {image ? (
        <img src={image} alt={name} onClick={(e) => { e.stopPropagation(); onZoom?.(image) }} style={{ width: 44, height: 44, borderRadius: 7, objectFit: 'cover', border: `1px solid ${accent}55`, cursor: 'zoom-in' }} />
      ) : (
        <button onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }} title="Upload image" style={{ width: 44, height: 44, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, color: 'rgba(232,234,242,0.3)' }}>
          <Upload size={14} />
        </button>
      )}
      {image && (
        <button onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }} title="Replace image" style={{ position: 'absolute', right: -5, bottom: -5, width: 18, height: 18, borderRadius: '50%', background: '#0f1117', border: `1px solid ${accent}`, color: accent, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <Upload size={9} />
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }} />
    </div>
  )
}

function ClientLabelsView({ grouped, onUpload, onZoom }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {Object.entries(grouped).map(([clientName, { clientId, items }]) => {
        const total = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0)
        return (
          <div key={clientId}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,121,249,0.8)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tag size={12} /> {clientName}
              <span style={{ color: 'rgba(232,234,242,0.3)', fontWeight: 500 }}>· {items.length} label{items.length !== 1 ? 's' : ''} · {Number(total).toLocaleString()} units total</span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {['', 'Label', 'Version', 'Applicable Master', 'Supplier', 'Stock', 'Reserved', 'Available', 'Notes'].map((h, i) => (
                      <th key={i} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(l => {
                    const stock = parseFloat(l.quantity) || 0
                    const reserved = parseFloat(l.reserved_qty) || 0
                    const available = stock - reserved
                    return (
                      <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '8px 14px', width: 60, borderLeft: '2px solid #e879f9' }}>
                          <ImageCell image={l.image_data} name={l.label_name} onUpload={(f) => onUpload(l.id, f)} onZoom={onZoom} accent="#e879f9" />
                        </td>
                        <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e879f9' }}>{l.label_name}</td>
                        <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{l.artwork_version || '—'}</td>
                        <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{l.applicable_product_type ? l.applicable_product_type.replace(/_/g, ' ') : 'All'}</td>
                        <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>{l.supplier || '—'}</td>
                        <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>
                          {Number(stock).toLocaleString()} <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontWeight: 500 }}>units</span>
                        </td>
                        <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: reserved > 0 ? '#fbbf24' : 'rgba(232,234,242,0.3)' }}>
                          {reserved > 0 ? Number(reserved).toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: available <= 0 ? '#f87171' : available < reserved ? '#fbbf24' : '#4ade80' }}>
                          {Number(available).toLocaleString()}
                        </td>
                        <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic' }}>{l.notes || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ReservedStockView({ grouped, onUpload, onZoom, onAdjust, onDelete }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {Object.entries(grouped).map(([clientName, { clientId, items }]) => {
        const total = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0)
        return (
          <div key={clientId}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(167,139,250,0.8)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Briefcase size={12} /> {clientName}
              <span style={{ color: 'rgba(232,234,242,0.3)', fontWeight: 500 }}>· {items.length} item{items.length !== 1 ? 's' : ''} · {Number(total).toLocaleString()} total</span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {['', 'Name', 'Code', 'Category', 'Quantity', 'Received', 'Notes', 'Actions'].map((h, i) => (
                      <th key={i} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '8px 14px', width: 60, borderLeft: '2px solid #a78bfa' }}>
                        <ImageCell image={item.image_data} name={item.product_name} onUpload={(f) => onUpload(item.id, f)} onZoom={onZoom} accent="#a78bfa" />
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{item.product_name}</td>
                      <td style={{ padding: '10px 14px', fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)' }}>{item.product_code}</td>
                      <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{(item.category || 'COMPONENTS').replace(/_/g, ' ')}</td>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: parseFloat(item.quantity) > 0 ? '#4ade80' : '#f87171' }}>
                        {Number(item.quantity || 0).toLocaleString()} <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontWeight: 500 }}>{item.unit || 'units'}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{item.received_date ? new Date(item.received_date).toLocaleDateString() : '—'}</td>
                      <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.notes || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => onAdjust(item, 'add')} title="Add" style={actionBtn('#4ade80')}>+</button>
                          <button onClick={() => onAdjust(item, 'remove')} title="Remove" style={actionBtn('#fbbf24')}>−</button>
                          <button onClick={() => onAdjust(item, 'set')} title="Set" style={actionBtn('#60a5fa')}>Set</button>
                          <button onClick={() => onDelete(item)} title="Delete" style={{ ...actionBtn('#f87171'), padding: '4px 7px' }}>×</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TabBtn({ active, onClick, icon, label, count, color }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none',
      borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
      color: active ? color : 'rgba(232,234,242,0.5)',
      padding: '10px 16px', fontSize: 13, fontWeight: active ? 700 : 500,
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {icon} {label}
      {count > 0 && (
        <span style={{
          background: active ? `${color}33` : 'rgba(255,255,255,0.08)',
          color: active ? color : 'rgba(232,234,242,0.4)',
          padding: '0 6px', borderRadius: 10, fontSize: 10, fontWeight: 700, marginLeft: 2,
        }}>{count}</span>
      )}
    </button>
  )
}

function CreateReservedModal({ form, setForm, clients, saving, onClose, onSave }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 520, background: 'var(--card-bg)', boxShadow: 'var(--shadow-md)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: 24,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Briefcase size={18} color="#a78bfa" />
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 16, color: '#e8eaf2' }}>New Reserved Stock</h2>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Client *">
            <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} style={inputStyle}>
              <option value="">— Select client —</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.is_large_client ? ' · Major' : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Product Name *">
            <input value={form.product_name} onChange={e => setForm(f => ({ ...f, product_name: e.target.value }))} placeholder="e.g. Coco Glass Bottle 100ml" style={inputStyle} />
          </Field>
          <Field label="Product Code *">
            <input value={form.product_code} onChange={e => setForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} placeholder="e.g. COCO_BOTTLE_100" style={{ ...inputStyle, fontFamily: 'monospace' }} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="Category">
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={inputStyle}>
                <option value="COMPONENTS">Components</option>
                <option value="LABELS">Labels</option>
                <option value="PACKAGING">Packaging</option>
                <option value="RAW_MATERIAL">Raw Material</option>
                <option value="OTHER">Other</option>
              </select>
            </Field>
            <Field label="Unit">
              <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} style={inputStyle}>
                <option value="units">units</option>
                <option value="ml">ml</option>
                <option value="L">L</option>
                <option value="g">g</option>
                <option value="kg">kg</option>
              </select>
            </Field>
            <Field label="Quantity *">
              <input type="number" step="any" min={0} value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} placeholder="0" style={inputStyle} />
            </Field>
          </div>
          <Field label="Notes">
            <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional — batch, supplier, received date" style={inputStyle} />
          </Field>
        </div>

        <div style={{ marginTop: 18, padding: 11, background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.18)', borderRadius: 8, fontSize: 11, color: 'rgba(232,234,242,0.6)' }}>
          Reserved stock is owned by the client and used exclusively for their production orders.
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,234,242,0.7)', padding: '9px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={onSave} disabled={saving} style={{ background: '#a78bfa', border: 'none', color: '#0f1117', padding: '9px 18px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Creating...' : 'Create Reserved Stock'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AdjustStockModal({ modal, qty, setQty, notes, setNotes, saving, onClose, onSave }) {
  const { product, reservedItem, type } = modal
  const target = reservedItem || product
  const targetName = reservedItem ? reservedItem.product_name : product.name
  const targetCode = target.product_code
  const targetStock = reservedItem ? reservedItem.quantity : product.current_stock
  const targetUnit = target.unit
  const titles = { add: 'Add Stock', remove: 'Remove Stock', set: 'Set Stock' }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{titles[type]}{reservedItem ? ' (Reserved)' : ''}</h2>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal-body">
          <div style={{ marginBottom: 16, padding: '10px 12px', background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
              {targetName}
              {reservedItem?.client_name && <span style={{ fontSize: 11, color: '#a78bfa', fontWeight: 500, marginLeft: 6 }}>· {reservedItem.client_name}</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2 }}>{targetCode} · current: {Number(targetStock || 0).toLocaleString()} {targetUnit}</div>
          </div>

          <div className="form-group">
            <label className="label">{type === 'set' ? 'New stock value' : 'Quantity'}</label>
            <input type="number" min={0} step="any" value={qty} onChange={e => setQty(e.target.value)} autoFocus className="input" placeholder="0" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Reason / batch / supplier" className="input" />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving...' : titles[type]}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle = {
  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8, padding: '9px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none',
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

function ProductsTable({ products, accent, onUpload, onZoom, onAdjust, onEdit, onDelete }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {['', 'Name', 'Code', 'Stock', 'Min', 'Notes', 'Actions'].map((h, i) => (
              <th key={i} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map(p => {
            const stock = parseFloat(p.current_stock) || 0
            const min = parseFloat(p.min_stock_level) || 0
            const stockColor = stock <= 0 ? '#f87171' : (min > 0 && stock < min) ? '#fbbf24' : '#4ade80'
            return (
              <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '8px 14px', width: 60, borderLeft: `2px solid ${accent}` }}>
                  <ImageCell image={p.image_data} name={p.name} onUpload={(f) => onUpload(p.id, f)} onZoom={onZoom} accent={accent} />
                </td>
                <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{p.name}</td>
                <td style={{ padding: '10px 14px', fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)' }}>{p.product_code}</td>
                <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: stockColor }}>
                  {Number(stock).toLocaleString()} <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontWeight: 500 }}>{p.unit}</span>
                </td>
                <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{min || '—'}</td>
                <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', fontStyle: 'italic', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.notes || '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => onAdjust(p, 'add')} title="Add stock" style={actionBtn('#4ade80')}>+ Add</button>
                    <button onClick={() => onAdjust(p, 'remove')} title="Remove stock" style={actionBtn('#fbbf24')}>− Remove</button>
                    <button onClick={() => onAdjust(p, 'set')} title="Set stock" style={actionBtn('#60a5fa')}>Set</button>
                    <button onClick={() => onEdit(p)} title="Edit product" style={{ ...actionBtn('#a78bfa'), padding: '4px 7px' }}><Edit2 size={12} /></button>
                    <button onClick={() => onDelete(p)} title="Delete" style={{ ...actionBtn('#f87171'), padding: '4px 7px' }}>×</button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function actionBtn(color) {
  return {
    background: `${color}1a`, border: `1px solid ${color}40`, color,
    borderRadius: 6, padding: '4px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  }
}

function EmptyState({ text }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(232,234,242,0.3)' }}>
      <Package size={36} style={{ opacity: 0.5, marginBottom: 12 }} />
      <div style={{ fontSize: 13 }}>{text}</div>
    </div>
  )
}
