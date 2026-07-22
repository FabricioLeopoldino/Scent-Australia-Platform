import { useState, useEffect } from 'react'
import { Briefcase, ChevronLeft, Package, Layers, Tag, Truck, Plus, FlaskConical, BookOpen, Mail, Phone, MapPin, X, ChevronRight, Edit2, Trash2, Upload } from 'lucide-react'
import axios from 'axios'
import IconButton from '../components/IconButton.jsx'
import { useLocation, useRoute } from 'wouter'
import { useToast } from '../SMModule.jsx'
import { splitVolume } from '../utils/volume.js'
import { fmtDate } from '../utils/date.js'
import BOMEditor from '../components/BOMEditor.jsx'
import MlHint from '../components/MlHint.jsx'
import { suggestMasterCode, MASTER_PREFIXES } from '../utils/masterCode.js'

const EMPTY_MASTER_FORM = {
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

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export default function MajorClientDetail() {
  const [, params] = useRoute('/major-clients/:id')
  const clientId = params?.id
  const [, navigate] = useLocation()

  const [client, setClient]   = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab]         = useState('catalog')
  const [selectedMaster, setSelectedMaster] = useState(null)
  const [showCreateMaster, setShowCreateMaster] = useState(false)
  const [editingMaster, setEditingMaster] = useState(null)
  const [createForm, setCreateForm] = useState(EMPTY_MASTER_FORM)
  const [creating, setCreating] = useState(false)
  const [deleteMaster, setDeleteMaster] = useState(null)
  const [zoomImage, setZoomImage] = useState(null)
  const [allMajorMasters, setAllMajorMasters] = useState([]) // for global MC#### code suggestion
  const [highlightCode, setHighlightCode] = useState('') // master just created → glow + scroll
  const { addToast } = useToast()

  // After a successful create, glow + scroll to the new card. Same pattern as StandardCatalog/MuseProducts.
  useEffect(() => {
    if (!highlightCode || loading) return
    const t1 = setTimeout(() => {
      const el = document.getElementById(`master-card-${highlightCode}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    const t2 = setTimeout(() => setHighlightCode(''), 4000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [highlightCode, loading])

  function openCreateMaster() {
    setEditingMaster(null)
    // Start empty — helper button below the input proposes the next code; user clicks to use.
    setCreateForm({ ...EMPTY_MASTER_FORM, product_code: '' })
    setShowCreateMaster(true)
  }

  function openEditMaster(m) {
    setEditingMaster(m)
    setCreateForm({
      name: m.name || '', product_code: m.product_code || '',
      volume_ml: m.volume_ml != null ? String(m.volume_ml) : '',
      volume_unit: m.volume_unit || 'ml',
      default_oil_pct: m.default_oil_pct != null ? String(m.default_oil_pct) : '25',
      container_name: m.container_name || '',
      is_pure_oil: !!m.is_pure_oil, is_candle: !!m.is_candle,
      image_data: m.image_data || '',
    })
    setShowCreateMaster(true)
  }

  async function handleCreateMaster() {
    if (!createForm.name.trim() || !createForm.product_code.trim()) {
      addToast('Name and product code required', 'error'); return
    }
    setCreating(true)
    try {
      if (editingMaster) {
        await axios.put(`/api/masters/${editingMaster.id}`, {
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
          segment: 'MAJOR',
          client_id: parseInt(clientId),
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
        addToast(`"${createForm.name}" Major Master created${copied ? ` — BOM auto-filled from "${copied}"` : ''}`)
        setHighlightCode(createForm.product_code.trim().toUpperCase()) // glow + scroll after reload
      }
      setShowCreateMaster(false)
      setEditingMaster(null)
      setCreateForm(EMPTY_MASTER_FORM)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setCreating(false) }
  }

  async function handleDeleteMaster() {
    if (!deleteMaster) return
    try {
      await axios.delete(`/api/masters/${deleteMaster.id}`, api())
      addToast(`"${deleteMaster.name}" archived`)
      setDeleteMaster(null)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  useEffect(() => { if (clientId) load() }, [clientId])

  async function load() {
    setLoading(true)
    try {
      const [c, s, allM] = await Promise.all([
        axios.get(`/api/major-clients/${clientId}`, api()),
        axios.get(`/api/major-clients/${clientId}/stock-summary`, api()),
        // include_archived=1 so suggestMasterCode sees every existing code (archived rows
        // still hold the unique product_code). Display uses client.masters which is already
        // filtered to non-archived server-side.
        axios.get('/api/masters', { ...api(), params: { segment: 'MAJOR', include_archived: 1 } }),
      ])
      setClient(c.data)
      setSummary(s.data)
      setAllMajorMasters(allM.data || [])
    } catch (e) { addToast(e.response?.data?.error || 'Failed to load', 'error') }
    finally { setLoading(false) }
  }

  if (loading) return <div style={{ padding: 28, color: 'rgba(232,234,242,0.4)' }}>Loading...</div>
  if (!client) return <div style={{ padding: 28, color: 'rgba(232,234,242,0.4)' }}>Major client not found</div>

  const tabs = [
    { key: 'catalog', label: 'Catalog', icon: <Package size={13} />, count: client.masters?.length || 0 },
    { key: 'stock', label: 'Client Stock', icon: <Layers size={13} />, count: summary?.client_stock?.length || 0 },
    { key: 'labels', label: 'Custom Labels', icon: <Tag size={13} />, count: summary?.labels?.length || 0 },
    { key: 'ship', label: 'Awaiting Ship', icon: <Truck size={13} />, count: summary?.awaiting_ship_grouped?.length || 0 },
  ]

  return (
    <div style={{ padding: 28 }}>
      {/* Back + Header */}
      <button onClick={() => navigate('/major-clients')} style={{ background: 'none', border: 'none', color: 'rgba(232,234,242,0.5)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16, padding: 0 }}>
        <ChevronLeft size={14} /> Back to Major Clients
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Briefcase size={22} color="#a78bfa" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>{client.name}</h1>
            <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 12, color: 'rgba(232,234,242,0.5)', flexWrap: 'wrap' }}>
              {client.email && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Mail size={11} />{client.email}</span>}
              {client.phone && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Phone size={11} />{client.phone}</span>}
              {client.address && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><MapPin size={11} />{client.address}</span>}
              <span style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', padding: '1px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>MAJOR CLIENT</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 'none', borderBottom: tab === t.key ? '2px solid #a78bfa' : '2px solid transparent',
            color: tab === t.key ? '#a78bfa' : 'rgba(232,234,242,0.5)',
            padding: '10px 16px', fontSize: 13, fontWeight: tab === t.key ? 700 : 500,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {t.icon} {t.label}
            {t.count > 0 && (
              <span style={{ background: tab === t.key ? 'rgba(167,139,250,0.2)' : 'rgba(255,255,255,0.08)', color: tab === t.key ? '#a78bfa' : 'rgba(232,234,242,0.4)', padding: '0 6px', borderRadius: 10, fontSize: 10, fontWeight: 700, marginLeft: 2 }}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'catalog' && <CatalogTab masters={client.masters || []} highlightCode={highlightCode} onSelectMaster={setSelectedMaster} onNewMaster={openCreateMaster} onEditMaster={openEditMaster} onDeleteMaster={setDeleteMaster} onZoom={setZoomImage} />}
      {tab === 'stock' && <ClientStockTab items={summary?.client_stock || []} />}
      {tab === 'labels' && <LabelsTab labels={summary?.labels || []} />}
      {tab === 'ship' && <AwaitingShipTab groups={summary?.awaiting_ship_grouped || []} total={summary?.awaiting_ship_total_units || 0} onClickOrder={(orderId) => navigate(`/production-orders?order=${orderId}`)} />}

      {/* Master detail drawer with BOM editor */}
      {selectedMaster && (
        <MajorMasterDrawer master={selectedMaster} onClose={() => { setSelectedMaster(null); load() }} />
      )}

      {showCreateMaster && (
        <CreateMasterModal
          mode={editingMaster ? 'edit' : 'create'}
          form={createForm}
          setForm={setCreateForm}
          creating={creating}
          clientName={client?.name}
          containerOptions={[...new Set((client.masters || []).map(m => m.container_name).filter(Boolean))]}
          suggestedCode={suggestMasterCode(allMajorMasters, MASTER_PREFIXES.MAJOR)}
          onClose={() => { setShowCreateMaster(false); setEditingMaster(null) }}
          onSave={handleCreateMaster}
        />
      )}

      {deleteMaster && (
        <div onClick={() => setDeleteMaster(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 9200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card-bg)', border: '1px solid rgba(220,38,38,0.3)', boxShadow: 'var(--shadow-md)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 15, color: '#f87171', marginBottom: 10 }}>Archive master?</h2>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.7)', marginBottom: 18 }}>
              <strong>{deleteMaster.name}</strong> will be archived. Existing production orders referencing it stay intact.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteMaster(null)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,234,242,0.7)', padding: '9px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDeleteMaster} style={{ background: '#dc2626', border: 'none', color: 'white', padding: '9px 18px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Archive</button>
            </div>
          </div>
        </div>
      )}

      {zoomImage && (
        <div onClick={() => setZoomImage(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9600, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <img src={zoomImage} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, boxShadow: '0 10px 60px rgba(0,0,0,0.6)' }} />
          <button onClick={() => setZoomImage(null)} style={{ position: 'absolute', top: 18, right: 18, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, width: 36, height: 36, color: '#e8eaf2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Create / Edit Master Modal ───
// Matches the layout of the Standard Catalog modal (one source of truth).
function CreateMasterModal({ mode, form, setForm, creating, containerOptions = [], onClose, onSave, suggestedCode, clientName }) {
  const isEdit = mode === 'edit'
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Briefcase size={16} color="#a78bfa" />
              <h2>{isEdit ? 'Edit Major Master' : 'New Major Master'}</h2>
            </div>
            <p>{clientName ? `For ${clientName} — fragrance(s) picked at master setup` : 'Major client master'}</p>
          </div>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Name *">
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Coco Room Spray 100ml" autoFocus style={inputStyle} />
          </Field>
          <Field label={isEdit ? 'Product Code (locked)' : 'Product Code *'}>
            <input value={form.product_code} onChange={e => setForm({ ...form, product_code: e.target.value.toUpperCase() })} disabled={isEdit} placeholder={suggestedCode ? `e.g. ${suggestedCode}` : 'MC00001'} style={{ ...inputStyle, fontFamily: 'monospace', opacity: isEdit ? 0.5 : 1, cursor: isEdit ? 'not-allowed' : 'text' }} />
            {!isEdit && suggestedCode && form.product_code !== suggestedCode && (
              <div style={{ marginTop: 6 }}>
                <button type="button" onClick={() => setForm({ ...form, product_code: suggestedCode })}
                  style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.35)', borderRadius: 5, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: '#a78bfa', cursor: 'pointer' }}>
                  Use {suggestedCode}
                </button>
              </div>
            )}
          </Field>
          <Field label="Container">
            <input value={form.container_name} onChange={e => setForm({ ...form, container_name: e.target.value })} list="mc-container-options" placeholder="Type or pick an existing container" style={inputStyle} />
            <datalist id="mc-container-options">
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
              <input type="checkbox" checked={!!form.is_pure_oil} onChange={e => setForm({ ...form, is_pure_oil: e.target.checked, is_candle: e.target.checked ? false : form.is_candle })} style={{ accentColor: '#a78bfa' }} />
              Pure oil
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: 'rgba(232,234,242,0.85)' }}>
              <input type="checkbox" checked={!!form.is_candle} onChange={e => setForm({ ...form, is_candle: e.target.checked, is_pure_oil: e.target.checked ? false : form.is_pure_oil })} style={{ accentColor: '#a78bfa' }} />
              Candle
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Volume">
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" min={0} step="any" value={form.volume_ml} onChange={e => setForm({ ...form, volume_ml: e.target.value })} placeholder="100" style={{ ...inputStyle, flex: 1 }} />
                <select value={form.volume_unit} onChange={e => setForm({ ...form, volume_unit: e.target.value })} style={{ ...inputStyle, cursor: 'pointer', width: 72 }}>
                  <option value="ml">ml</option>
                  <option value="g">g</option>
                  <option value="oz">oz</option>
                </select>
              </div>
              <MlHint value={form.volume_ml} unit={form.volume_unit} />
            </Field>
            <Field label="Default Oil %">
              <input type="number" min={0} max={100} value={form.default_oil_pct} onChange={e => setForm({ ...form, default_oil_pct: e.target.value })} placeholder="25" style={inputStyle} />
            </Field>
          </div>
          <Field label="Product Image">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {form.image_data
                ? <img src={form.image_data} alt="" style={{ width: 48, height: 48, borderRadius: 7, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />
                : <div style={{ width: 48, height: 48, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Briefcase size={15} color="rgba(232,234,242,0.25)" /></div>}
              <label style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,234,242,0.8)', padding: '7px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Upload size={12} /> {form.image_data ? 'Replace' : 'Upload'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) { const d = await resizeImageFile(f); setForm(fm => ({ ...fm, image_data: d })) } e.target.value = '' }} />
              </label>
              {form.image_data && (
                <button type="button" onClick={() => setForm({ ...form, image_data: '' })} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#f87171', padding: '7px 9px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>Remove</button>
              )}
            </div>
          </Field>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={creating}>
            {creating ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Master'}
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

// ─── Catalog Tab ───
function CatalogTab({ masters, onSelectMaster, onNewMaster, onEditMaster, onDeleteMaster, onZoom, highlightCode }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={onNewMaster} style={{
          background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.4)',
          color: '#a78bfa', padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Plus size={14} /> New Major Master
        </button>
      </div>
      {masters.length === 0 ? (
        <EmptyState icon={<Package size={36} />} title="No masters yet" hint='Click "+ New Major Master" to create one' />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {masters.map(m => (
        <div key={m.id} id={`master-card-${m.product_code}`} onClick={() => onSelectMaster(m)}
          className={highlightCode === m.product_code ? 'bom-card-glow' : ''}
          style={{
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          borderLeft: '3px solid #a78bfa', borderRadius: 12, padding: 16, cursor: 'pointer', transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4, gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0, flex: 1 }}>
              {m.image_data
                ? <img src={m.image_data} alt="" onClick={e => { e.stopPropagation(); onZoom?.(m.image_data) }} style={{ width: 42, height: 42, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(167,139,250,0.25)', flexShrink: 0, cursor: 'zoom-in' }} />
                : <div style={{ width: 42, height: 42, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Briefcase size={15} color="rgba(232,234,242,0.2)" /></div>}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf2' }}>{m.name}</div>
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)', marginTop: 2 }}>{m.product_code}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
              <IconButton onClick={e => { e.stopPropagation(); onEditMaster(m) }} title="Edit master"><Edit2 size={13} /></IconButton>
              <IconButton variant="danger" onClick={e => { e.stopPropagation(); onDeleteMaster(m) }} title="Archive master"><Trash2 size={13} /></IconButton>
              <ChevronRight size={14} color="rgba(232,234,242,0.3)" />
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {m.container_name && <Chip color="#a78bfa">{m.container_name}</Chip>}
            {m.volume_ml && <Chip color="#60a5fa">{m.volume_ml}{m.volume_unit || 'ml'}</Chip>}
            {m.is_candle && <Chip color="#fb7185">🕯 Candle</Chip>}
            <Chip color="#4ade80">BOM: {m.bom_component_count || 0}</Chip>
            <Chip color="#fbbf24">Fragrances: {m.fragrance_count || 0}</Chip>
          </div>
        </div>
      ))}
        </div>
      )}
    </div>
  )
}

// ─── Master Detail Drawer (Major Client) ───
function MajorMasterDrawer({ master, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 720, height: '100vh',
        background: 'var(--card-bg)', borderLeft: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)',
        overflowY: 'auto', padding: 28,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Briefcase size={16} color="#a78bfa" />
              <span style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800 }}>MAJOR MASTER</span>
            </div>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 19, color: '#e8eaf2' }}>{master.name}</h2>
            <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', marginTop: 3 }}>{master.product_code}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 24 }}>
          <AttrCell label="Container" value={master.container_name || '—'} />
          <AttrCell label="Volume" value={master.volume_ml ? `${master.volume_ml} ${master.volume_unit || 'ml'}` : '—'} />
          <AttrCell label="Default Oil" value={master.is_pure_oil ? '100% (pure oil)' : master.is_candle ? `${master.default_oil_pct || 12}% (candle)` : `${master.default_oil_pct || 25}%`} />
          <AttrCell label="Type" value={master.is_candle ? 'Candle (external filling)' : master.is_pure_oil ? 'Pure Oil' : 'Standard mix'} />
        </div>

        <BOMEditor productCode={master.product_code} master={master} clientId={master.client_id} segment="MAJOR" readOnly />

        <div style={{ marginTop: 32, padding: 14, background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.18)', borderRadius: 9, fontSize: 12, color: 'rgba(232,234,242,0.65)' }}>
          <strong style={{ color: '#a78bfa' }}>Major Client Master:</strong> BOM components are configured in the <strong>Bill of Materials</strong> page.
        </div>
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

// ─── Client Stock Tab ───
function ClientStockTab({ items }) {
  if (items.length === 0) return <EmptyState icon={<Layers size={36} />} title="No client stock" hint="Components from China are registered here when received" />

  // Group by category
  const grouped = {}
  items.forEach(i => {
    const key = i.category || 'OTHER'
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(i)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {Object.entries(grouped).map(([cat, list]) => (
        <div key={cat}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            {cat.replace(/_/g, ' ')} ({list.length})
          </div>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {['Name', 'Code', 'Quantity', 'Received', 'Notes'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map(item => {
                  const s = splitVolume(item.quantity, item.unit)
                  return (
                    <tr key={item.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e8eaf2' }}>{item.product_name}</td>
                      <td style={{ padding: '10px 14px', fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)' }}>{item.product_code}</td>
                      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: parseFloat(item.quantity) > 0 ? '#4ade80' : '#f87171' }}>
                        {s.value} <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{s.unit}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>{item.received_date ? fmtDate(item.received_date) : '—'}</td>
                      <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic' }}>{item.notes || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Labels Tab ───
function LabelsTab({ labels }) {
  if (labels.length === 0) return <EmptyState icon={<Tag size={36} />} title="No custom labels" hint="Client-specific labels (Clean Skin Black, etc.) appear here" />
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {['Label', 'Version', 'Applicable Type', 'Supplier', 'Stock', 'Notes'].map(h => (
              <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map(l => (
            <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e879f9' }}>{l.label_name}</td>
              <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{l.artwork_version || '—'}</td>
              <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{l.applicable_product_type ? l.applicable_product_type.replace(/_/g, ' ') : 'All'}</td>
              <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>{l.supplier || '—'}</td>
              <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: parseFloat(l.quantity) > 0 ? '#4ade80' : '#fbbf24' }}>
                {Number(l.quantity || 0).toLocaleString()} <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>units</span>
              </td>
              <td style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic' }}>{l.notes || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Awaiting Ship Tab ───
function AwaitingShipTab({ groups, total, onClickOrder }) {
  if (groups.length === 0) return <EmptyState icon={<Truck size={36} />} title="No orders awaiting ship" hint="Production orders in 'completed' or 'ready_to_ship' status appear here, grouped by product + fragrance" />
  return (
    <div>
      <div style={{ marginBottom: 14, padding: '12px 16px', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.2)', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Truck size={16} color="#4ade80" />
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80' }}>Total: {Number(total).toLocaleString()} units across {groups.length} product line{groups.length !== 1 ? 's' : ''}</div>
          <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)', marginTop: 2 }}>Held in stock awaiting client OK to ship</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map((g, i) => (
          <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf2' }}>{g.master_name}</div>
                {g.fragrance_name && <div style={{ fontSize: 12, color: '#a78bfa', marginTop: 3 }}>× {g.fragrance_name}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#4ade80' }}>{Number(g.total_quantity).toLocaleString()}</div>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700 }}>units</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {g.orders.map(o => (
                <div key={o.order_id} onClick={() => onClickOrder(o.order_id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 7, cursor: 'pointer', transition: 'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2', fontFamily: 'monospace' }}>{o.order_number}</span>
                  <span style={{
                    background: o.status === 'ready_to_ship' ? 'rgba(74,222,128,0.15)' : 'rgba(34,197,94,0.12)',
                    color: o.status === 'ready_to_ship' ? '#4ade80' : '#22c55e',
                    padding: '1px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                  }}>
                    {o.status.replace('_', ' ').toUpperCase()}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginLeft: 'auto' }}>{Number(o.quantity).toLocaleString()} units</span>
                  <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>Produced {fmtDate(o.created_at)}</span>
                  {o.due_date && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>· Due {fmtDate(o.due_date)}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Helpers ───
function Chip({ color, children }) {
  return <span style={{ background: `${color}1a`, color, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>{children}</span>
}

function EmptyState({ icon, title, hint }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(232,234,242,0.3)' }}>
      <div style={{ marginBottom: 12, opacity: 0.5 }}>{icon}</div>
      <div style={{ fontSize: 14, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)' }}>{hint}</div>
    </div>
  )
}
