import { useState, useEffect, useRef } from 'react'
import { Search, X, History, ImageIcon, Plus, Edit2, Trash2, Printer, Paperclip } from 'lucide-react'
import axios from 'axios'
import JsBarcode from 'jsbarcode'
import { useInkColor } from '../utils/theme.js'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import { useToast } from '../SMModule.jsx'
import MlHint from '../components/MlHint.jsx'
import AttachmentsModal from '../components/AttachmentsModal.jsx'
import { fmt as fmtDT } from '../utils/date.js'
import { fmtVolume } from '../utils/volume.js'
import ProductFormModal, { EMPTY_PRODUCT_FORM, defaultUnitForCategory, suggestProductCode, PRODUCT_SEGMENTS } from '../components/ProductFormModal.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const CATEGORIES = [
  { key: 'ALL', label: 'All' },
  { key: 'FRAGRANCE', label: 'Fragrance' },
  { key: 'RAW_MATERIAL', label: 'Raw Material' },
  { key: 'COMPONENT', label: 'Component' },
  { key: 'LABEL', label: 'Label' },
  { key: 'FINISHED_GOOD', label: 'Finished Good' },
  { key: 'READY_FORMULA', label: 'Ready Formula' },
  { key: 'CLIENT_STOCK', label: 'Reserved Stock' },
]

const CAT_COLORS = {
  FRAGRANCE: '#a78bfa',
  RAW_MATERIAL: '#fbbf24',
  COMPONENT: '#60a5fa',
  LABEL: '#f472b6',
  FINISHED_GOOD: '#4ade80',
  READY_FORMULA: '#fb923c',
  CLIENT_STOCK: '#a78bfa',
}

// Same tiers as StockTable.STATUS_TONE so colors stay consistent across views.
function stockColor(current, min) {
  const c = parseFloat(current)
  const m = parseFloat(min)
  if (c <= 0) return '#ef4444'        // OUT OF STOCK
  if (m <= 0) return '#4ade80'        // SAFE (no tracking)
  if (c < m * 0.25) return '#f87171'  // CRITICAL
  if (c < m * 0.5)  return '#fb923c'  // LOW STOCK
  if (c < m)        return '#fbbf24'  // ATTENTION
  return '#4ade80'                    // SAFE
}

function formatStock(qty, unit) {
  return fmtVolume(qty, unit)
}

export default function StockManagement() {
  const [products, setProducts] = useState([])
  const [filter, setFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [actionModal, setActionModal] = useState(null)
  const [qty, setQty] = useState('')
  const [newStock, setNewStock] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [historyModal, setHistoryModal] = useState(null)
  const [history, setHistory] = useState([])
  const [editingBin, setEditingBin] = useState(null)
  const [binVal, setBinVal] = useState('')
  const [labelPhoto, setLabelPhoto] = useState(null)
  const labelPhotoRef = useRef(null)
  const [zoomImage, setZoomImage] = useState(null)
  const [productModal, setProductModal] = useState(null) // null | 'create' | { editing: product }
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT_FORM)
  const [productSaving, setProductSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [barcodeTarget, setBarcodeTarget] = useState(null)
  const [barcodeCopies, setBarcodeCopies] = useState(1)
  const [attachModal, setAttachModal] = useState(null)
  const [allProducts, setAllProducts] = useState([]) // full list — for unique code suggestion
  const [saLinks, setSaLinks] = useState({}) // sm_product_id → {sa_code, sa_name} (fragrance transfer links)
  const { addToast } = useToast()

  // SA link badges — which fragrances are linked to an SA oil (visual only;
  // codes stay independent per system, the link table is the source of truth).
  useEffect(() => {
    axios.get('/api/platform/product-links/sm-map', api())
      .then(r => {
        const map = {}
        for (const row of r.data) map[row.sm_product_id] = row
        setSaLinks(map)
      })
      .catch(() => {}) // badge is optional decoration — never block the page
  }, [])

  function printBarcode() {
    if (!barcodeTarget) return
    const code = barcodeTarget.barcode || barcodeTarget.product_code
    if (!code) return
    const copies = Math.max(1, Math.min(parseInt(barcodeCopies) || 1, 100))
    const win = window.open('', '_blank', 'width=600,height=500')
    const tmpSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    JsBarcode(tmpSvg, code, {
      format: 'CODE128', lineColor: '#000', background: '#fff',
      width: 2, height: 60, displayValue: true, font: 'monospace', fontSize: 11, margin: 8,
    })
    const svgStr = tmpSvg.outerHTML
    const labels = Array.from({ length: copies }, () => `
      <div class="label">
        <div class="name">${barcodeTarget.name}</div>
        ${svgStr}
        <div class="code">${barcodeTarget.product_code}</div>
      </div>`).join('')
    win.document.write(`<!DOCTYPE html><html><head><title>Barcode — ${barcodeTarget.name}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: monospace; background: #fff; padding: 12px; }
        .grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .label { border: 1px dashed #ccc; border-radius: 4px; padding: 8px 12px;
                 text-align: center; width: 200px; page-break-inside: avoid; }
        .name { font-size: 11px; font-weight: bold; margin-bottom: 4px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .code { font-size: 10px; color: #666; margin-top: 2px; }
        svg { max-width: 100%; height: auto; }
        @media print { body { padding: 0; } }
      </style></head>
      <body><div class="grid">${labels}</div>
      <script>window.onload = () => { window.print(); }<\/script>
      </body></html>`)
    win.document.close()
  }

  const isClientStock = filter === 'CLIENT_STOCK'
  const isLabel = filter === 'LABEL'

  function resizeImage(file) {
    return new Promise((resolve) => {
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

  async function handleLabelPhoto(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) { addToast('Please select an image file', 'error'); return }
    const base64 = await resizeImage(file)
    setLabelPhoto(base64)
  }

  useEffect(() => { loadProducts() }, [filter, search, showArchived])

  async function loadProducts() {
    setLoading(true)
    try {
      if (isClientStock) {
        const params = {}
        if (search) params.search = search
        const res = await axios.get('/api/client-stock', { ...api(), params })
        setProducts(res.data.map(cs => ({
          ...cs,
          name: cs.product_name,
          current_stock: cs.quantity,
          min_stock_level: 0,
          _source: 'client_stock',
        })))
      } else {
        const params = {}
        if (filter !== 'ALL') params.category = filter
        if (search) params.search = search
        if (showArchived) params.include_archived = 1
        const res = await axios.get('/api/products', { ...api(), params })
        // Hide masters/templates — they don't carry stock, variants do.
        // A FG product is a template if it has no master parent AND no fragrance link.
        let rows = res.data.filter(p => {
          if (p.is_master) return false
          if (p.category === 'FINISHED_GOOD' && !p.master_product_id && !p.fragrance_id) return false
          return true
        })
        if (isLabel) {
          const labRes = await axios.get('/api/client-labels', api())
          const mapped = labRes.data
            .filter(cl => !search || cl.label_name?.toLowerCase().includes(search.toLowerCase()) || cl.client_name?.toLowerCase().includes(search.toLowerCase()))
            .map(cl => ({
              id: `cl_${cl.id}`,
              _is_client_label: true,
              _client_label_id: cl.id,
              category: 'LABEL',
              name: `${cl.label_name} ${cl.artwork_version}`,
              supplier: cl.client_name,
              product_code: `CL_${String(cl.id).padStart(5, '0')}`,
              current_stock: cl.quantity,
              min_stock_level: 0,
              unit: 'units',
              bin_location: null,
              image_data: cl.image_data || null,
            }))
          rows = [...rows, ...mapped]
        }
        setProducts(rows)
        // Full unfiltered list — for globally-unique product code suggestion
        if (filter !== 'ALL' || search) {
          try { const allRes = await axios.get('/api/products', api()); setAllProducts(allRes.data) }
          catch { setAllProducts(res.data) }
        } else {
          setAllProducts(res.data)
        }
      }
    } catch { addToast('Failed to load stock', 'error') }
    finally { setLoading(false) }
  }

  async function handleAction() {
    if (!actionModal) return
    setSaving(true)
    try {
      const { product, type } = actionModal
      if (product._source === 'client_stock') {
        if (type === 'adjust') {
          if (newStock === '') { addToast('Enter new stock value', 'error'); setSaving(false); return }
          await axios.post(`/api/client-stock/${product.id}/adjust`, { new_stock: parseFloat(newStock), notes: notes || null }, api())
        } else {
          if (!qty || parseFloat(qty) <= 0) { addToast('Enter a valid quantity', 'error'); setSaving(false); return }
          await axios.post(`/api/client-stock/${product.id}/${type}`, { quantity: parseFloat(qty), notes: notes || null }, api())
        }
      } else {
        if (type === 'adjust') {
          if (newStock === '') { addToast('Enter new stock value', 'error'); setSaving(false); return }
          await axios.post('/api/stock/adjust', { product_id: product.id, new_stock: parseFloat(newStock), notes: notes || null }, api())
        } else {
          if (!qty || parseFloat(qty) <= 0) { addToast('Enter a valid quantity', 'error'); setSaving(false); return }
          await axios.post(`/api/stock/${type}`, { product_id: product.id, quantity: parseFloat(qty), notes: notes || null }, api())
        }
      }
      if (type === 'add' && labelPhoto && !product._source) {
        await axios.patch(`/api/products/${product.id}/image`, { image_data: labelPhoto }, api())
      }
      addToast(`Stock ${type === 'add' ? 'added' : type === 'remove' ? 'removed' : 'adjusted'} successfully`)
      setActionModal(null)
      setQty(''); setNewStock(''); setNotes(''); setLabelPhoto(null)
      loadProducts()
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed', 'error')
    } finally { setSaving(false) }
  }

  async function saveBinLocation(productId) {
    try {
      await axios.patch(`/api/products/${productId}/bin-location`, { bin_location: binVal }, api())
      setProducts(prev => prev.map(p => p.id === productId ? { ...p, bin_location: binVal || null } : p))
    } catch { addToast('Failed to save bin location', 'error') }
    setEditingBin(null)
  }

  async function openHistory(product) {
    setHistoryModal(product)
    try {
      if (product._source === 'client_stock') {
        const res = await axios.get(`/api/client-stock/${product.id}/history`, api())
        setHistory(res.data)
      } else {
        const res = await axios.get(`/api/products/${product.id}/transactions`, api())
        setHistory(res.data)
      }
    } catch { setHistory([]) }
  }

  function openCreateProduct() {
    const startCat = ['ALL', 'CLIENT_STOCK'].includes(filter) ? 'COMPONENT' : filter
    setProductForm({
      ...EMPTY_PRODUCT_FORM,
      category: startCat,
      segment: 'SHARED',
      unit: defaultUnitForCategory(startCat),
      product_code: suggestProductCode(startCat, allProducts),
    })
    setProductModal('create')
  }

  function openEditProduct(p) {
    setProductForm({
      name: p.name || '', product_code: p.product_code || '',
      category: p.category || 'COMPONENT', sub_category: p.sub_category || '',
      segment: p.segment || 'SHARED',
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
    setProductModal({ editing: p })
  }

  async function handleSaveProduct() {
    if (!productForm.name.trim() || !productForm.product_code.trim()) {
      addToast('Name and product code required', 'error'); return
    }
    setProductSaving(true)
    try {
      const payload = {
        name: productForm.name.trim(),
        product_code: productForm.product_code.trim().toUpperCase(),
        category: productForm.category,
        segment: productForm.segment || 'SHARED',
        sub_category: productForm.sub_category?.trim() || null,
        unit: productForm.unit || 'units',
        min_stock_level: parseFloat(productForm.min_stock_level) || 0,
        supplier: productForm.supplier?.trim() || null,
        supplier_code: productForm.supplier_code?.trim() || null,
        bin_location: productForm.bin_location?.trim() || null,
        barcode: productForm.barcode?.trim() || null,
        lead_time: productForm.lead_time ? parseInt(productForm.lead_time) : null,
        notes: productForm.notes?.trim() || null,
        image_data: productForm.image_data || null,
        volume_ml: productForm.volume_ml ? parseFloat(productForm.volume_ml) : null,
        default_oil_pct: productForm.default_oil_pct ? parseFloat(productForm.default_oil_pct) : null,
      }
      if (productModal === 'create' && productForm.segment === 'MAJOR' && productForm.client_id) {
        // Major segment → routes to the client's Reserved Stock (client_stock table).
        await axios.post(`/api/clients/${productForm.client_id}/stock/receive`, {
          product_code: payload.product_code,
          product_name: payload.name,
          category: payload.category,
          barcode: payload.barcode,
          unit: payload.unit,
          quantity: parseFloat(productForm.current_stock) || 0,
          notes: payload.notes,
          image_data: payload.image_data,
        }, api())
        addToast(`"${productForm.name}" added to Reserved Stock`)
      } else if (productModal === 'create') {
        payload.current_stock = parseFloat(productForm.current_stock) || 0
        await axios.post('/api/products', payload, api())
        addToast(`"${productForm.name}" created`)
      } else {
        await axios.put(`/api/products/${productModal.editing.id}`, payload, api())
        addToast('Product updated')
      }
      setProductModal(null)
      setProductForm(EMPTY_PRODUCT_FORM)
      loadProducts()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setProductSaving(false) }
  }

  async function handleArchiveProduct() {
    if (!deleteTarget) return
    try {
      await axios.delete(`/api/products/${deleteTarget.id}`, api()) // soft archive (default mode)
      addToast(`"${deleteTarget.name}" archived`)
      setDeleteTarget(null)
      loadProducts()
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to archive', 'error')
    }
  }

  async function handleRestoreProduct(product) {
    try {
      await axios.post(`/api/products/${product.id}/restore`, {}, api())
      addToast(`"${product.name}" restored`)
      loadProducts()
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to restore', 'error')
    }
  }

  async function handleDeletePermanently() {
    if (!deleteTarget) return
    try {
      await axios.delete(`/api/products/${deleteTarget.id}?mode=permanent`, api())
      addToast(`"${deleteTarget.name}" permanently deleted`)
      setDeleteTarget(null)
      loadProducts()
    } catch (e) {
      addToast(e.response?.data?.error || 'Cannot delete — archive instead', 'error')
    }
  }


  const displayed = products.filter(p => {
    if (isClientStock) return true
    return (filter === 'ALL' || p.category === filter) &&
      (!search || p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.product_code.toLowerCase().includes(search.toLowerCase()))
  })

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Stock Management</h1>
          <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>All products — create, edit and manage stock levels across categories.</p>
        </div>
        {!isClientStock && (
          <Button onClick={openCreateProduct}>
            <Plus size={15} /> New Product
          </Button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {CATEGORIES.map(c => (
          <button key={c.key} onClick={() => setFilter(c.key)} style={{
            background: filter === c.key ? 'var(--accent-soft)' : 'var(--surface-2)',
            color: filter === c.key ? 'var(--accent-text)' : 'var(--text-secondary)',
            border: filter === c.key ? '1px solid var(--border-h)' : '1px solid var(--border)',
            borderRadius: 20, padding: '5px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer'
          }}>{c.label}</button>
        ))}
        {!isClientStock && (
          <button onClick={() => setShowArchived(v => !v)} title="Toggle archived products" style={{
            marginLeft: 8, background: showArchived ? 'rgba(160,27,27,0.10)' : 'var(--surface-2)',
            color: showArchived ? '#a01b1b' : 'var(--text-secondary)',
            border: `1px solid ${showArchived ? 'rgba(160,27,27,0.30)' : 'var(--border)'}`,
            borderRadius: 20, padding: '5px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer'
          }}>{showArchived ? 'Showing Archived' : 'Show Archived'}</button>
        )}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder={isClientStock ? 'Search by product, code or client...' : 'Search products...'}
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {(isClientStock
                  ? ['Product', 'Code', 'Shopify SKU', 'Barcode', 'Client', 'Category', 'Quantity', 'Actions']
                  : ['Product', 'Code', 'Shopify SKU', 'Segment', 'Barcode', 'Status', 'Total Stock', 'Reserved', 'Available', 'Min Level', 'Bin Location', 'Actions']
                ).map(h => (
                  <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 ? (
                <tr><td colSpan={isClientStock ? 8 : 12} style={{ padding: '32px 14px', textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>
                  {isClientStock ? 'No reserved stock entries' : 'No products found'}
                </td></tr>
              ) : displayed.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: p.archived ? 0.55 : 1 }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {p.image_data ? (
                        <img src={p.image_data} alt="" onClick={() => setZoomImage(p.image_data)} style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.12)', flexShrink: 0, cursor: 'zoom-in' }} />
                      ) : (
                        <div style={{ width: 32, height: 32, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <ImageIcon size={12} color="rgba(232,234,242,0.2)" />
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {p.name}
                          {p.archived && <span style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 800, letterSpacing: 0.4 }}>ARCHIVED</span>}
                          {p.category === 'FRAGRANCE' && !p._source && saLinks[p.id] && (
                            <span
                              title={`Linked to SA fragrance oil "${saLinks[p.id].sa_name}" (${saLinks[p.id].sa_code}) — receives stock via transfers`}
                              style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 800, letterSpacing: 0.4, fontFamily: 'monospace', cursor: 'help', whiteSpace: 'nowrap' }}
                            >
                              ⇄ SA {saLinks[p.id].sa_code}
                            </span>
                          )}
                        </div>
                        {!isClientStock && (
                          <span style={{ background: `${CAT_COLORS[p.category]}20`, color: CAT_COLORS[p.category], padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                            {p.category.replace('_', ' ')}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)', fontFamily: 'monospace' }}>{p.product_code}</td>
                  {/* Shopify SKU — reuses product_code (single source of truth). When integration ships, this is what syncs. */}
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(74,222,128,0.85)', fontFamily: 'monospace' }} title="This is the SKU that will sync to Shopify">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', flexShrink: 0 }} />
                      {p.product_code}
                    </span>
                  </td>

                  {isClientStock ? (
                    <>
                      {/* Barcode */}
                      <td style={{ padding: '10px 14px' }}>
                        {(() => {
                          const bc = p.barcode || p.product_code
                          return bc ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <BarcodeTag value={bc} />
                              <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{bc}</span>
                            </div>
                          ) : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)' }}>—</span>
                        })()}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#a78bfa' }}>{p.client_name}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ background: `${CAT_COLORS[p.category] || '#60a5fa'}20`, color: CAT_COLORS[p.category] || '#60a5fa', padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                          {(p.category || '').replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: stockColor(p.current_stock, 0) }}>
                          {formatStock(p.current_stock, p.unit)}
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      {/* Segment */}
                      <td style={{ padding: '10px 14px' }}>
                        {(() => {
                          const seg = PRODUCT_SEGMENTS.find(s => s.key === p.segment)
                          if (!seg) return <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)' }}>—</span>
                          return (
                            <span style={{ background: `${seg.color}20`, color: seg.color, padding: '2px 9px', borderRadius: 20, fontSize: 10, fontWeight: 800, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>
                              {seg.label}
                            </span>
                          )
                        })()}
                      </td>
                      {/* Barcode */}
                      <td style={{ padding: '10px 14px' }}>
                        {(() => {
                          const bc = p.barcode || p.product_code
                          return bc ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <BarcodeTag value={bc} />
                              <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{bc}</span>
                            </div>
                          ) : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)' }}>—</span>
                        })()}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {(() => {
                          const avail = parseFloat(p.current_stock) - (parseFloat(p.reserved_qty) || 0)
                          const min = parseFloat(p.min_stock_level) || 0
                          let label = 'SAFE', color = '#4ade80'
                          if (avail <= 0)            { label = 'OUT OF STOCK'; color = '#ef4444' }
                          else if (min <= 0)         { label = 'SAFE';         color = '#4ade80' }
                          else if (avail < min*0.25) { label = 'CRITICAL';     color = '#f87171' }
                          else if (avail < min*0.5)  { label = 'LOW STOCK';    color = '#fb923c' }
                          else if (avail < min)      { label = 'ATTENTION';    color = '#fbbf24' }
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, background: `${color}18`, border: `1px solid ${color}40`, color }}>
                              {label}
                            </span>
                          )
                        })()}
                      </td>
                      {/* Total Stock */}
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf2' }}>
                          {formatStock(p.current_stock, p.unit)}
                        </span>
                      </td>
                      {/* Reserved */}
                      <td style={{ padding: '10px 14px' }}>
                        {(() => {
                          const reserved = parseFloat(p.reserved_qty) || 0
                          if (reserved === 0) return <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)' }}>—</span>
                          const details = Array.isArray(p.reservation_detail) ? p.reservation_detail : []
                          const tip = details.map(d => `${d.order_number || 'Order'}: ${formatStock(d.qty, p.unit)}`).join('\n')
                          return (
                            <span title={tip} style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', cursor: details.length ? 'help' : 'default', borderBottom: details.length ? '1px dashed rgba(251,191,36,0.4)' : 'none' }}>
                              {formatStock(reserved, p.unit)}
                            </span>
                          )
                        })()}
                      </td>
                      {/* Available */}
                      <td style={{ padding: '10px 14px' }}>
                        {(() => {
                          const avail = parseFloat(p.current_stock) - (parseFloat(p.reserved_qty) || 0)
                          const min = parseFloat(p.min_stock_level)
                          const isOut = avail <= 0
                          const isLow = !isOut && min > 0 && avail < min
                          return (
                            <span style={{ fontSize: 14, fontWeight: 700, color: isOut ? '#f87171' : isLow ? '#fbbf24' : '#4ade80' }}>
                              {formatStock(avail, p.unit)}
                            </span>
                          )
                        })()}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                        {p.min_stock_level > 0 ? formatStock(p.min_stock_level, p.unit) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {editingBin === p.id ? (
                          <input
                            autoFocus value={binVal} onChange={e => setBinVal(e.target.value)}
                            onBlur={() => saveBinLocation(p.id)}
                            onKeyDown={e => { if (e.key === 'Enter') saveBinLocation(p.id); if (e.key === 'Escape') setEditingBin(null) }}
                            placeholder="e.g. A-01-3"
                            style={{ width: 90, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(96,165,250,0.5)', borderRadius: 6, padding: '3px 7px', color: '#e8eaf2', fontSize: 12, outline: 'none', fontFamily: 'monospace' }}
                          />
                        ) : (
                          <button
                            onClick={() => { setEditingBin(p.id); setBinVal(p.bin_location || '') }}
                            title="Click to edit"
                            style={{ background: 'none', border: '1px solid transparent', borderRadius: 5, padding: '2px 6px', cursor: 'pointer', color: p.bin_location ? 'rgba(232,234,242,0.6)' : 'rgba(232,234,242,0.2)', fontSize: 12, fontFamily: 'monospace' }}
                            onMouseEnter={e => { e.currentTarget.style.border = '1px solid rgba(96,165,250,0.3)'; e.currentTarget.style.background = 'rgba(96,165,250,0.06)' }}
                            onMouseLeave={e => { e.currentTarget.style.border = '1px solid transparent'; e.currentTarget.style.background = 'none' }}
                          >
                            {p.bin_location || '+ add'}
                          </button>
                        )}
                      </td>
                    </>
                  )}

                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {!p._is_client_label && !p._source && <ActionBtn label="Adjust" color="#60a5fa" onClick={() => { setActionModal({ product: p, type: 'add' }); setQty(''); setNotes('') }} />}
                      {p._source === 'client_stock' && <ActionBtn label="Adjust" color="#60a5fa" onClick={() => { setActionModal({ product: p, type: 'add' }); setQty(''); setNotes('') }} />}
                      {p._source === 'client_stock' && (
                        <IconButton onClick={() => { setBarcodeTarget(p); setBarcodeCopies(1) }} title="Print barcode"><Printer size={13} /></IconButton>
                      )}
                      {!p._is_client_label && !p._source && (
                        <IconButton onClick={() => openEditProduct(p)} title="Edit product"><Edit2 size={13} /></IconButton>
                      )}
                      {!p._is_client_label && !p._source && (
                        <IconButton onClick={() => { setBarcodeTarget(p); setBarcodeCopies(1) }} title="Print barcode"><Printer size={13} /></IconButton>
                      )}
                      {!p._is_client_label && !p._source && (
                        <IconButton onClick={() => setAttachModal(p)} title={`Attachments${p.attachment_count > 0 ? ` (${p.attachment_count})` : ''}`} style={{ position: 'relative' }}>
                          <Paperclip size={13} />
                          {p.attachment_count > 0 && (
                            <span style={{ position: 'absolute', top: -3, right: -3, background: 'var(--accent)', color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 10, minWidth: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
                              {p.attachment_count > 9 ? '9+' : p.attachment_count}
                            </span>
                          )}
                        </IconButton>
                      )}
                      {!p._is_client_label && (
                        <IconButton onClick={() => openHistory(p)} title="History"><History size={13} /></IconButton>
                      )}
                      {!p._is_client_label && !p._source && p.archived && (
                        <IconButton className="icon-btn-text" onClick={() => handleRestoreProduct(p)} title="Restore product">Restore</IconButton>
                      )}
                      {!p._is_client_label && !p._source && !p.archived && (
                        <IconButton variant="danger" onClick={() => setDeleteTarget(p)} title="Archive product"><Trash2 size={13} /></IconButton>
                      )}
                      {p._is_client_label && (
                        <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', fontStyle: 'italic' }}>client label</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {displayed.length} {isClientStock ? 'item' : 'product'}{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Action Modal */}
      {actionModal && (
        <div className="modal-overlay" onClick={() => { setActionModal(null); setLabelPhoto(null) }}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Adjust Stock</h2>
              <button className="modal-close" onClick={() => { setActionModal(null); setLabelPhoto(null) }}><X size={14} /></button>
            </div>

            <div className="modal-body">

            {/* Add / Remove toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {[['add', '+ Add'], ['remove', '− Remove']].map(([t, l]) => (
                <button key={t} onClick={() => { setActionModal(m => ({ ...m, type: t })); setQty('') }}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', border: `1px solid ${actionModal.type === t ? (t === 'add' ? 'rgba(34,197,94,0.5)' : 'rgba(220,38,38,0.5)') : 'rgba(255,255,255,0.1)'}`, background: actionModal.type === t ? (t === 'add' ? 'rgba(34,197,94,0.15)' : 'rgba(220,38,38,0.12)') : 'rgba(255,255,255,0.04)', color: actionModal.type === t ? (t === 'add' ? '#4ade80' : '#f87171') : 'rgba(232,234,242,0.4)' }}>
                  {l}
                </button>
              ))}
            </div>

            <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{actionModal.product.name}</div>
              {actionModal.product.client_name && (
                <div style={{ fontSize: 11, color: '#a78bfa', marginTop: 1 }}>{actionModal.product.client_name}</div>
              )}
              <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)', marginTop: 2 }}>
                Current: <strong style={{ color: stockColor(actionModal.product.current_stock, actionModal.product.min_stock_level || 0) }}>
                  {formatStock(actionModal.product.current_stock, actionModal.product.unit)}
                </strong>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>
                Quantity ({actionModal.product.unit === 'ml' ? 'ml / L' : actionModal.product.unit})
              </label>
              <input
                type="number" value={qty} onChange={e => setQty(e.target.value)}
                autoFocus min="0" step="any" placeholder="0"
                style={inputStyle}
              />
              <MlHint value={qty} unit={actionModal.product.unit} />
            </div>

            <div style={{ marginBottom: actionModal.type === 'add' && actionModal.product.category === 'LABEL' ? 14 : 20 }}>
              <label style={labelStyle}>Notes (optional)</label>
              <input
                value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Reason, PO number, batch..."
                style={inputStyle}
              />
            </div>

            {actionModal.type === 'add' && actionModal.product.category === 'LABEL' && (
              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>Label Photo (optional)</label>
                <input ref={labelPhotoRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={e => handleLabelPhoto(e.target.files[0])} />
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  {labelPhoto ? (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={labelPhoto} alt="Label" style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                      <button onClick={() => setLabelPhoto(null)} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#dc2626', border: 'none', color: 'white', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                    </div>
                  ) : (
                    <div style={{ width: 64, height: 64, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '2px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <ImageIcon size={18} color="rgba(232,234,242,0.2)" />
                    </div>
                  )}
                  <div>
                    <button onClick={() => labelPhotoRef.current?.click()} style={{ background: 'rgba(244,114,182,0.1)', border: '1px solid rgba(244,114,182,0.25)', borderRadius: 7, padding: '7px 14px', color: '#f472b6', fontSize: 12, cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ImageIcon size={12} /> {labelPhoto ? 'Change Photo' : 'Add Photo'}
                    </button>
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', marginTop: 4 }}>Updates the product photo</div>
                  </div>
                </div>
              </div>
            )}

            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setActionModal(null); setLabelPhoto(null) }}>Cancel</button>
              <button className={actionModal.type === 'add' ? 'btn btn-primary' : 'btn btn-danger'} onClick={handleAction} disabled={saving}>
                {saving ? 'Saving...' : actionModal.type === 'add' ? '+ Add Stock' : '− Remove Stock'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyModal && (
        <div className="modal-overlay" onClick={() => setHistoryModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Stock History</h2>
                <p>
                  {historyModal.name}
                  {historyModal.client_name && <span style={{ color: '#a78bfa', marginLeft: 6 }}>— {historyModal.client_name}</span>}
                </p>
              </div>
              <button className="modal-close" onClick={() => setHistoryModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              {history.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13, padding: 24 }}>No transactions yet</div>
              ) : history.map(t => {
                const isAdd = ['add', 'received', 'po_received', 'ready_formula_in', 'return'].includes(t.type)
                const isSub = ['remove', 'production_debit', 'ready_formula_used'].includes(t.type)
                const balanceBefore = (t.balance_after != null)
                  ? Math.max(0, parseFloat(t.balance_after) + (isAdd ? -parseFloat(t.quantity) : parseFloat(t.quantity)))
                  : null
                return (
                <div key={t.id} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        background: `${TYPE_COLORS[t.type] || '#60a5fa'}20`, color: TYPE_COLORS[t.type] || '#60a5fa',
                        padding: '1px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700
                      }}>{t.type.replace(/_/g, ' ')}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: isAdd ? '#4ade80' : '#f87171' }}>
                        {isAdd ? '+' : isSub ? '-' : ''}
                        {Number(t.quantity).toLocaleString()} {t.unit}
                      </span>
                    </div>
                    {t.notes && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 3 }}>{t.notes}</div>}
                    {t.user_name && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', marginTop: 1 }}>by {t.user_name}</div>}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
                    {t.balance_after != null && (
                      <div style={{ fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
                        {balanceBefore != null && (
                          <>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                              {Number(balanceBefore).toLocaleString()} {t.unit}
                            </span>
                            <span style={{ color: 'var(--text-dim)', margin: '0 5px' }}>→</span>
                          </>
                        )}
                        <span style={{ color: 'var(--text-primary)' }}>{Number(t.balance_after).toLocaleString()} {t.unit}</span>
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginTop: 3 }}>{fmtDT(t.created_at)}</div>
                  </div>
                </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Image zoom lightbox */}
      {zoomImage && (
        <div onClick={() => setZoomImage(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, cursor: 'zoom-out' }}>
          <img src={zoomImage} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, objectFit: 'contain', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
        </div>
      )}

      {/* Create / Edit Product Modal */}
      {productModal && (
        <ProductFormModal
          mode={productModal === 'create' ? 'create' : 'edit'}
          form={productForm}
          setForm={setProductForm}
          saving={productSaving}
          onClose={() => setProductModal(null)}
          onSave={handleSaveProduct}
          allProducts={allProducts}
        />
      )}

      {/* Barcode Print Modal */}
      {barcodeTarget && (
        <div className="modal-overlay" onClick={() => setBarcodeTarget(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Print Barcode</h2>
                <p style={{ color: '#10b981' }}>{barcodeTarget.name}</p>
              </div>
              <button className="modal-close" onClick={() => setBarcodeTarget(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ background: '#fff', borderRadius: 8, padding: '16px 12px', marginBottom: 18, textAlign: 'center' }}>
                <BarcodePreview value={barcodeTarget.barcode || barcodeTarget.product_code} />
                <div style={{ fontSize: 10, color: '#666', marginTop: 4, fontFamily: 'monospace' }}>{barcodeTarget.product_code}</div>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Barcode Value (CODE128)</div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#e8eaf2', fontWeight: 700 }}>{barcodeTarget.barcode || barcodeTarget.product_code}</div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label className="label" style={{ margin: 0 }}>Copies</label>
                <input type="number" min={1} max={100} value={barcodeCopies} onChange={e => setBarcodeCopies(e.target.value)}
                  className="input" style={{ width: 80, textAlign: 'center' }}
                />
                <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>labels per sheet</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setBarcodeTarget(null)}>Cancel</button>
              <button onClick={printBarcode} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Printer size={14} /> Print {barcodeCopies > 1 ? `${barcodeCopies} Labels` : 'Label'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Attachments Modal */}
      {attachModal && (
        <AttachmentsModal product={attachModal} onClose={() => { setAttachModal(null); loadProducts() }} />
      )}

      {/* Archive / Permanent delete */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Archive product?</h2>
              <button className="modal-close" onClick={() => setDeleteTarget(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.75)', marginBottom: 12 }}>
                <strong>{deleteTarget.name}</strong> ({deleteTarget.product_code}) will be archived.
              </p>
              <p style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', margin: 0, lineHeight: 1.5 }}>
                Archived products are hidden from the main list but keep their history (transactions, reservations, orders). Toggle <strong>"Show Archived"</strong> in the filters to restore later.
              </p>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
              <button onClick={handleDeletePermanently} title="Only works if product has no stock or history" style={{ background: 'rgba(127,29,29,0.15)', border: '1px solid rgba(127,29,29,0.4)', color: '#f87171', padding: '8px 14px', borderRadius: 8, fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                Delete permanently
              </button>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleArchiveProduct}>Archive</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BarcodePreview({ value }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', lineColor: '#000', background: '#fff',
        width: 2, height: 56, displayValue: true, font: 'monospace', fontSize: 12, margin: 6,
      })
    } catch { ref.current.innerHTML = '' }
  }, [value])
  return <svg ref={ref} style={{ maxWidth: '100%' }} />
}

function BarcodeTag({ value }) {
  const ref = useRef(null)
  const ink = useInkColor()
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', width: 1.1, height: 24,
        displayValue: false, margin: 0,
        background: 'transparent', lineColor: ink,
      })
    } catch { ref.current.innerHTML = '' }
  }, [value, ink])
  return <svg ref={ref} style={{ maxWidth: 110 }} />
}

const TYPE_COLORS = {
  add: '#4ade80', remove: '#f87171', adjust: '#60a5fa',
  received: '#34d399',
  production_debit: '#f472b6', po_received: '#34d399',
  ready_formula_in: '#fb923c', ready_formula_used: '#fbbf24',
  stock_reserved: '#a78bfa', return: '#a78bfa'
}

function ActionBtn({ label, onClick }) {
  return <button onClick={onClick} className="icon-btn icon-btn-text">{label}</button>
}

const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }
const inputStyle = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none' }
