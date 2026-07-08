import { useState, useEffect, useRef } from 'react'
import { Plus, Search, Edit2, Trash2, X, ChevronDown, Package, Beaker, Layers, FlaskConical, TrendingUp, Printer, ImageIcon, Paperclip } from 'lucide-react'
import AttachmentsModal from '../components/AttachmentsModal.jsx'
import { splitVolume } from '../utils/volume.js'
import { InfoIcon } from '../components/Tooltip.jsx'
import MlHint from '../components/MlHint.jsx'
import axios from 'axios'
import JsBarcode from 'jsbarcode'
import { useInkColor } from '../utils/theme.js'
import IconButton from '../components/IconButton.jsx'
import Button from '../components/Button.jsx'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import ConfirmModal from '../components/ConfirmModal.jsx'
import { useToast } from '../SMModule.jsx'
import SearchSelect from '../components/SearchSelect.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const CATEGORIES = [
  { key: 'ALL', label: 'All' },
  { key: 'FRAGRANCE', label: 'Fragrance', unit: 'ml', barcode: false },
  { key: 'RAW_MATERIAL', label: 'Raw Material', barcode: true },
  { key: 'COMPONENT', label: 'Component', unit: 'units', barcode: true },
  { key: 'LABEL', label: 'Label', unit: 'units', barcode: false },
  { key: 'FINISHED_GOOD', label: 'Finished Good', unit: 'units', barcode: true },
  { key: 'READY_FORMULA', label: 'Ready Formula', unit: 'ml', barcode: false },
  { key: 'CLIENT_STOCK', label: 'Reserved Stock', unit: 'units', barcode: false },
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

const EMPTY_FORM = {
  name: '', product_code: '', category: 'FRAGRANCE', sub_category: '',
  unit: 'ml', current_stock: '', min_stock_level: '',
  supplier: '', supplier_code: '', bin_location: '', barcode: '',
  lead_time: '', notes: '', image_data: '', client_id: '',
  volume_ml: '', default_oil_pct: '',
}

function requiresBarcode(cat) {
  return ['RAW_MATERIAL', 'COMPONENT', 'FINISHED_GOOD'].includes(cat)
}

function defaultUnit(cat) {
  if (cat === 'FRAGRANCE' || cat === 'READY_FORMULA') return 'ml'
  if (cat === 'RAW_MATERIAL') return 'ml'
  return 'units'
}

export default function Products() {
  const [products, setProducts] = useState([])
  const [filter, setFilter] = useState('ALL')
  const [hasAttachments, setHasAttachments] = useState(false)
  const [hideMasters, setHideMasters] = useState(false)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [suppliers, setSuppliers] = useState([])
  const [clients, setClients] = useState([])
  const [strengthTarget, setStrengthTarget] = useState(null)
  const [strengthLog, setStrengthLog] = useState([])
  const [strengthLoading, setStrengthLoading] = useState(false)
  const [barcodeTarget, setBarcodeTarget] = useState(null)
  const [barcodeCopies, setBarcodeCopies] = useState(1)
  const [seqSuggestion, setSeqSuggestion] = useState(null)
  const [photoModal, setPhotoModal] = useState(null)
  const [attachModal, setAttachModal] = useState(null)
  const [clientStock, setClientStock] = useState([])
  const [clientLabels, setClientLabels] = useState([])
  const svgRef = useRef(null)
  const imageInputRef = useRef(null)
  const { addToast } = useToast()

  useEffect(() => { loadProducts(); loadSuppliers(); loadClients() }, [])
  useEffect(() => { if (filter === 'CLIENT_STOCK') loadClientStock() }, [filter])
  useEffect(() => { if (filter === 'LABEL' || filter === 'ALL') loadClientLabels() }, [filter])

  async function loadProducts() {
    setLoading(true)
    try {
      const params = {}
      if (filter !== 'ALL' && filter !== 'CLIENT_STOCK') params.category = filter
      if (search) params.search = search
      if (hasAttachments) params.has_attachments = '1'
      const res = await axios.get('/api/products', { ...api(), params })
      setProducts(res.data)
    } catch { addToast('Failed to load products', 'error') }
    finally { setLoading(false) }
  }

  async function loadClientStock() {
    setLoading(true)
    try {
      const params = search ? { search } : {}
      const res = await axios.get('/api/client-stock', { ...api(), params })
      setClientStock(res.data)
    } catch { addToast('Failed to load reserved stock', 'error') }
    finally { setLoading(false) }
  }

  async function loadClientLabels() {
    try {
      const res = await axios.get('/api/client-labels', api())
      setClientLabels(res.data)
    } catch {}
  }

  async function loadSuppliers() {
    try {
      const res = await axios.get('/api/suppliers', api())
      setSuppliers(res.data)
    } catch {}
  }

  async function loadClients() {
    try {
      const res = await axios.get('/api/clients', api())
      setClients(res.data)
    } catch {}
  }

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

  async function handleImageFile(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) { addToast('Please select an image file', 'error'); return }
    const base64 = await resizeImage(file)
    setForm(f => ({ ...f, image_data: base64 }))
  }

  function openBarcode(product) {
    setBarcodeTarget(product)
    setBarcodeCopies(1)
  }

  function printBarcode() {
    if (!barcodeTarget) return
    const copies = Math.max(1, Math.min(parseInt(barcodeCopies) || 1, 100))
    const win = window.open('', '_blank', 'width=600,height=500')

    // Build one barcode SVG
    const tmpSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    JsBarcode(tmpSvg, barcodeTarget.barcode, {
      format: 'CODE128', lineColor: '#000', background: '#fff',
      width: 2, height: 60, displayValue: true,
      font: 'monospace', fontSize: 11, margin: 8,
    })
    const svgStr = tmpSvg.outerHTML

    const labels = Array.from({ length: copies }, (_, i) => `
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

  async function openStrengthLog(product) {
    setStrengthTarget(product)
    setStrengthLog([])
    setStrengthLoading(true)
    try {
      const res = await axios.get(`/api/fragrances/${product.id}/strength-log`, api())
      setStrengthLog(res.data)
    } catch { addToast('Failed to load strength log', 'error') }
    finally { setStrengthLoading(false) }
  }

  useEffect(() => { loadProducts() }, [filter, search, hasAttachments])

  useEffect(() => {
    if (editing || !showModal) { setSeqSuggestion(null); return }
    const SEEDS = {
      FRAGRANCE:     { prefix: 'FRAG_',     pad: 5, suffix: '' },
      RAW_MATERIAL:  { prefix: 'RAW_',      pad: 5, suffix: '' },
      COMPONENT:     { prefix: 'COMP_',     pad: 5, suffix: '' },
      LABEL:         { prefix: 'LABEL_',    pad: 5, suffix: '' },
      FINISHED_GOOD: { prefix: 'FG_',       pad: 5, suffix: '' },
      READY_FORMULA: { prefix: 'RF-FRAG_',  pad: 5, suffix: '' },
      MAJOR_CLIENT:  { prefix: 'LC_',       pad: 5, suffix: '' },
    }
    const extract = str => { const m = str?.match(/(\D*[-_])(\d+)(\D*)$/); return m ? { prefix: m[1], num: parseInt(m[2]), pad: m[2].length, suffix: m[3] } : null }
    const catProducts = products.filter(p => p.category === form.category)
    const parsed = catProducts.map(p => extract(p.product_code)).filter(Boolean).sort((a, b) => b.num - a.num)[0]
    if (parsed) {
      const last = catProducts.find(p => extract(p.product_code)?.num === parsed.num)?.product_code
      const suggested = parsed.prefix + String(parsed.num + 1).padStart(parsed.pad, '0') + parsed.suffix
      setSeqSuggestion({ last, suggested })
    } else if (SEEDS[form.category]) {
      const s = SEEDS[form.category]
      setSeqSuggestion({ last: null, suggested: s.prefix + '00001'.slice(-s.pad).padStart(s.pad, '0') + s.suffix })
    } else {
      setSeqSuggestion(null)
    }
  }, [form.category, showModal, editing])

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  function openEdit(product) {
    setEditing(product)
    setForm({
      name: product.name || '',
      product_code: product.product_code || '',
      category: product.category || 'FRAGRANCE',
      sub_category: product.sub_category || '',
      unit: product.unit || 'ml',
      current_stock: product.current_stock ?? '',
      min_stock_level: product.min_stock_level ?? '',
      supplier: product.supplier || '',
      supplier_code: product.supplier_code || '',
      bin_location: product.bin_location || '',
      barcode: product.barcode || '',
      lead_time: product.lead_time || '',
      notes: product.notes || '',
      image_data: product.image_data || '',
      client_id: product.client_id || '',
      volume_ml: product.volume_ml ?? '',
      default_oil_pct: product.default_oil_pct ?? '',
    })
    setShowModal(true)
  }

  function handleCategoryChange(cat) {
    setForm(f => ({ ...f, category: cat, unit: defaultUnit(cat) }))
  }

  async function handleSave() {
    if (!form.name.trim()) { addToast('Name is required', 'error'); return }
    if (!form.product_code.trim()) { addToast('Product code is required', 'error'); return }
    if (form.category === 'MAJOR_CLIENT' && !form.client_id) {
      addToast('Major Client is required for this category', 'error'); return
    }
    if (requiresBarcode(form.category) && !form.barcode.trim()) {
      addToast(`Barcode is required for ${form.category}`, 'error'); return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        current_stock: parseFloat(form.current_stock) || 0,
        min_stock_level: parseFloat(form.min_stock_level) || 0,
        lead_time: parseInt(form.lead_time) || null,
        client_id: form.client_id ? parseInt(form.client_id) : null,
      }
      if (editing) {
        await axios.put(`/api/products/${editing.id}`, payload, api())
        addToast('Product updated')
      } else {
        await axios.post('/api/products', payload, api())
        addToast('Product created')
      }
      setShowModal(false)
      loadProducts()
    } catch (e) {
      addToast(e.response?.data?.error || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  async function handleDelete() {
    try {
      await axios.delete(`/api/products/${deleteTarget.id}`, api())
      addToast('Product deleted')
      setDeleteTarget(null)
      loadProducts()
    } catch (e) {
      addToast(e.response?.data?.error || 'Delete failed', 'error')
    }
  }

  const mappedClientLabels = (filter === 'LABEL' || filter === 'ALL') ? clientLabels
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
      reserved_qty: 0,
      min_stock_level: 0,
      unit: 'units',
      barcode: null,
      bin_location: null,
      image_data: null,
    })) : []

  // A master = FG product with no parent (template, no stock)
  // A variant = FG product with master_product_id (has stock)
  function isMaster(p) {
    return p.is_master || (p.category === 'FINISHED_GOOD' && !p.master_product_id && !p.fragrance_id)
  }
  function isVariant(p) {
    return p.category === 'FINISHED_GOOD' && p.master_product_id
  }

  const displayed = [
    ...products.filter(p =>
      (filter === 'ALL' || p.category === filter) &&
      (!hideMasters || !isMaster(p)) &&
      (!search || p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.product_code.toLowerCase().includes(search.toLowerCase()) ||
        (p.barcode || '').toLowerCase().includes(search.toLowerCase()))
    ),
    ...mappedClientLabels,
  ]

  return (
    <div style={{ padding: 28 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Products</h1>
        {filter !== 'CLIENT_STOCK' && (
          <Button onClick={openCreate}>
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
        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />
        <button onClick={() => setHasAttachments(v => !v)} style={{
          background: hasAttachments ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.05)',
          color: hasAttachments ? '#60a5fa' : 'rgba(232,234,242,0.6)',
          border: hasAttachments ? '1px solid rgba(96,165,250,0.4)' : '1px solid rgba(255,255,255,0.1)',
          borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 5
        }}>
          <Paperclip size={11} /> Has Attachments
        </button>
        <button onClick={() => setHideMasters(v => !v)} title="Hide master products (templates without stock)" style={{
          background: hideMasters ? 'rgba(232,121,249,0.15)' : 'rgba(255,255,255,0.05)',
          color: hideMasters ? '#e879f9' : 'rgba(232,234,242,0.6)',
          border: hideMasters ? '1px solid rgba(232,121,249,0.4)' : '1px solid rgba(255,255,255,0.1)',
          borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 5
        }}>
          Hide Masters
        </button>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, code or barcode..."
          style={{
            width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none'
          }}
        />
      </div>

      {/* CLIENT_STOCK Table */}
      {filter === 'CLIENT_STOCK' && (loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Client', 'Product Name', 'Code', 'Stock', 'Unit', 'Category'].map(h => (
                  <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clientStock.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '32px 14px', textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No reserved stock found</td></tr>
              ) : clientStock.filter(cs => !search || cs.product_name?.toLowerCase().includes(search.toLowerCase()) || cs.product_code?.toLowerCase().includes(search.toLowerCase()) || cs.client_name?.toLowerCase().includes(search.toLowerCase())).map(cs => (
                <tr key={cs.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '10px 14px', fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>{cs.client_name || '—'}</td>
                  <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{cs.product_name}</td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)', fontFamily: 'monospace' }}>{cs.product_code}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: cs.quantity <= 0 ? '#f87171' : '#4ade80' }}>{Number(cs.quantity).toLocaleString()}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>{cs.unit}</td>
                  <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{cs.category || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {clientStock.length} item{clientStock.length !== 1 ? 's' : ''}
          </div>
        </div>
      ))}

      {/* Products Table */}
      {filter !== 'CLIENT_STOCK' && (loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {[
                  { key: 'Category', label: 'Category' },
                  { key: 'Name', label: 'Name' },
                  { key: 'Code', label: 'Code' },
                  { key: 'Total Stock', label: 'Total Stock', tip: 'Total quantity in warehouse, including stock reserved for active production orders.' },
                  { key: 'Reserved', label: 'Reserved', tip: 'Quantity committed to confirmed production orders. Hover over cells to see details per order.' },
                  { key: 'Available', label: 'Available', tip: 'Total Stock − Reserved. Quantity available for new orders.' },
                  { key: 'Min Level', label: 'Min Level', tip: 'Minimum stock level. Orange alert when Available ≤ Min Level.' },
                  { key: 'Bin', label: 'Bin' },
                  { key: 'Barcode', label: 'Barcode' },
                  { key: 'Actions', label: 'Actions' },
                ].map(h => (
                  <th key={h.key} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {h.label}
                      {h.tip && <InfoIcon text={h.tip} maxWidth={260} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: '32px 14px', textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No products found</td></tr>
              ) : displayed.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      background: `${CAT_COLORS[p.category]}20`, color: CAT_COLORS[p.category],
                      padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700
                    }}>{p.category.replace('_', ' ')}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {p.image_data ? (
                        <img
                          src={p.image_data} alt=""
                          onClick={() => setPhotoModal(p)}
                          title="Click to enlarge"
                          style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.12)', flexShrink: 0, cursor: 'zoom-in' }}
                        />
                      ) : (
                        <div style={{ width: 32, height: 32, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <ImageIcon size={12} color="rgba(232,234,242,0.2)" />
                        </div>
                      )}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{p.name}</div>
                          {isMaster(p) && (
                            <span style={{ background: 'rgba(232,121,249,0.15)', color: '#e879f9', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 0.4 }}>MASTER</span>
                          )}
                          {isVariant(p) && (
                            <span style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 0.4 }}>VARIANT</span>
                          )}
                          {(() => {
                            const cur = parseFloat(p.current_stock)
                            const min = parseFloat(p.min_stock_level)
                            const isOut = cur <= 0
                            const isLow = !isOut && min > 0 && cur < min
                            if (!isOut && !isLow) return null
                            const color = isOut ? '#f87171' : '#fbbf24'
                            return <span title={isOut ? 'Out of stock' : 'Below min level'} style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 4px ${color}` }} />
                          })()}
                        </div>
                        {p.supplier && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{p.supplier}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)', fontFamily: 'monospace' }}>{p.product_code}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {(() => {
                      const cur = parseFloat(p.current_stock)
                      const min = parseFloat(p.min_stock_level)
                      const isOut = cur <= 0
                      const isLow = !isOut && min > 0 && cur < min
                      const disp = splitVolume(cur, p.unit)
                      return (
                        <>
                          <span style={{ fontSize: 13, fontWeight: 700, color: isOut ? '#f87171' : isLow ? '#fbbf24' : '#4ade80' }}>
                            {disp.value}
                          </span>
                          <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginLeft: 4 }}>{disp.unit}</span>
                        </>
                      )
                    })()}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {(() => {
                      const reserved = parseFloat(p.reserved_qty) || 0
                      if (reserved === 0) return <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)' }}>—</span>
                      const details = Array.isArray(p.reservation_detail) ? p.reservation_detail : []
                      const reservedDisp = splitVolume(reserved, p.unit)
                      const tip = details.map(d => {
                        const ds = splitVolume(d.qty, p.unit)
                        return `${d.order_number || 'Order'}: ${ds.value} ${ds.unit}`
                      }).join('\n')
                      return (
                        <span title={tip} style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', cursor: details.length ? 'help' : 'default', borderBottom: details.length ? '1px dashed rgba(251,191,36,0.4)' : 'none' }}>
                          {reservedDisp.value} {reservedDisp.unit}
                        </span>
                      )
                    })()}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {(() => {
                      const avail = parseFloat(p.current_stock) - (parseFloat(p.reserved_qty) || 0)
                      const min = parseFloat(p.min_stock_level)
                      const isOut = avail <= 0
                      const isLow = !isOut && min > 0 && avail < min
                      const availDisp = splitVolume(avail, p.unit)
                      return (
                        <span style={{ fontSize: 13, fontWeight: 700, color: isOut ? '#f87171' : isLow ? '#fbbf24' : '#4ade80' }}>
                          {availDisp.value}
                          <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginLeft: 4 }}>{availDisp.unit}</span>
                        </span>
                      )
                    })()}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                    {p.min_stock_level > 0 ? (() => { const s = splitVolume(p.min_stock_level, p.unit); return `${s.value} ${s.unit}` })() : '—'}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>{p.bin_location || '—'}</td>
                  <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', fontFamily: 'monospace' }}>
                    {p.barcode || (requiresBarcode(p.category) ? <span style={{ color: '#f87171' }}>⚠ Missing</span> : '—')}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {p.category === 'FRAGRANCE' && (
                        <IconButton onClick={() => openStrengthLog(p)} title="Oil % History"><TrendingUp size={13} /></IconButton>
                      )}
                      {['FRAGRANCE','FINISHED_GOOD'].includes(p.category) && (
                        <IconButton onClick={() => setAttachModal(p)} title={`Attachments${p.attachment_count > 0 ? ` (${p.attachment_count})` : ''}`} style={{ position: 'relative' }}>
                          <Paperclip size={13} />
                          {p.attachment_count > 0 && (
                            <span style={{ position: 'absolute', top: -3, right: -3, background: 'var(--accent)', color: '#fff', borderRadius: '50%', width: 14, height: 14, fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
                              {p.attachment_count > 9 ? '9+' : p.attachment_count}
                            </span>
                          )}
                        </IconButton>
                      )}
                      {!p._is_client_label && p.barcode && (
                        <IconButton onClick={() => openBarcode(p)} title="Print Barcode"><Printer size={13} /></IconButton>
                      )}
                      {!p._is_client_label && (
                        <IconButton onClick={() => openEdit(p)} title="Edit product"><Edit2 size={13} /></IconButton>
                      )}
                      {!p._is_client_label && (
                        <IconButton variant="danger" onClick={() => setDeleteTarget(p)} title="Delete product"><Trash2 size={13} /></IconButton>
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
            {displayed.length} product{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      ))}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing ? 'Edit Product' : 'New Product'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Category" full>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {CATEGORIES.filter(c => c.key !== 'ALL' && c.key !== 'CLIENT_STOCK').map(c => (
                    <button key={c.key} onClick={() => handleCategoryChange(c.key)} style={{
                      background: form.category === c.key ? `${CAT_COLORS[c.key]}25` : 'rgba(255,255,255,0.05)',
                      border: form.category === c.key ? `1px solid ${CAT_COLORS[c.key]}` : '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      color: form.category === c.key ? CAT_COLORS[c.key] : 'rgba(232,234,242,0.55)'
                    }}>{c.label}</button>
                  ))}
                </div>
              </Field>

              <Field label="Name *" full>
                <Input value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="e.g. Santal Black" />
              </Field>

              <Field label="Product Code *">
                <Input value={form.product_code} onChange={v => setForm(f => ({ ...f, product_code: v.toUpperCase() }))} placeholder="e.g. FRAG-001" mono />
                {seqSuggestion && (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {seqSuggestion.last && (
                      <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>Last: <code style={{ color: 'rgba(232,234,242,0.6)' }}>{seqSuggestion.last}</code></span>
                    )}
                    <button type="button" onClick={() => setForm(f => ({ ...f, product_code: seqSuggestion.suggested }))}
                      style={{ background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 5, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: '#60a5fa', cursor: 'pointer' }}>
                      Use {seqSuggestion.suggested}
                    </button>
                  </div>
                )}
              </Field>

              <Field label="Unit">
                <SearchSelect
                  value={form.unit}
                  onChange={v => setForm(f => ({ ...f, unit: v }))}
                  options={[
                    { value: 'ml', label: 'ml' },
                    { value: 'units', label: 'units' },
                    { value: 'kg', label: 'kg' },
                    { value: 'g', label: 'g' },
                  ]}
                  clearable={false}
                />
              </Field>

              {!editing && (
                <Field label="Initial Stock">
                  <Input type="number" value={form.current_stock} onChange={v => setForm(f => ({ ...f, current_stock: v }))} placeholder="0" />
                  <MlHint value={form.current_stock} unit={form.unit} />
                </Field>
              )}

              <Field label="Min Stock Level">
                <Input type="number" value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} placeholder="0" />
                <MlHint value={form.min_stock_level} unit={form.unit} />
              </Field>

              <Field label={`Barcode${requiresBarcode(form.category) ? ' *' : ''}`} full>
                <BarcodeField
                  value={form.barcode}
                  productCode={form.product_code}
                  onChange={v => setForm(f => ({ ...f, barcode: v }))}
                />
              </Field>

              <Field label="Bin Location">
                <Input value={form.bin_location} onChange={v => setForm(f => ({ ...f, bin_location: v }))} placeholder="e.g. A1-B3" />
              </Field>

              <Field label="Supplier">
                <Input value={form.supplier} onChange={v => setForm(f => ({ ...f, supplier: v }))} placeholder="Supplier name" />
              </Field>

              <Field label="Supplier Code">
                <Input value={form.supplier_code} onChange={v => setForm(f => ({ ...f, supplier_code: v }))} placeholder="Supplier's SKU" mono />
              </Field>

              <Field label="Lead Time (days)">
                <Input type="number" value={form.lead_time} onChange={v => setForm(f => ({ ...f, lead_time: v }))} placeholder="e.g. 14" />
              </Field>

              <Field label="Sub-category">
                <Input value={form.sub_category} onChange={v => setForm(f => ({ ...f, sub_category: v }))} placeholder="Optional" />
              </Field>


              {['FINISHED_GOOD', 'READY_FORMULA'].includes(form.category) && (
                <Field label="Volume (ml)">
                  <Input type="number" min={0} step="any" value={form.volume_ml} onChange={v => setForm(f => ({ ...f, volume_ml: v }))} placeholder="e.g. 100" />
                  <MlHint value={form.volume_ml} unit="ml" />
                </Field>
              )}
              {form.category === 'FRAGRANCE' && (
                <Field label="Default Oil %">
                  <Input type="number" min={0} max={100} step="any" value={form.default_oil_pct} onChange={v => setForm(f => ({ ...f, default_oil_pct: v }))} placeholder="e.g. 25" />
                </Field>
              )}
              {form.category === 'MAJOR_CLIENT' && (
                <Field label="Major Client *" full>
                  <SearchSelect
                    value={form.client_id}
                    onChange={v => setForm(f => ({ ...f, client_id: v }))}
                    options={clients.filter(c => c.is_large_client).map(c => ({ value: c.id, label: c.name }))}
                    placeholder="— Select Major Client —"
                  />
                </Field>
              )}

              <Field label="Notes" full>
                <textarea
                  value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2} placeholder="Optional notes..."
                  style={{ ...inputStyle, resize: 'vertical', width: '100%' }}
                />
              </Field>

              <Field label="Product Photo" full>
                <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={e => handleImageFile(e.target.files[0])} />
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {form.image_data ? (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={form.image_data} alt="Product" style={{ width: 80, height: 80, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                      <button onClick={() => setForm(f => ({ ...f, image_data: '' }))} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#dc2626', border: 'none', color: 'white', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>×</button>
                    </div>
                  ) : (
                    <div style={{ width: 80, height: 80, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '2px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <ImageIcon size={22} color="rgba(232,234,242,0.2)" />
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <button onClick={() => imageInputRef.current?.click()} style={{ background: 'rgba(37,99,235,0.12)', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 8, padding: '8px 16px', color: '#60a5fa', fontSize: 12, cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ImageIcon size={13} /> {form.image_data ? 'Change Photo' : 'Upload Photo'}
                    </button>
                    <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)', marginTop: 6 }}>JPG, PNG, WEBP — auto-resized to 900px</div>
                  </div>
                </div>
              </Field>
            </div>

            {requiresBarcode(form.category) && !form.barcode && (
              <div style={{ gridColumn: '1 / -1', marginTop: 12, padding: '8px 12px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8, fontSize: 12, color: '#f87171' }}>
                ⚠ Barcode is required for {form.category.replace('_', ' ')}
              </div>
            )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Product'}
              </button>
            </div>
          </div>
        </div>
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
                <BarcodePreview value={barcodeTarget.barcode} />
                <div style={{ fontSize: 10, color: '#666', marginTop: 4, fontFamily: 'monospace' }}>{barcodeTarget.product_code}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Barcode Value (CODE128)</div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#e8eaf2', fontWeight: 700 }}>{barcodeTarget.barcode}</div>
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

      {/* Strength Log Modal */}
      {strengthTarget && (
        <div className="modal-overlay" onClick={() => setStrengthTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Oil % History</h2>
                <p style={{ color: '#a78bfa' }}>{strengthTarget.name}</p>
              </div>
              <button className="modal-close" onClick={() => setStrengthTarget(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">

            {strengthLoading ? (
              <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>Loading...</div>
            ) : strengthLog.length === 0 ? (
              <div style={{ color: 'rgba(232,234,242,0.3)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>No usage history yet — log entries are created automatically when production orders are completed.</div>
            ) : (
              <>
                {/* Summary chips */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Uses', value: strengthLog.length },
                    { label: 'Avg %', value: (strengthLog.reduce((s, r) => s + parseFloat(r.actual_pct_used), 0) / strengthLog.length).toFixed(1) + '%' },
                    { label: 'Adjusted', value: strengthLog.filter(r => r.was_adjusted).length, warn: true },
                  ].map(c => (
                    <div key={c.label} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '8px 16px', textAlign: 'center' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: c.warn && c.value > 0 ? '#fbbf24' : '#e8eaf2' }}>{c.value}</div>
                      <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{c.label}</div>
                    </div>
                  ))}
                </div>

                {/* Sparkline chart */}
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '16px 8px', marginBottom: 20 }}>
                  <ResponsiveContainer width="100%" height={120}>
                    <LineChart data={[...strengthLog].reverse().map((r, i) => ({ i: i + 1, pct: parseFloat(r.actual_pct_used), date: r.date_used }))}>
                      <XAxis dataKey="i" hide />
                      <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: 'rgba(232,234,242,0.4)' }} width={28} />
                      <Tooltip
                        contentStyle={{ background: '#1e1e3a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                        labelFormatter={i => `Batch #${i}`}
                        formatter={v => [`${v}%`, 'Oil %']}
                      />
                      <ReferenceLine y={25} stroke="rgba(167,139,250,0.3)" strokeDasharray="3 3" />
                      <Line type="monotone" dataKey="pct" stroke="#a78bfa" strokeWidth={2} dot={{ fill: '#a78bfa', r: 3 }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                  <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.25)', textAlign: 'center', marginTop: 4 }}>Dashed line = 25% standard</div>
                </div>

                {/* History table */}
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                        {['Date', 'Standard %', 'Actual %', 'Adjusted', 'PO', 'Reason', 'By'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {strengthLog.map(r => (
                        <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '7px 12px', fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{r.date_used ? new Date(r.date_used).toLocaleDateString('en-AU') : '—'}</td>
                          <td style={{ padding: '7px 12px', fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{r.standard_pct}%</td>
                          <td style={{ padding: '7px 12px', fontSize: 13, fontWeight: 700, color: r.was_adjusted ? '#fbbf24' : '#a78bfa' }}>{r.actual_pct_used}%</td>
                          <td style={{ padding: '7px 12px' }}>
                            {r.was_adjusted
                              ? <span style={{ background: 'rgba(245,158,11,0.12)', color: '#fbbf24', padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>Yes</span>
                              : <span style={{ color: 'rgba(232,234,242,0.3)', fontSize: 11 }}>—</span>}
                          </td>
                          <td style={{ padding: '7px 12px', fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{r.production_order_id ? `#${r.production_order_id}` : '—'}</td>
                          <td style={{ padding: '7px 12px', fontSize: 11, color: 'rgba(232,234,242,0.45)', maxWidth: 140 }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.adjustment_reason || '—'}</div>
                          </td>
                          <td style={{ padding: '7px 12px', fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{r.created_by_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Photo Modal */}
      {photoModal && (
        <div
          onClick={() => setPhotoModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9500, cursor: 'zoom-out' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
            <button onClick={() => setPhotoModal(null)} style={{ position: 'absolute', top: -12, right: -12, width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>×</button>
            <img src={photoModal.image_data} alt={photoModal.name} style={{ maxWidth: '85vw', maxHeight: '85vh', borderRadius: 10, objectFit: 'contain', border: '1px solid rgba(255,255,255,0.1)', display: 'block' }} />
            <div style={{ marginTop: 10, textAlign: 'center', color: 'rgba(232,234,242,0.7)', fontSize: 13, fontWeight: 600 }}>{photoModal.name}</div>
            <div style={{ textAlign: 'center', color: 'rgba(232,234,242,0.35)', fontSize: 11, marginTop: 2, fontFamily: 'monospace' }}>{photoModal.product_code}</div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteTarget && (
        <ConfirmModal
          title="Delete Product"
          message={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Attachments Modal */}
      {attachModal && (
        <AttachmentsModal product={attachModal} onClose={() => setAttachModal(null)} />
      )}
    </div>
  )
}


// ─── Barcode Preview ───
function BarcodePreview({ value }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', lineColor: '#000', background: '#fff',
        width: 2, height: 60, displayValue: true,
        font: 'monospace', fontSize: 11, margin: 6,
      })
    } catch (e) {
      // invalid barcode value — leave empty
    }
  }, [value])
  return <svg ref={ref} style={{ maxWidth: '100%' }} />
}

// ─── Helpers ───
function Field({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : undefined }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</label>
      {children}
    </div>
  )
}

const inputStyle = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none', width: '100%'
}
const selectStyle = { ...inputStyle, cursor: 'pointer' }

function Input({ value, onChange, placeholder, type = 'text', mono }) {
  return (
    <input
      type={type} value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={{ ...inputStyle, fontFamily: mono ? 'monospace' : 'inherit' }}
    />
  )
}

function BarcodeField({ value, productCode, onChange }) {
  const svgRef = useRef(null)
  const ink = useInkColor()

  useEffect(() => {
    if (!svgRef.current || !value) return
    try {
      JsBarcode(svgRef.current, value, {
        format: 'CODE128', width: 1.6, height: 44,
        displayValue: true, fontSize: 10, margin: 6,
        background: 'transparent', lineColor: ink,
      })
    } catch {
      svgRef.current.innerHTML = ''
    }
  }, [value, ink])

  function generate() {
    const code = (productCode || '').trim().replace(/\s+/g, '-').toUpperCase()
    if (code) onChange(code)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text" value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Scan, type, or generate..."
          style={{ ...inputStyle, fontFamily: 'monospace', flex: 1 }}
        />
        <button
          type="button" onClick={generate}
          disabled={!productCode}
          title="Generate barcode from product code"
          style={{
            background: productCode ? 'rgba(37,99,235,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${productCode ? 'rgba(37,99,235,0.35)' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: productCode ? 'pointer' : 'not-allowed',
            color: productCode ? '#60a5fa' : 'rgba(232,234,242,0.3)', whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          Generate
        </button>
      </div>
      {value && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, display: 'flex', justifyContent: 'center' }}>
          <svg ref={svgRef} />
        </div>
      )}
    </div>
  )
}

