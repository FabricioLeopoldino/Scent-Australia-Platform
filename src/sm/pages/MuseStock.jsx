import { useState, useEffect, useRef } from 'react'
import { Star, TrendingUp, TrendingDown, Search, Plus, Minus, ImageIcon, Paperclip, X, Printer, Package, Trash2, Edit2, ExternalLink } from 'lucide-react'
import axios from 'axios'
import JsBarcode from 'jsbarcode'
import { useInkColor } from '../utils/theme.js'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import { useToast } from '../SMModule.jsx'
import AttachmentsModal from '../components/AttachmentsModal.jsx'
import MlHint from '../components/MlHint.jsx'
import { splitVolume } from '../utils/volume.js'
import ProductFormModal, { EMPTY_PRODUCT_FORM, ALL_PROD_CATEGORIES, PRODUCT_SEGMENTS } from '../components/ProductFormModal.jsx'
import StockTable from '../components/StockTable.jsx'
import MuseHeader from '../components/MuseHeader.jsx'

const MUSE_COMP_CATEGORIES = ['COMPONENT', 'LABEL', 'RAW_MATERIAL', 'FRAGRANCE', 'DIFFUSER']

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

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

export default function MuseStock() {
  const [variants, setVariants] = useState([])
  const [masters, setMasters]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [masterFilter, setMasterFilter] = useState('ALL') // master.product_code or 'ALL'
  const [adjModal, setAdjModal] = useState(null) // { variant, mode }
  const [adjQty, setAdjQty]     = useState('')
  const [adjNotes, setAdjNotes] = useState('')
  const [saving, setSaving]     = useState(false)
  const [photoModal, setPhotoModal] = useState(null)        // { variant } — full-size view
  const [imageUploadVariant, setImageUploadVariant] = useState(null)  // variant whose image is being changed
  const [imageSaving, setImageSaving] = useState(false)
  const [attachModal, setAttachModal] = useState(null)      // variant for attachments modal
  const [barcodeTarget, setBarcodeTarget] = useState(null)  // variant whose barcode is being printed
  const [barcodeCopies, setBarcodeCopies] = useState(1)
  const [tab, setTab] = useState('all')               // all | finished | components | fragrance | raw | labels
  const [inProduction, setInProduction] = useState({})       // master_id-fragrance_id → qty
  const [components, setComponents] = useState([])          // MUSE COMPONENT/LABEL/RAW_MATERIAL products
  const [allProducts, setAllProducts] = useState([])        // full list — for unique code suggestion
  const [prodModal, setProdModal] = useState(null)          // null | 'create' | { editing }
  const [prodForm, setProdForm] = useState(EMPTY_PRODUCT_FORM)
  const [prodSaving, setProdSaving] = useState(false)
  const [editVariantModal, setEditVariantModal] = useState(null) // { variant }
  const [editVariantForm, setEditVariantForm] = useState({ name: '', min_stock_level: '', notes: '' })
  const [editVariantSaving, setEditVariantSaving] = useState(false)
  const [shopifyModal, setShopifyModal] = useState(null) // variant
  const [publishing, setPublishing] = useState(false)
  const imageFileRef = useRef(null)
  const { addToast } = useToast()

  async function loadComponents() {
    try {
      const r = await axios.get('/api/products', api())
      setAllProducts(r.data)
      // MUSE-owned components + Shared items. SM-only components live in /sm-stock.
      setComponents(r.data.filter(p => MUSE_COMP_CATEGORIES.includes(p.category) && !p.is_master && (p.category === 'FRAGRANCE' || p.segment === 'MUSE' || p.segment === 'SHARED')))
    } catch { /* silent */ }
  }

  function openCreateProduct() {
    const startCat = tab === 'labels' ? 'LABEL' : tab === 'raw' ? 'RAW_MATERIAL' : tab === 'fragrance' ? 'FRAGRANCE' : tab === 'diffusers' ? 'DIFFUSER' : 'COMPONENT'
    setProdForm({ ...EMPTY_PRODUCT_FORM, category: startCat, segment: 'MUSE' })
    setProdModal('create')
  }

  function openEditProduct(p) {
    setProdForm({
      name: p.name || '', product_code: p.product_code || '',
      category: p.category || 'COMPONENT', sub_category: p.sub_category || '',
      segment: p.segment || 'MUSE',
      unit: p.unit || 'units',
      current_stock: String(p.current_stock ?? 0),
      min_stock_level: String(p.min_stock_level ?? 0),
      supplier: p.supplier || '', supplier_code: p.supplier_code || '',
      bin_location: p.bin_location || '', barcode: p.barcode || '',
      lead_time: p.lead_time != null ? String(p.lead_time) : '',
      notes: p.notes || '', image_data: p.image_data || '',
      volume_ml: p.volume_ml != null ? String(p.volume_ml) : '',
      default_oil_pct: p.default_oil_pct != null ? String(p.default_oil_pct) : '',
      price: p.price != null ? String(p.price) : '', description: p.description || '',
    })
    setProdModal({ editing: p })
  }

  async function handleSaveProduct() {
    if (!prodForm.name.trim() || !prodForm.product_code.trim()) {
      addToast('Name and product code required', 'error'); return
    }
    setProdSaving(true)
    try {
      const payload = {
        name: prodForm.name.trim(),
        product_code: prodForm.product_code.trim().toUpperCase(),
        category: prodForm.category,
        segment: prodForm.segment || 'MUSE',
        sub_category: prodForm.sub_category?.trim() || null,
        unit: prodForm.unit || 'units',
        min_stock_level: parseFloat(prodForm.min_stock_level) || 0,
        supplier: prodForm.supplier?.trim() || null,
        supplier_code: prodForm.supplier_code?.trim() || null,
        bin_location: prodForm.bin_location?.trim() || null,
        barcode: prodForm.barcode?.trim() || null,
        lead_time: prodForm.lead_time ? parseInt(prodForm.lead_time) : null,
        notes: prodForm.notes?.trim() || null,
        image_data: prodForm.image_data || null,
        price: prodForm.price !== '' ? parseFloat(prodForm.price) : null,
        description: prodForm.description?.trim() || null,
      }
      if (prodModal === 'create' && prodForm.segment === 'MAJOR' && prodForm.client_id) {
        // Major segment → routes to the client's Reserved Stock (client_stock table).
        await axios.post(`/api/clients/${prodForm.client_id}/stock/receive`, {
          product_code: payload.product_code,
          product_name: payload.name,
          category: payload.category,
          barcode: payload.barcode,
          unit: payload.unit,
          quantity: parseFloat(prodForm.current_stock) || 0,
          notes: payload.notes,
          image_data: payload.image_data,
        }, api())
        addToast(`"${prodForm.name}" added to Reserved Stock`)
      } else if (prodModal === 'create') {
        payload.current_stock = parseFloat(prodForm.current_stock) || 0
        await axios.post('/api/products', payload, api())
        addToast(`"${prodForm.name}" created`)
      } else {
        await axios.put(`/api/products/${prodModal.editing.id}`, payload, api())
        addToast('Product updated')
      }
      setProdModal(null)
      setProdForm(EMPTY_PRODUCT_FORM)
      loadComponents()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setProdSaving(false) }
  }

  async function handleDeleteProduct(p) {
    if (!confirm(`Archive "${p.name}"?\n\nThe product will be hidden but its history is preserved. Restore later from Stock Management.`)) return
    try {
      await axios.delete(`/api/products/${p.id}`, api())
      addToast(`"${p.name}" archived`)
      loadComponents()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleRestoreProduct(p) {
    try {
      await axios.post(`/api/products/${p.id}/restore`, {}, api())
      addToast(`"${p.name}" restored`)
      loadComponents()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleEditVariant() {
    if (!editVariantForm.name.trim()) { addToast('Name is required', 'error'); return }
    setEditVariantSaving(true)
    try {
      await axios.put(`/api/products/${editVariantModal.variant.id}`, {
        name: editVariantForm.name.trim(),
        min_stock_level: parseFloat(editVariantForm.min_stock_level) || 0,
        notes: editVariantForm.notes?.trim() || null,
      }, api())
      addToast('Variant updated')
      setEditVariantModal(null)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setEditVariantSaving(false) }
  }

  function printBarcode() {
    if (!barcodeTarget) return
    const code = barcodeTarget.barcode || barcodeTarget.sku || barcodeTarget.product_code
    if (!code) return
    const copies = Math.max(1, Math.min(parseInt(barcodeCopies) || 1, 100))
    const win = window.open('', '_blank', 'width=600,height=500')
    const tmpSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    JsBarcode(tmpSvg, code, {
      format: 'CODE128', lineColor: '#000', background: '#fff',
      width: 2, height: 60, displayValue: true, font: 'monospace', fontSize: 11, margin: 8,
    })
    const svgStr = tmpSvg.outerHTML
    const containerLine = barcodeTarget.container_name
      ? barcodeTarget.container_name + (barcodeTarget.volume_ml ? ` · ${barcodeTarget.volume_ml}${barcodeTarget.volume_unit || 'ml'}` : '')
      : ''
    const labels = Array.from({ length: copies }, () => `
      <div class="label">
        <div class="name">${barcodeTarget.name}</div>
        ${containerLine ? `<div class="container">${containerLine}</div>` : ''}
        ${svgStr}
        <div class="code">${barcodeTarget.sku || barcodeTarget.product_code || ''}</div>
      </div>`).join('')
    win.document.write(`<!DOCTYPE html><html><head><title>Barcode — ${barcodeTarget.name}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: monospace; background: #fff; padding: 12px; }
        .grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .label { border: 1px dashed #ccc; border-radius: 4px; padding: 8px 12px;
                 text-align: center; width: 200px; page-break-inside: avoid; }
        .name { font-size: 11px; font-weight: bold; margin-bottom: 2px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .container { font-size: 9px; color: #888; margin-bottom: 4px;
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

  useEffect(() => { load(); loadComponents() }, [])

  async function load() {
    setLoading(true)
    try {
      const [prodRes, mastersRes, inProdRes] = await Promise.all([
        axios.get('/api/products', { ...api(), params: { category: 'FINISHED_GOOD' } }),
        axios.get('/api/masters', { ...api(), params: { segment: 'MUSE' } }),
        axios.get('/api/muse/in-production', api()),
      ])
      // Filter: only MUSE variants (master_product_id set, segment=MUSE, no client)
      const onlyVariants = prodRes.data.filter(p =>
        p.segment === 'MUSE' && p.master_product_id && !p.client_id && !p.archived
      )
      setVariants(onlyVariants)
      setMasters(mastersRes.data)
      // Map in-production qty by master_id|fragrance_id
      const ip = {}
      inProdRes.data.forEach(r => { ip[`${r.master_id}-${r.fragrance_id}`] = parseFloat(r.qty) || 0 })
      setInProduction(ip)
    } catch { addToast('Failed to load MUSE stock', 'error') }
    finally { setLoading(false) }
  }

  async function handleImageUpload(variant, file) {
    if (!file) return
    if (!file.type.startsWith('image/')) { addToast('Only image files allowed', 'error'); return }
    if (file.size > 10 * 1024 * 1024) { addToast('Image exceeds 10MB limit', 'error'); return }
    setImageSaving(true)
    try {
      const dataUrl = await resizeImageFile(file)
      await axios.patch(`/api/products/${variant.id}/image`, { image_data: dataUrl }, api())
      addToast('Image updated')
      setImageUploadVariant(null)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Upload failed', 'error') }
    finally { setImageSaving(false) }
  }

  async function handleImageRemove(variant) {
    if (!confirm('Remove image from this variant?')) return
    try {
      await axios.patch(`/api/products/${variant.id}/image`, { image_data: null }, api())
      addToast('Image removed')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleAdj() {
    const qty = parseFloat(adjQty)
    if (!qty || qty <= 0) { addToast('Enter a valid quantity', 'error'); return }
    setSaving(true)
    try {
      const endpoint = adjModal.mode === 'add' ? '/api/stock/add' : '/api/stock/remove'
      await axios.post(endpoint, { product_id: adjModal.variant.id, quantity: qty, notes: adjNotes || undefined }, api())
      addToast(`Stock ${adjModal.mode === 'add' ? 'added' : 'removed'}`)
      setAdjModal(null); setAdjQty(''); setAdjNotes('')
      load(); loadComponents()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  async function handlePublishToShopify() {
    if (!shopifyModal) return
    setPublishing(true)
    try {
      await axios.post(`/api/products/${shopifyModal.id}/shopify/publish`, {}, api())
      addToast(`"${shopifyModal.name}" published to Shopify as draft`)
      setShopifyModal(null)
      load(); loadComponents()
    } catch (e) { addToast(e.response?.data?.error || 'Shopify publish failed', 'error') }
    finally { setPublishing(false) }
  }

  // Enhance variants with master/fragrance names from masters list
  const masterById = {}
  masters.forEach(m => { masterById[m.id] = m })
  // Fragrance lookup (for supplier code) — derived from the full products list
  const fragById = {}
  allProducts.forEach(p => { if (p.category === 'FRAGRANCE') fragById[p.id] = p })
  const enriched = variants.map(v => {
    const master = masterById[v.master_product_id]
    const frag = fragById[v.fragrance_id]
    return {
      ...v,
      master_name: master?.name || '(unknown master)',
      master_code: master?.product_code,
      container_name: v.container_name || master?.container_name,
      volume_ml: v.volume_ml ?? master?.volume_ml,
      volume_unit: v.volume_unit || master?.volume_unit,
      oil_pct: master?.default_oil_pct,
      is_pure_oil: v.is_pure_oil ?? master?.is_pure_oil,
      is_candle: v.is_candle ?? master?.is_candle,
      frag_name: frag?.name || null,           // real fragrance name from the products table
      frag_supplier_code: frag?.supplier_code || null,
    }
  })

  // Filter
  const displayed = enriched.filter(v => {
    if (masterFilter !== 'ALL' && v.master_code !== masterFilter) return false
    if (!search) return true
    const s = search.toLowerCase()
    return v.name.toLowerCase().includes(s) || v.product_code.toLowerCase().includes(s)
  })

  const totalUnits = enriched.reduce((s, v) => s + parseFloat(v.current_stock || 0), 0)
  const lowCount   = enriched.filter(v => parseFloat(v.current_stock) < parseFloat(v.min_stock_level || 0)).length

  return (
    <div style={{ padding: 28 }}>
      <MuseHeader subtitle="Stock" />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Star size={20} color="#fbbf24" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>MUSE Stock</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Finished goods, components and materials for MUSE</p>
          </div>
        </div>
        {tab !== 'finished' && (
          <Button onClick={openCreateProduct}>
            <Plus size={15} /> New Product
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 18, borderBottom: '1px solid rgba(255,255,255,0.08)', overflowX: 'auto' }}>
        {[
          { key: 'all',        label: 'All',           count: components.length + variants.length },
          { key: 'finished',   label: 'Finished Goods', count: variants.length },
          { key: 'components', label: 'Components',    count: components.filter(c => c.category === 'COMPONENT').length },
          { key: 'fragrance',  label: 'Fragrances',    count: components.filter(c => c.category === 'FRAGRANCE').length },
          { key: 'raw',        label: 'Raw Materials', count: components.filter(c => c.category === 'RAW_MATERIAL').length },
          { key: 'labels',     label: 'Labels',        count: components.filter(c => c.category === 'LABEL').length },
          { key: 'diffusers',  label: 'Diffusers',     count: components.filter(c => c.category === 'DIFFUSER').length },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 'none',
            borderBottom: tab === t.key ? '2px solid #fbbf24' : '2px solid transparent',
            color: tab === t.key ? '#fbbf24' : 'rgba(232,234,242,0.5)',
            padding: '10px 16px', fontSize: 13, fontWeight: tab === t.key ? 700 : 500, cursor: 'pointer',
          }}>
            {t.label}
            {t.count > 0 && <span style={{ background: tab === t.key ? 'rgba(251,191,36,0.25)' : 'rgba(255,255,255,0.08)', color: tab === t.key ? '#fbbf24' : 'rgba(232,234,242,0.4)', padding: '0 6px', borderRadius: 10, fontSize: 10, fontWeight: 700, marginLeft: 6 }}>{t.count}</span>}
          </button>
        ))}
      </div>

      {tab !== 'finished' && (
        <ComponentList
          items={
            tab === 'all'        ? components :
            tab === 'components' ? components.filter(c => c.category === 'COMPONENT') :
            tab === 'fragrance'  ? components.filter(c => c.category === 'FRAGRANCE') :
            tab === 'labels'     ? components.filter(c => c.category === 'LABEL') :
            tab === 'diffusers'  ? components.filter(c => c.category === 'DIFFUSER') :
                                   components.filter(c => c.category === 'RAW_MATERIAL')
          }
          onAdjust={(p, mode) => { setAdjModal({ variant: p, mode }); setAdjQty(''); setAdjNotes('') }}
          onEdit={openEditProduct}
          onDelete={handleDeleteProduct}
          onRestore={handleRestoreProduct}
          onZoom={img => setPhotoModal({ image_data: img, name: '' })}
          onPrint={p => { setBarcodeTarget(p); setBarcodeCopies(1) }}
          onShopify={tab === 'diffusers' ? (p => setShopifyModal(p)) : undefined}
        />
      )}

      {tab === 'finished' && <>
      {/* Summary stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24, maxWidth: 760 }}>
        {[
          { label: 'Masters', value: masters.length, color: '#a78bfa' },
          { label: 'Variants', value: enriched.length, color: '#fbbf24' },
          { label: 'Total Units', value: Number(totalUnits.toFixed(0)).toLocaleString(), color: '#60a5fa' },
          { label: 'Low Stock', value: lowCount, color: lowCount > 0 ? '#f87171' : '#4ade80' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>{s.label}</div>
            <div className="kpi-num" style={{ fontSize: 30 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Master filter chips */}
      {masters.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="eyebrow" style={{ marginRight: 4 }}>Master</span>
          <button onClick={() => setMasterFilter('ALL')} style={{
            background: masterFilter === 'ALL' ? 'var(--accent-soft)' : 'var(--surface-2)',
            border: masterFilter === 'ALL' ? '1px solid var(--border-h)' : '1px solid var(--border)',
            borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            color: masterFilter === 'ALL' ? 'var(--accent-text)' : 'var(--text-secondary)',
          }}>All</button>
          {masters.map(m => (
            <button key={m.id} onClick={() => setMasterFilter(m.product_code)} style={{
              background: masterFilter === m.product_code ? 'var(--accent-soft)' : 'var(--surface-2)',
              border: masterFilter === m.product_code ? '1px solid var(--border-h)' : '1px solid var(--border)',
              borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              color: masterFilter === m.product_code ? 'var(--accent-text)' : 'var(--text-secondary)',
            }}>{m.name}</button>
          ))}
        </div>
      )}

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search variants..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <Star size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>{masters.length === 0 ? 'No MUSE Masters yet' : 'No variants yet'}</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>
            {masters.length === 0
              ? 'Create your first MUSE Master in Products, attach fragrances, and variants will be generated automatically.'
              : 'Run a MUSE production order — variants are auto-created when production completes.'}
          </div>
        </div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['', 'Master', 'Container', 'Fragrance', 'SKU', 'Barcode', 'Stock', 'In Production', 'Status', 'Actions'].map((h, i) => (
                  <th key={i} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(v => {
                const stock  = parseFloat(v.current_stock || 0)
                const minLvl = parseFloat(v.min_stock_level || 0)
                const isLow  = stock < minLvl
                const isEmpty = stock <= 0
                return (
                  <tr key={v.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 16px', width: 60 }}>
                      {v.image_data ? (
                        <img src={v.image_data} alt={v.name} onClick={() => setPhotoModal(v)}
                          style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.1)' }}
                        />
                      ) : (
                        <button onClick={() => setImageUploadVariant(v)} title="Add image"
                          style={{ width: 44, height: 44, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(232,234,242,0.35)' }}>
                          <ImageIcon size={16} />
                        </button>
                      )}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{v.name || v.master_name}</div>
                      {v.name && v.name !== v.master_name && (
                        <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', marginTop: 2 }}>{v.master_name}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {v.container_name
                        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                              {v.container_name}{v.volume_ml ? ` · ${v.volume_ml}${v.volume_unit || 'ml'}` : ''}
                            </span>
                            <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>
                              {v.is_pure_oil ? '100% pure oil'
                                : v.is_candle ? `${v.oil_pct ?? 12}% oil (candle)`
                                : v.oil_pct != null ? `${v.oil_pct}% oil + ${100 - v.oil_pct}% ethanol` : '—'}
                            </span>
                          </div>
                        : <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {v.frag_name
                        ? <div style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa' }}>{v.frag_name}</div>
                        : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', fontStyle: 'italic' }}>—</span>}
                      {v.frag_supplier_code && (
                        <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', marginTop: 2 }}>{v.frag_supplier_code}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {v.sku
                        ? <span style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', fontFamily: 'monospace' }}>{v.sku}</span>
                        : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', fontStyle: 'italic' }}>— no SKU —</span>}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {(v.barcode || v.sku)
                        ? <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <BarcodeTag value={v.barcode || v.sku} />
                              <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{v.barcode || v.sku}</span>
                            </div>
                            <IconButton onClick={() => { setBarcodeTarget(v); setBarcodeCopies(1) }} title="Print barcode"><Printer size={13} /></IconButton>
                          </div>
                        : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', fontStyle: 'italic' }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {(() => {
                        const s = splitVolume(stock, v.unit)
                        return <>
                          <span style={{ fontSize: 14, fontWeight: 700, color: isEmpty ? '#f87171' : isLow ? '#fbbf24' : '#4ade80' }}>{s.value}</span>
                          <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginLeft: 4 }}>{s.unit}</span>
                        </>
                      })()}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {(() => {
                        const ip = inProduction[`${v.master_product_id}-${v.fragrance_id}`] || 0
                        return ip > 0
                          ? <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>{Number(ip).toLocaleString()} <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontWeight: 500 }}>{v.unit}</span></span>
                          : <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)' }}>—</span>
                      })()}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {isEmpty
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color: '#f87171' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f87171', flexShrink: 0 }} />Out of stock</span>
                        : isLow
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color: '#fbbf24' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fbbf24', flexShrink: 0 }} />Low stock</span>
                        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color: '#4ade80' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', flexShrink: 0 }} />In stock</span>
                      }
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <IconButton className="icon-btn-text" onClick={() => { setAdjModal({ variant: v, mode: 'add' }); setAdjQty(''); setAdjNotes('') }} title="Add stock"><Plus size={13} /> Add</IconButton>
                        <IconButton variant="danger" className="icon-btn-text" onClick={() => { setAdjModal({ variant: v, mode: 'remove' }); setAdjQty(''); setAdjNotes('') }} title="Remove stock"><Minus size={13} /> Remove</IconButton>
                        <IconButton onClick={() => { setEditVariantModal({ variant: v }); setEditVariantForm({ name: v.name || '', min_stock_level: String(v.min_stock_level ?? 0), notes: v.notes || '' }) }} title="Edit variant name / min stock"><Edit2 size={13} /></IconButton>
                        <IconButton onClick={() => setShopifyModal(v)} title="Publish to Shopify"><ExternalLink size={13} /></IconButton>
                        <IconButton onClick={() => setImageUploadVariant(v)} title={v.image_data ? 'Change image' : 'Upload image'}><ImageIcon size={13} /></IconButton>
                        <button onClick={() => setAttachModal(v)} title={`Attachments${v.attachment_count > 0 ? ` (${v.attachment_count})` : ''}`}
                          style={{ position: 'relative', background: v.attachment_count > 0 ? 'rgba(96,165,250,0.18)' : 'rgba(96,165,250,0.1)', border: `1px solid ${v.attachment_count > 0 ? 'rgba(96,165,250,0.45)' : 'rgba(96,165,250,0.2)'}`, borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: '#60a5fa', display: 'flex', alignItems: 'center' }}>
                          <Paperclip size={12} />
                          {v.attachment_count > 0 && (
                            <span style={{ position: 'absolute', top: -5, right: -5, background: '#60a5fa', color: 'white', fontSize: 9, fontWeight: 700, borderRadius: 10, minWidth: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
                              {v.attachment_count > 9 ? '9+' : v.attachment_count}
                            </span>
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {displayed.length} variant{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
      </>}

      {/* Edit Variant Modal */}
      {editVariantModal && (
        <div className="modal-overlay" onClick={() => setEditVariantModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Edit Variant</h2>
                <p style={{ color: 'var(--accent-text)' }}>{editVariantModal.variant.master_name}</p>
              </div>
              <button className="modal-close" onClick={() => setEditVariantModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Display Name *</label>
                <input value={editVariantForm.name} onChange={e => setEditVariantForm(f => ({ ...f, name: e.target.value }))} autoFocus className="input" placeholder="e.g. Rose & Oud Reed Diffuser 200ml" />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>Override the auto-generated master name to give this variant its own identity.</div>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Min Stock Level ({editVariantModal.variant.unit})</label>
                <input type="number" min={0} step="any" value={editVariantForm.min_stock_level} onChange={e => setEditVariantForm(f => ({ ...f, min_stock_level: e.target.value }))} className="input" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Notes</label>
                <input value={editVariantForm.notes} onChange={e => setEditVariantForm(f => ({ ...f, notes: e.target.value }))} className="input" placeholder="Optional notes..." />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEditVariantModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleEditVariant} disabled={editVariantSaving}>
                {editVariantSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shopify Publish Modal */}
      {shopifyModal && (
        <div className="modal-overlay" onClick={() => setShopifyModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ExternalLink size={16} color="var(--accent-text)" /> Publish to Shopify
                </h2>
                <p>{shopifyModal.name}</p>
              </div>
              <button className="modal-close" onClick={() => setShopifyModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
                {[
                  { label: 'Product Name', value: shopifyModal.name },
                  { label: 'SKU', value: shopifyModal.sku || shopifyModal.product_code || '—' },
                  { label: 'Barcode', value: shopifyModal.barcode || shopifyModal.sku || '—' },
                  { label: 'Price', value: shopifyModal.price != null ? `$${Number(shopifyModal.price).toFixed(2)} AUD` : 'Not set yet' },
                  { label: 'Stock', value: `${Number(shopifyModal.current_stock || 0).toLocaleString()} ${shopifyModal.unit}` },
                  { label: 'Status', value: parseFloat(shopifyModal.current_stock) > 0 ? 'In Stock' : 'Out of Stock' },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: label === 'SKU' || label === 'Barcode' ? 'monospace' : 'inherit' }}>{value}</span>
                  </div>
                ))}
                {shopifyModal.description && (
                  <div style={{ padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>Description</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{shopifyModal.description}</div>
                  </div>
                )}
              </div>
              {shopifyModal.shopify_product_id ? (
                <div style={{ padding: '12px 14px', background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: 8, fontSize: 12, color: '#4ade80', lineHeight: 1.6 }}>
                  <strong>Synced to Shopify.</strong> Created as a draft product. Stock changes in this system will push to Shopify automatically.
                </div>
              ) : (
                <div style={{ padding: '12px 14px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 8, fontSize: 12, color: '#fbbf24', lineHeight: 1.6 }}>
                  Creates this product on Shopify as a <strong>draft</strong> (not visible on the storefront). Stock stays synced from this system going forward.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShopifyModal(null)}>Close</button>
              {!shopifyModal.shopify_product_id && (
                <button className="btn btn-primary" onClick={handlePublishToShopify} disabled={publishing}>
                  <ExternalLink size={13} /> {publishing ? 'Publishing...' : 'Publish to Shopify'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Product Modal */}
      {prodModal && (
        <ProductFormModal
          mode={prodModal === 'create' ? 'create' : 'edit'}
          form={prodForm}
          setForm={setProdForm}
          saving={prodSaving}
          onClose={() => setProdModal(null)}
          onSave={handleSaveProduct}
          allProducts={allProducts}
          categories={ALL_PROD_CATEGORIES.filter(c => MUSE_COMP_CATEGORIES.includes(c.key))}
          // This page owns MUSE stock only — creating Standard or Major-client
          // reserved stock from here was possible but never the intent.
          segments={PRODUCT_SEGMENTS.filter(s => ['MUSE', 'SHARED'].includes(s.key))}
        />
      )}

      {/* Stock Adjustment Modal */}
      {adjModal && (
        <div className="modal-overlay" onClick={() => setAdjModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>{adjModal.mode === 'add' ? 'Add Stock' : 'Remove Stock'}</h2>
                <p style={{ color: '#a78bfa' }}>{adjModal.variant.name}</p>
              </div>
              <button className="modal-close" onClick={() => setAdjModal(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="label">Quantity ({adjModal.variant.unit}) *</label>
                <input type="number" min={0.01} step="any" value={adjQty} onChange={e => setAdjQty(e.target.value)} autoFocus placeholder="0" className="input" />
                <MlHint value={adjQty} unit={adjModal.variant.unit} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Notes</label>
                <input value={adjNotes} onChange={e => setAdjNotes(e.target.value)} placeholder="Optional reason..." className="input" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setAdjModal(null)}>Cancel</button>
              <button onClick={handleAdj} disabled={saving} className={adjModal.mode === 'add' ? 'btn btn-primary' : 'btn btn-danger'} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {adjModal.mode === 'add' ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                {saving ? 'Saving...' : adjModal.mode === 'add' ? 'Add Stock' : 'Remove Stock'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo Viewer Modal */}
      {photoModal && (
        <div onClick={() => setPhotoModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <button onClick={() => setPhotoModal(null)} style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 8, padding: 8, cursor: 'pointer', color: '#e8eaf2' }}>
            <X size={18} />
          </button>
          <img src={photoModal.image_data} alt={photoModal.name} style={{ maxWidth: '85vw', maxHeight: '85vh', borderRadius: 10, objectFit: 'contain', border: '1px solid rgba(255,255,255,0.1)', display: 'block' }} />
        </div>
      )}

      {/* Image Upload Modal */}
      {imageUploadVariant && (
        <div className="modal-overlay" onClick={() => setImageUploadVariant(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ImageIcon size={16} color="#a78bfa" />
                  {imageUploadVariant.image_data ? 'Change Image' : 'Upload Image'}
                </h2>
                <p>{imageUploadVariant.name}</p>
              </div>
              <button className="modal-close" onClick={() => setImageUploadVariant(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              {imageUploadVariant.image_data && (
                <div style={{ marginBottom: 14, textAlign: 'center' }}>
                  <img src={imageUploadVariant.image_data} alt="Current" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)' }} />
                </div>
              )}

              <input ref={imageFileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp"
                onChange={e => handleImageUpload(imageUploadVariant, e.target.files[0])}
                style={{ display: 'none' }}
              />
              <button onClick={() => imageFileRef.current?.click()} disabled={imageSaving}
                style={{ width: '100%', background: 'rgba(167,139,250,0.1)', border: '1px dashed rgba(167,139,250,0.4)', borderRadius: 8, padding: '14px 0', color: '#a78bfa', fontSize: 13, fontWeight: 700, cursor: imageSaving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: imageSaving ? 0.6 : 1 }}>
                <ImageIcon size={14} /> {imageSaving ? 'Uploading...' : 'Select Image (JPG, PNG, WebP)'}
              </button>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
              {imageUploadVariant.image_data ? (
                <button className="btn btn-danger" onClick={() => { handleImageRemove(imageUploadVariant); setImageUploadVariant(null) }}>Remove Image</button>
              ) : <div />}
              <button className="btn btn-secondary" onClick={() => setImageUploadVariant(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Attachments Modal (shared component) */}
      {attachModal && (
        <AttachmentsModal product={attachModal} onClose={() => { setAttachModal(null); load() }} />
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
                <BarcodePreview value={barcodeTarget.barcode || barcodeTarget.sku || barcodeTarget.product_code} />
                <div style={{ fontSize: 10, color: '#666', marginTop: 4, fontFamily: 'monospace' }}>{barcodeTarget.sku || barcodeTarget.product_code}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Barcode Value (CODE128)</div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#e8eaf2', fontWeight: 700 }}>{barcodeTarget.barcode || barcodeTarget.sku || barcodeTarget.product_code}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label className="label" style={{ margin: 0 }}>Copies</label>
                <input type="number" min={1} max={100} value={barcodeCopies} onChange={e => setBarcodeCopies(e.target.value)} className="input" style={{ width: 80, textAlign: 'center' }} />
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
    </div>
  )
}

function ComponentList({ items, onAdjust, onEdit, onDelete, onZoom, onPrint, onRestore, onShopify }) {
  const [search, setSearch] = useState('')
  const filtered = search.trim()
    ? items.filter(p => p.name?.toLowerCase().includes(search.toLowerCase()) || p.product_code?.toLowerCase().includes(search.toLowerCase()))
    : items

  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 16, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <Package size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>{search ? `No matches for "${search}"` : 'No products yet — click "+ New Product" to add one'}</div>
        </div>
      ) : (
        <StockTable
          products={filtered}
          accent="#fbbf24"
          onAdjust={onAdjust}
          onEdit={onEdit}
          onPrint={onPrint}
          onDelete={onDelete}
          onRestore={onRestore}
          onZoom={onZoom}
          onShopify={onShopify}
        />
      )}
    </div>
  )
}

function cBtn(color) {
  return {
    background: 'var(--surface-2)', border: '1px solid var(--border)', color,
    borderRadius: 6, padding: '4px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 4,
  }
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
