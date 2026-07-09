import { useState, useEffect } from 'react'
import { Plus, X, Tag, Search, ChevronRight, BookOpen, Trash2, Edit2, Upload } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import { useToast } from '../SMModule.jsx'
import MlHint from '../components/MlHint.jsx'
import BOMEditor from '../components/BOMEditor.jsx'
import { suggestMasterCode, MASTER_PREFIXES } from '../utils/masterCode.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const EMPTY_FORM = {
  name: '', product_code: '', volume_ml: '', volume_unit: 'ml',
  default_oil_pct: '25', container_name: '', is_pure_oil: false, is_candle: false, image_data: '',
}

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

export default function StandardCatalog() {
  const [masters, setMasters]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [containerFilter, setContainerFilter] = useState('ALL')
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing]   = useState(null) // master being edited, or null
  const [form, setForm]         = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [selectedMaster, setSelectedMaster] = useState(null) // open drawer
  const [zoomImage, setZoomImage] = useState(null)
  const [highlightCode, setHighlightCode] = useState('') // master just created → glow + scroll
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  // After a successful create, glow + scroll to the new card. Mirrors the BOM page deep-link.
  useEffect(() => {
    if (!highlightCode || loading) return
    const t1 = setTimeout(() => {
      const el = document.getElementById(`master-card-${highlightCode}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    const t2 = setTimeout(() => setHighlightCode(''), 4000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [highlightCode, loading])

  async function load() {
    setLoading(true)
    try {
      // include_archived=1 so suggestMasterCode sees every existing code (archived rows still
      // hold the unique product_code, otherwise the helper would suggest a colliding number).
      // Display is filtered to non-archived in `displayed` below.
      const m = await axios.get('/api/masters', { ...api(), params: { segment: 'STANDARD', include_archived: 1 } })
      setMasters(m.data)
    } catch (e) { addToast('Failed to load Standard catalog', 'error') }
    finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null)
    // Start empty — the helper button below shows the next suggestion and the user has to
    // click it explicitly. Avoids auto-filling a code the user might not want.
    setForm({ ...EMPTY_FORM, product_code: '' })
    setShowCreate(true)
  }

  function openEdit(m) {
    setEditing(m)
    setForm({
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
    if (!form.name.trim() || !form.product_code.trim()) {
      addToast('Name and product code are required', 'error'); return
    }
    setCreating(true)
    try {
      if (editing) {
        await axios.put(`/api/masters/${editing.id}`, {
          name: form.name.trim(),
          volume_ml: form.volume_ml ? parseFloat(form.volume_ml) : null,
          volume_unit: form.volume_unit || 'ml',
          default_oil_pct: parseFloat(form.default_oil_pct) || 25,
          container_name: form.container_name?.trim() || null,
          is_pure_oil: !!form.is_pure_oil,
          is_candle: !!form.is_candle,
          image_data: form.image_data || null,
        }, api())
        addToast(`"${form.name}" updated`)
      } else {
        const res = await axios.post('/api/masters', {
          name: form.name.trim(),
          product_code: form.product_code.trim().toUpperCase(),
          segment: 'STANDARD',
          client_id: null,
          volume_ml: form.volume_ml ? parseFloat(form.volume_ml) : null,
          volume_unit: form.volume_unit || 'ml',
          default_oil_pct: parseFloat(form.default_oil_pct) || 25,
          container_name: form.container_name?.trim() || null,
          is_pure_oil: !!form.is_pure_oil,
          is_candle: !!form.is_candle,
          image_data: form.image_data || null,
          bom_components: [],
          fragrance_ids: [],
          generate_variants: false,
        }, api())
        const copied = res.data?.bom_copied_from
        addToast(`"${form.name}" Standard master created${copied ? ` — BOM auto-filled from "${copied}"` : ''}`)
        setHighlightCode(form.product_code.trim().toUpperCase()) // trigger glow after reload
      }
      setShowCreate(false); setEditing(null); setForm(EMPTY_FORM)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setCreating(false) }
  }

  async function handleArchive() {
    try {
      await axios.delete(`/api/masters/${deleteTarget.id}`, api())
      addToast('Master archived')
      setDeleteTarget(null)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  // Distinct container names for filter dropdown
  const containerOptions = [...new Set(masters.filter(m => !m.archived).map(m => m.container_name).filter(Boolean))]

  const displayed = masters.filter(m => {
    if (m.archived) return false
    if (containerFilter !== 'ALL' && m.container_name !== containerFilter) return false
    if (!search) return true
    const s = search.toLowerCase()
    return m.name.toLowerCase().includes(s) || m.product_code.toLowerCase().includes(s)
  })

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Tag size={20} color="#60a5fa" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Standard Catalog</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Clean skin product masters shared across Standard clients</p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus size={15} /> New Standard Master
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


      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <Tag size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>No Standard masters yet</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Click "New Standard Master" to create a clean skin template</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {displayed.map(m => (
            <MasterCard key={m.id} master={m} highlight={highlightCode === m.product_code} onClick={() => setSelectedMaster(m)} onEdit={() => openEdit(m)} onDelete={() => setDeleteTarget(m)} onZoom={setZoomImage} />
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => { setShowCreate(false); setEditing(null) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Tag size={16} color="var(--accent)" />
                  <h2>{editing ? 'Edit Standard Master' : 'New Standard Master'}</h2>
                </div>
                <p>Clean skin template — fragrance picked per order</p>
              </div>
              <button className="modal-close" onClick={() => { setShowCreate(false); setEditing(null) }}><X size={14} /></button>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Name *">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Reed Diffuser 200ml Clean Skin" autoFocus style={inp} />
              </Field>
              <Field label={editing ? 'Product Code (locked)' : 'Product Code *'}>
                <input value={form.product_code} onChange={e => setForm(f => ({ ...f, product_code: e.target.value.toUpperCase() }))} disabled={!!editing} placeholder={`e.g. ${MASTER_PREFIXES.STANDARD}00001`} style={{ ...inp, fontFamily: 'monospace', opacity: editing ? 0.5 : 1, cursor: editing ? 'not-allowed' : 'text' }} />
                {!editing && (() => {
                  const suggested = suggestMasterCode(masters, MASTER_PREFIXES.STANDARD)
                  if (form.product_code === suggested) return null
                  return (
                    <div style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => setForm(f => ({ ...f, product_code: suggested }))}
                        style={{ background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 5, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: '#60a5fa', cursor: 'pointer' }}>
                        Use {suggested}
                      </button>
                    </div>
                  )
                })()}
              </Field>
              <Field label="Container">
                <input value={form.container_name} onChange={e => setForm(f => ({ ...f, container_name: e.target.value }))} list="sc-container-options" placeholder="Type or pick an existing container" style={inp} />
                <datalist id="sc-container-options">
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
                  <input type="checkbox" checked={!!form.is_pure_oil} onChange={e => setForm(f => ({ ...f, is_pure_oil: e.target.checked, is_candle: e.target.checked ? false : f.is_candle }))} style={{ accentColor: '#60a5fa' }} />
                  Pure oil
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: 'rgba(232,234,242,0.85)' }}>
                  <input type="checkbox" checked={!!form.is_candle} onChange={e => setForm(f => ({ ...f, is_candle: e.target.checked, is_pure_oil: e.target.checked ? false : f.is_pure_oil }))} style={{ accentColor: '#60a5fa' }} />
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
                  <MlHint value={form.volume_ml} unit={form.volume_unit} />
                </Field>
                <Field label="Default Oil %">
                  <input type="number" min={0} max={100} value={form.default_oil_pct} onChange={e => setForm(f => ({ ...f, default_oil_pct: e.target.value }))} placeholder="25" style={inp} />
                </Field>
              </div>
              <Field label="Product Image">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {form.image_data
                    ? <img src={form.image_data} alt="" style={{ width: 48, height: 48, borderRadius: 7, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                    : <div style={{ width: 48, height: 48, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Tag size={15} color="rgba(232,234,242,0.25)" /></div>}
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
              <button className="btn btn-secondary" onClick={() => { setShowCreate(false); setEditing(null) }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? 'Saving...' : editing ? 'Save Changes' : 'Create Master'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Master detail drawer with BOM editor */}
      {selectedMaster && (
        <StandardMasterDrawer master={selectedMaster} onClose={() => { setSelectedMaster(null); load() }} />
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

      {/* Archive confirm */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', borderRadius: 14, padding: 28, width: 400 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e8eaf2', marginBottom: 10 }}>Archive master?</div>
            <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.6)', marginBottom: 20, lineHeight: 1.5 }}>
              "{deleteTarget.name}" will be archived. Existing production orders referencing it stay intact.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 18px', color: '#e8eaf2', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleArchive} style={{ background: '#dc2626', border: 'none', borderRadius: 8, padding: '8px 18px', color: 'white', fontSize: 13, cursor: 'pointer', fontWeight: 700 }}>Archive</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MasterCard({ master, onClick, onEdit, onDelete, onZoom, highlight }) {
  return (
    <div id={`master-card-${master.product_code}`} onClick={onClick}
      className={highlight ? 'bom-card-glow' : ''}
      style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderLeft: '3px solid #60a5fa', borderRadius: 12, padding: 18,
      cursor: 'pointer', transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(96,165,250,0.3)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10 }}>
        {master.image_data
          ? <img src={master.image_data} alt="" onClick={e => { e.stopPropagation(); onZoom?.(master.image_data) }} style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(96,165,250,0.25)', flexShrink: 0, cursor: 'zoom-in' }} />
          : <div style={{ width: 44, height: 44, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Tag size={16} color="rgba(232,234,242,0.2)" /></div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e8eaf2', marginBottom: 4 }}>{master.name}</div>
          <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{master.product_code}</div>
        </div>
        <span style={{ background: 'rgba(96,165,250,0.15)', color: '#60a5fa', padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800, flexShrink: 0 }}>STANDARD</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {master.container_name && <Chip color="#a78bfa">{master.container_name}</Chip>}
        {master.volume_ml && <Chip color="#60a5fa">{master.volume_ml}{master.volume_unit || 'ml'}</Chip>}
        {master.default_oil_pct != null && !master.is_candle && !master.is_pure_oil && <Chip color="#fbbf24">{master.default_oil_pct}% oil</Chip>}
        {master.is_candle && <Chip color="#fb7185">🕯 Candle</Chip>}
        {master.is_pure_oil && <Chip color="#9d3b5e">Pure Oil</Chip>}
      </div>

      <div style={{ display: 'flex', gap: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>BOM</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: master.bom_component_count > 0 ? '#4ade80' : 'rgba(232,234,242,0.4)' }}>{master.bom_component_count || 0}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <IconButton onClick={e => { e.stopPropagation(); onEdit() }} title="Edit master"><Edit2 size={13} /></IconButton>
          <IconButton variant="danger" onClick={e => { e.stopPropagation(); onDelete() }} title="Archive master"><Trash2 size={13} /></IconButton>
          <ChevronRight size={14} color="rgba(232,234,242,0.3)" />
        </div>
      </div>
    </div>
  )
}

// Drawer with inline BOMEditor
function StandardMasterDrawer({ master, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 720, height: '100vh',
        background: 'var(--card-bg)', borderLeft: '1px solid var(--border-h)',
        boxShadow: 'var(--shadow-md)',
        overflowY: 'auto', padding: 28,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Tag size={16} color="#60a5fa" />
              <span style={{ background: 'rgba(96,165,250,0.15)', color: '#60a5fa', padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800 }}>STANDARD MASTER</span>
            </div>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 19, color: '#e8eaf2' }}>{master.name}</h2>
            <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', marginTop: 3 }}>{master.product_code}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        {/* Attributes */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 24 }}>
          <AttrCell label="Container" value={master.container_name || '—'} />
          <AttrCell label="Volume" value={master.volume_ml ? `${master.volume_ml} ${master.volume_unit || 'ml'}` : '—'} />
          <AttrCell label="Default Oil" value={master.is_pure_oil ? '100% (pure oil)' : `${master.default_oil_pct || 25}%`} />
          <AttrCell label="Type" value={master.is_candle ? 'Candle (external filling)' : master.is_pure_oil ? 'Pure Oil' : 'Standard mix'} />
        </div>

        {/* BOM Editor inline (read-only — edit in Bill of Materials page) */}
        <BOMEditor productCode={master.product_code} master={master} segment="SM" readOnly />
      </div>
    </div>
  )
}

function AttrCell({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 }}>
      <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{value}</div>
    </div>
  )
}

function Chip({ color, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {children}
    </span>
  )
}

function chip(active) {
  return {
    background: active ? 'rgba(96,165,250,0.2)' : 'rgba(255,255,255,0.04)',
    border: active ? '1px solid #60a5fa' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
    color: active ? '#60a5fa' : 'rgba(232,234,242,0.5)',
  }
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
