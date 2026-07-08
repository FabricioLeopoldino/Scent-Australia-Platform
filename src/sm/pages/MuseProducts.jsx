import { useState, useEffect } from 'react'
import { Plus, X, Star, Beaker, Package, Edit2, Trash2, Search, ChevronRight, FlaskConical, Box, BookOpen, Upload } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import { useLocation } from 'wouter'
import { useToast } from '../SMModule.jsx'
import SearchSelect from '../components/SearchSelect.jsx'
import BOMEditor from '../components/BOMEditor.jsx'
import { suggestMasterCode, MASTER_PREFIXES } from '../utils/masterCode.js'
import MuseHeader from '../components/MuseHeader.jsx'

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

export default function MuseProducts() {
  const [masters, setMasters]               = useState([])
  const [fragrances, setFragrances]         = useState([])
  const [loading, setLoading]               = useState(true)
  const [containerFilter, setContainerFilter] = useState('ALL')
  const [search, setSearch]                 = useState('')
  const [selectedMaster, setSelectedMaster] = useState(null) // detail drawer
  const [masterDetail, setMasterDetail]     = useState(null)
  const [detailLoading, setDetailLoading]   = useState(false)
  const [showCreate, setShowCreate]         = useState(false)
  const [editing, setEditing]               = useState(null)
  const [createForm, setCreateForm]         = useState(EMPTY_FORM)
  const [creating, setCreating]             = useState(false)
  const [zoomImage, setZoomImage]           = useState(null)
  const [addFragId, setAddFragId]           = useState('')
  const [addingFragrance, setAddingFragrance] = useState(false)
  const [deleteTarget, setDeleteTarget]     = useState(null) // { master }
  const [highlightCode, setHighlightCode]   = useState('') // master just created → glow + scroll
  const [, navigate]                        = useLocation()
  const { addToast } = useToast()

  // After a successful create, glow + scroll to the new card. Same pattern as StandardCatalog.
  useEffect(() => {
    if (!highlightCode || loading) return
    const t1 = setTimeout(() => {
      const el = document.getElementById(`master-card-${highlightCode}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    const t2 = setTimeout(() => setHighlightCode(''), 4000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [highlightCode, loading])

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [m, f] = await Promise.all([
        // include_archived=1 so suggestMasterCode sees every existing code (archived rows
        // still hold the unique product_code). Display filters `!m.archived` below.
        axios.get('/api/masters', { ...api(), params: { segment: 'MUSE', include_archived: 1 } }),
        axios.get('/api/products', { ...api(), params: { category: 'FRAGRANCE' } }),
      ])
      setMasters(m.data)
      setFragrances(f.data)
    } catch (e) { addToast('Failed to load MUSE products', 'error') }
    finally { setLoading(false) }
  }

  async function openDetail(master) {
    setSelectedMaster(master)
    setDetailLoading(true)
    try {
      const r = await axios.get(`/api/masters/${master.id}`, api())
      setMasterDetail(r.data)
    } catch { addToast('Failed to load master detail', 'error') }
    finally { setDetailLoading(false) }
  }

  function closeDetail() {
    setSelectedMaster(null)
    setMasterDetail(null)
  }

  function openCreate() {
    setEditing(null)
    // Start empty — helper button below the input proposes the next code; user clicks to use.
    setCreateForm({ ...EMPTY_FORM, product_code: '' })
    setShowCreate(true)
  }

  function openEdit(m) {
    setEditing(m)
    setCreateForm({
      name: m.name || '', product_code: m.product_code || '',
      volume_ml: m.volume_ml != null ? String(m.volume_ml) : '',
      volume_unit: m.volume_unit || 'ml',
      default_oil_pct: m.default_oil_pct != null ? String(m.default_oil_pct) : '25',
      container_name: m.container_name || '',
      is_pure_oil: !!m.is_pure_oil, is_candle: !!m.is_candle,
      image_data: m.image_data || '',
    })
    setShowCreate(true)
  }

  async function handleCreate() {
    if (!createForm.name.trim() || !createForm.product_code.trim()) {
      addToast('Name and product code are required', 'error'); return
    }
    setCreating(true)
    try {
      if (editing) {
        await axios.put(`/api/masters/${editing.id}`, {
          name: createForm.name.trim(),
          volume_ml: createForm.volume_ml ? parseFloat(createForm.volume_ml) : null,
          volume_unit: createForm.volume_unit || 'ml',
          default_oil_pct: parseFloat(createForm.default_oil_pct) || 25,
          container_name: createForm.container_name?.trim() || null,
          is_pure_oil: !!createForm.is_pure_oil,
          is_candle: !!createForm.is_candle,
          image_data: createForm.image_data || null,
        }, api())
        addToast(`"${createForm.name}" updated`)
      } else {
        const res = await axios.post('/api/masters', {
          name: createForm.name.trim(),
          product_code: createForm.product_code.trim().toUpperCase(),
          segment: 'MUSE',
          client_id: null,
          volume_ml: createForm.volume_ml ? parseFloat(createForm.volume_ml) : null,
          volume_unit: createForm.volume_unit || 'ml',
          default_oil_pct: parseFloat(createForm.default_oil_pct) || 25,
          container_name: createForm.container_name?.trim() || null,
          is_pure_oil: !!createForm.is_pure_oil,
          is_candle: !!createForm.is_candle,
          image_data: createForm.image_data || null,
          bom_components: [],
          fragrance_ids: [],
          generate_variants: false,
        }, api())
        const copied = res.data?.bom_copied_from
        addToast(`"${createForm.name}" master created${copied ? ` — BOM auto-filled from "${copied}"` : ''}`)
        setHighlightCode(createForm.product_code.trim().toUpperCase()) // glow + scroll after reload
      }
      setShowCreate(false)
      setEditing(null)
      setCreateForm(EMPTY_FORM)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setCreating(false) }
  }

  async function handleAddFragrance() {
    if (!addFragId) return
    setAddingFragrance(true)
    try {
      await axios.post(`/api/masters/${selectedMaster.id}/fragrances`, { fragrance_id: parseInt(addFragId) }, api())
      addToast('Fragrance added — variant created')
      setAddFragId('')
      // Reload detail + masters list
      const r = await axios.get(`/api/masters/${selectedMaster.id}`, api())
      setMasterDetail(r.data)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed to add fragrance', 'error') }
    finally { setAddingFragrance(false) }
  }

  async function handleRemoveFragrance(fragId) {
    if (!confirm('Remove this fragrance? Existing variant will be archived (stock preserved for history).')) return
    try {
      await axios.delete(`/api/masters/${selectedMaster.id}/fragrances/${fragId}`, api())
      addToast('Fragrance removed')
      const r = await axios.get(`/api/masters/${selectedMaster.id}`, api())
      setMasterDetail(r.data)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleDeleteMaster() {
    try {
      await axios.delete(`/api/masters/${deleteTarget.master.id}`, api())
      addToast('Master archived')
      setDeleteTarget(null)
      closeDetail()
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  // Distinct container names for filter
  const containerOptions = [...new Set(masters.filter(m => !m.archived).map(m => m.container_name).filter(Boolean))]

  // Filter masters
  const displayed = masters.filter(m => {
    if (m.archived) return false
    if (containerFilter !== 'ALL' && m.container_name !== containerFilter) return false
    if (!search) return true
    const s = search.toLowerCase()
    return m.name.toLowerCase().includes(s) || m.product_code.toLowerCase().includes(s)
  })

  // Fragrance options for the add picker — exclude already-assigned
  const assignedFragIds = new Set((masterDetail?.fragrances || []).map(f => f.fragrance_id))
  const availableFragrances = fragrances.filter(f => !assignedFragIds.has(f.id))

  return (
    <div style={{ padding: 28 }}>
      <MuseHeader subtitle="Catalog" />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Star size={20} color="#fbbf24" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>MUSE Catalog</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Manage own brand masters and their fragrance variants</p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus size={15} /> New Master
        </Button>
      </div>

      {/* Container filter */}
      {containerOptions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginRight: 4 }}>Container:</span>
          <button onClick={() => setContainerFilter('ALL')} style={chip(containerFilter === 'ALL')}>All</button>
          {containerOptions.map(name => (
            <button key={name} onClick={() => setContainerFilter(name)} style={chip(containerFilter === name)}>{name}</button>
          ))}
        </div>
      )}

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search masters..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {/* Masters grid */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <Star size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>No MUSE masters yet</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Click "New Master" to add your first own-brand product</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {displayed.map(m => (
            <MasterCard key={m.id} master={m} highlight={highlightCode === m.product_code} onClick={() => openDetail(m)} onEdit={() => openEdit(m)} onDelete={() => setDeleteTarget({ master: m })} onZoom={setZoomImage} />
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showCreate && (
        <CreateMasterModal
          mode={editing ? 'edit' : 'create'}
          form={createForm}
          setForm={setCreateForm}
          containerOptions={containerOptions}
          suggestedCode={suggestMasterCode(masters, MASTER_PREFIXES.MUSE)}
          onSave={handleCreate}
          onClose={() => { setShowCreate(false); setEditing(null); setCreateForm(EMPTY_FORM) }}
          saving={creating}
        />
      )}

      {/* Image zoom lightbox */}
      {zoomImage && (
        <div onClick={() => setZoomImage(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9600, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <img src={zoomImage} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, boxShadow: '0 10px 60px rgba(0,0,0,0.6)' }} />
          <button onClick={() => setZoomImage(null)} style={{ position: 'absolute', top: 18, right: 18, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, width: 36, height: 36, color: '#e8eaf2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Detail Drawer */}
      {selectedMaster && (
        <DetailDrawer
          master={selectedMaster}
          detail={masterDetail}
          loading={detailLoading}
          fragrances={fragrances}
          availableFragrances={availableFragrances}
          addFragId={addFragId}
          setAddFragId={setAddFragId}
          onAddFragrance={handleAddFragrance}
          addingFragrance={addingFragrance}
          onRemoveFragrance={handleRemoveFragrance}
          onClose={closeDetail}
          onDelete={() => setDeleteTarget({ master: selectedMaster })}
          onEditBOM={() => navigate('/bom-muse')}
        />
      )}

      {/* Confirm delete */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 14, padding: 28, width: 400 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e8eaf2', marginBottom: 10 }}>Archive master?</div>
            <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.6)', marginBottom: 20, lineHeight: 1.5 }}>
              "{deleteTarget.master.name}" will be archived (soft delete). Variants and stock history are preserved.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 18px', color: '#e8eaf2', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleDeleteMaster} style={{ background: '#dc2626', border: 'none', borderRadius: 8, padding: '8px 18px', color: 'white', fontSize: 13, cursor: 'pointer', fontWeight: 700 }}>Archive</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Master card
// ─────────────────────────────────────────────────────────────
function MasterCard({ master, onClick, onEdit, onDelete, onZoom, highlight }) {
  return (
    <div id={`master-card-${master.product_code}`} onClick={onClick}
      className={highlight ? 'bom-card-glow' : ''}
      style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderLeft: '3px solid #fbbf24', borderRadius: 12, padding: 18,
      cursor: 'pointer', transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(251,191,36,0.3)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0, flex: 1 }}>
          {master.image_data
            ? <img src={master.image_data} alt="" onClick={e => { e.stopPropagation(); onZoom?.(master.image_data) }} style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(251,191,36,0.25)', flexShrink: 0, cursor: 'zoom-in' }} />
            : <div style={{ width: 44, height: 44, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Star size={16} color="rgba(232,234,242,0.2)" /></div>}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#e8eaf2', marginBottom: 4 }}>{master.name}</div>
            <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{master.product_code}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
          <IconButton onClick={e => { e.stopPropagation(); onEdit() }} title="Edit master"><Edit2 size={13} /></IconButton>
          <IconButton variant="danger" onClick={e => { e.stopPropagation(); onDelete() }} title="Archive master"><Trash2 size={13} /></IconButton>
          <ChevronRight size={14} color="rgba(232,234,242,0.3)" />
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {master.container_name && (
          <span style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
            {master.container_name}
          </span>
        )}
        {master.volume_ml && (
          <span style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
            {master.volume_ml}{master.volume_unit || 'ml'}
          </span>
        )}
        {master.default_oil_pct != null && !master.is_candle && !master.is_pure_oil && (
          <span style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
            {master.default_oil_pct}% oil
          </span>
        )}
        {master.is_candle && (
          <span style={{ background: 'rgba(251,113,133,0.1)', color: '#fb7185', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>🕯 Candle</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>BOM</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: master.bom_component_count > 0 ? '#4ade80' : 'rgba(232,234,242,0.4)' }}>{master.bom_component_count || 0}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>Fragrances</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: master.fragrance_count > 0 ? '#a78bfa' : 'rgba(232,234,242,0.4)' }}>{master.fragrance_count || 0}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>Variants</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: master.variant_count > 0 ? '#60a5fa' : 'rgba(232,234,242,0.4)' }}>{master.variant_count || 0}</div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>Total Stock</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fbbf24' }}>{Number(master.total_variant_stock || 0).toLocaleString()}</div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Detail Drawer
// ─────────────────────────────────────────────────────────────
function DetailDrawer({ master, detail, loading, fragrances, availableFragrances, addFragId, setAddFragId, onAddFragrance, addingFragrance, onRemoveFragrance, onClose, onDelete, onEditBOM }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 640, height: '100vh',
        background: 'var(--card-bg)', borderLeft: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)',
        overflowY: 'auto', padding: 28,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Star size={16} color="#fbbf24" />
              <span style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800 }}>MUSE MASTER</span>
            </div>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 19, color: '#e8eaf2' }}>{master.name}</h2>
            <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', marginTop: 3 }}>{master.product_code}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        {/* Attributes */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 22 }}>
          <AttrCell label="Container" value={master.container_name || '—'} />
          <AttrCell label="Volume" value={master.volume_ml ? `${master.volume_ml} ${master.volume_unit || 'ml'}` : '—'} />
          <AttrCell label="Default Oil" value={master.is_pure_oil ? '100% (pure oil)' : master.is_candle ? `${master.default_oil_pct || 12}% (candle)` : `${master.default_oil_pct || 25}%`} />
          <AttrCell label="Flags" value={[master.is_candle && 'Candle', master.is_pure_oil && 'Pure Oil'].filter(Boolean).join(', ') || 'Standard'} />
        </div>

        {/* BOM section — read-only; edit in Bill of Materials page */}
        <div style={{ marginBottom: 24 }}>
          <BOMEditor productCode={master.product_code} master={master} segment="MUSE" readOnly />
        </div>

        {/* Fragrances section */}
        <Section title="Fragrances & Variants" icon={<FlaskConical size={14} />}>
          {loading ? (
            <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)' }}>Loading...</div>
          ) : (
            <>
              {detail?.fragrances?.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {detail.fragrances.map(f => {
                    const variant = detail.variants.find(v => v.fragrance_id === f.fragrance_id)
                    return (
                      <div key={f.fragrance_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', borderRadius: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa' }}>{f.name}</div>
                          {variant && (
                            <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginTop: 2, fontFamily: 'monospace' }}>{variant.product_code}</div>
                          )}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700 }}>Stock</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: variant?.current_stock > 0 ? '#4ade80' : 'rgba(232,234,242,0.4)' }}>
                            {Number(variant?.current_stock || 0).toLocaleString()}
                          </div>
                        </div>
                        <IconButton variant="danger" onClick={() => onRemoveFragrance(f.fragrance_id)} title="Remove fragrance (archives variant)"><X size={13} /></IconButton>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic', marginBottom: 14 }}>No fragrances assigned yet.</div>
              )}

              {/* Add fragrance row */}
              {availableFragrances.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <SearchSelect
                      value={addFragId}
                      onChange={setAddFragId}
                      options={availableFragrances.map(f => ({ value: f.id, label: f.name, sub: f.product_code }))}
                      placeholder="Select a fragrance to add..."
                      clearable={false}
                    />
                  </div>
                  <button onClick={onAddFragrance} disabled={!addFragId || addingFragrance}
                    style={{ background: addFragId ? '#a78bfa' : 'rgba(167,139,250,0.3)', border: 'none', borderRadius: 8, padding: '8px 14px', color: 'white', fontSize: 12, fontWeight: 700, cursor: addFragId ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                    <Plus size={12} /> {addingFragrance ? 'Adding...' : 'Add'}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic' }}>
                  {fragrances.length === 0 ? 'No fragrances cadastrated yet. Add them in Fragrances page first.' : 'All available fragrances already assigned.'}
                </div>
              )}
            </>
          )}
        </Section>

        {/* Footer actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', marginTop: 32, paddingTop: 18, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={onDelete} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, padding: '8px 16px', color: '#f87171', fontSize: 12, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Trash2 size={12} /> Archive Master
          </button>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 18px', color: '#e8eaf2', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Create Master Modal
// ─────────────────────────────────────────────────────────────
function CreateMasterModal({ mode, form, setForm, containerOptions = [], onSave, onClose, saving, suggestedCode }) {
  const isEdit = mode === 'edit'
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Star size={16} color="#fbbf24" />
              <h2>{isEdit ? 'Edit MUSE Master' : 'New MUSE Master'}</h2>
            </div>
            <p>{isEdit ? 'Fragrances and BOM are managed in their own sections' : 'Add fragrances and BOM after creation'}</p>
          </div>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Name *">
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Reed Diffuser 200ml MUSE" autoFocus style={inp} />
          </Field>

          <Field label={isEdit ? 'Product Code (locked)' : 'Product Code *'}>
            <input value={form.product_code} onChange={e => setForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} disabled={isEdit} placeholder={suggestedCode ? `e.g. ${suggestedCode}` : 'MUSE00001'} style={{ ...inp, fontFamily: 'monospace', opacity: isEdit ? 0.5 : 1, cursor: isEdit ? 'not-allowed' : 'text' }} />
            {!isEdit && suggestedCode && form.product_code !== suggestedCode && (
              <div style={{ marginTop: 6 }}>
                <button type="button" onClick={() => setForm(f => ({ ...f, product_code: suggestedCode }))}
                  style={{ background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 5, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: '#fbbf24', cursor: 'pointer' }}>
                  Use {suggestedCode}
                </button>
              </div>
            )}
          </Field>

          <Field label="Container">
            <input value={form.container_name} onChange={e => setForm(f => ({ ...f, container_name: e.target.value }))} list="muse-container-options" placeholder="Type or pick an existing container" style={inp} />
            <datalist id="muse-container-options">
              {containerOptions.map(c => <option key={c} value={c} />)}
            </datalist>
            {containerOptions.length > 0 && (
              <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', marginTop: 4 }}>
                {containerOptions.length} existing container{containerOptions.length !== 1 ? 's' : ''} — click the field to pick
              </div>
            )}
          </Field>
          <div style={{ display: 'flex', gap: 14, padding: '2px 2px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: 'rgba(232,234,242,0.85)' }}>
              <input type="checkbox" checked={!!form.is_pure_oil} onChange={e => setForm(f => ({ ...f, is_pure_oil: e.target.checked, is_candle: e.target.checked ? false : f.is_candle }))} style={{ accentColor: '#fbbf24' }} />
              Pure oil
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: 'rgba(232,234,242,0.85)' }}>
              <input type="checkbox" checked={!!form.is_candle} onChange={e => setForm(f => ({ ...f, is_candle: e.target.checked, is_pure_oil: e.target.checked ? false : f.is_pure_oil }))} style={{ accentColor: '#fbbf24' }} />
              Candle
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Volume">
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" min={0} step="any" value={form.volume_ml} onChange={e => setForm(f => ({ ...f, volume_ml: e.target.value }))} placeholder="200" style={{ ...inp, flex: 1 }} />
                <select value={form.volume_unit} onChange={e => setForm(f => ({ ...f, volume_unit: e.target.value }))} style={{ ...inp, cursor: 'pointer', width: 72 }}>
                  <option value="ml">ml</option>
                  <option value="g">g</option>
                  <option value="oz">oz</option>
                </select>
              </div>
            </Field>
            <Field label="Default Oil %">
              <input type="number" min={0} max={100} value={form.default_oil_pct} onChange={e => setForm(f => ({ ...f, default_oil_pct: e.target.value }))} placeholder="25" style={inp} />
            </Field>
          </div>
          <Field label="Product Image">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {form.image_data
                ? <img src={form.image_data} alt="" style={{ width: 48, height: 48, borderRadius: 7, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                : <div style={{ width: 48, height: 48, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Star size={15} color="rgba(232,234,242,0.25)" /></div>}
              <label style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,234,242,0.8)', padding: '7px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Upload size={12} /> {form.image_data ? 'Replace' : 'Upload'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) { const d = await resizeImageFile(f); setForm(fm => ({ ...fm, image_data: d })) } e.target.value = '' }} />
              </label>
              {form.image_data && (
                <button type="button" onClick={() => setForm(f => ({ ...f, image_data: '' }))} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#f87171', padding: '7px 9px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>Remove</button>
              )}
            </div>
          </Field>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Master'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Helpers ───
const EMPTY_FORM = {
  name: '', product_code: '', volume_ml: '', volume_unit: 'ml',
  default_oil_pct: '25', container_name: '', is_pure_oil: false, is_candle: false, image_data: '',
}

function chip(active) {
  return {
    background: active ? 'rgba(251,191,36,0.2)' : 'rgba(255,255,255,0.04)',
    border: active ? '1px solid #fbbf24' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
    color: active ? '#fbbf24' : 'rgba(232,234,242,0.5)',
  }
}

function AttrCell({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 }}>
      <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{value}</div>
    </div>
  )
}

function Section({ title, icon, action, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 800, color: 'rgba(232,234,242,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {icon} {title}
        </div>
        {action && (
          <button onClick={action.onClick} style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
            {action.label} <ChevronRight size={11} />
          </button>
        )}
      </div>
      {children}
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

const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none' }
