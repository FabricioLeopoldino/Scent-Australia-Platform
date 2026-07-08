import { useState, useEffect } from 'react'
import { Plus, Edit2, Trash2, X, Box, RotateCcw } from 'lucide-react'
import axios from 'axios'
import IconButton from '../components/IconButton.jsx'
import Button from '../components/Button.jsx'
import { useToast } from '../SMModule.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const EMPTY_FORM = { name: '', code: '', is_candle: false, is_pure_oil: false, default_unit: 'ml', notes: '' }

export default function ContainerTypes() {
  const [types, setTypes]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_FORM)
  const [saving, setSaving]     = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null) // { type, mode: 'archive'|'permanent' }
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get('/api/container-types', { ...api(), params: { include_archived: '1' } })
      setTypes(r.data)
    } catch { addToast('Failed to load container types', 'error') }
    finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null); setForm(EMPTY_FORM); setShowModal(true)
  }

  function openEdit(t) {
    setEditing(t)
    setForm({
      name: t.name, code: t.code,
      is_candle: !!t.is_candle, is_pure_oil: !!t.is_pure_oil,
      default_unit: t.default_unit || 'ml', notes: t.notes || '',
    })
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.name.trim() || !form.code.trim()) { addToast('Name and code are required', 'error'); return }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        is_candle: !!form.is_candle,
        is_pure_oil: !!form.is_pure_oil,
        default_unit: form.default_unit || 'ml',
        notes: form.notes || null,
      }
      if (editing) {
        await axios.put(`/api/container-types/${editing.id}`, payload, api())
        addToast('Container type updated')
      } else {
        await axios.post('/api/container-types', payload, api())
        addToast('Container type created')
      }
      setShowModal(false); setForm(EMPTY_FORM); setEditing(null)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    const isPermanent = deleteTarget.mode === 'permanent'
    try {
      const url = isPermanent
        ? `/api/container-types/${deleteTarget.type.id}?permanent=1`
        : `/api/container-types/${deleteTarget.type.id}`
      await axios.delete(url, api())
      addToast(isPermanent ? 'Container type deleted permanently' : 'Container type archived')
      setDeleteTarget(null)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
  }

  async function handleRestore(t) {
    try {
      await axios.post(`/api/container-types/${t.id}/restore`, {}, api())
      addToast(`"${t.name}" restored`)
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Restore failed', 'error') }
  }

  const active = types.filter(t => !t.archived)
  const archived = types.filter(t => t.archived)

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Box size={20} color="#60a5fa" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Container Types</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Define product container categories (Reed Diffuser, Room Spray, Candle, etc.)</p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus size={15} /> New Container Type
        </Button>
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : active.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <Box size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>No container types yet</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Click "New Container Type" to add Reed Diffuser, Room Spray, Candle, etc.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {active.map(t => (
            <TypeCard key={t.id} type={t} onEdit={() => openEdit(t)} onArchive={() => setDeleteTarget({ type: t, mode: 'archive' })} />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <div style={{ marginTop: 36 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Archived ({archived.length})</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {archived.map(t => (
              <TypeCard key={t.id} type={t} onEdit={() => openEdit(t)} onArchive={null} onRestore={() => handleRestore(t)} onDeletePermanent={() => setDeleteTarget({ type: t, mode: 'permanent' })} archivedView />
            ))}
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing ? 'Edit Container Type' : 'New Container Type'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}><X size={14} /></button>
            </div>
            <div className="modal-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Name *">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Reed Diffuser" autoFocus style={inp} />
              </Field>
              <Field label="Code *">
                <input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="REED" style={{ ...inp, fontFamily: 'monospace' }} />
              </Field>
              <Field label="Default Unit">
                <select value={form.default_unit} onChange={e => setForm(f => ({ ...f, default_unit: e.target.value }))} style={{ ...inp, cursor: 'pointer' }}>
                  <option value="ml">ml (liquid)</option>
                  <option value="g">g (solid / candle)</option>
                  <option value="oz">oz</option>
                </select>
              </Field>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Special Behavior</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.is_candle} onChange={e => setForm(f => ({ ...f, is_candle: e.target.checked, is_pure_oil: e.target.checked ? false : f.is_pure_oil }))} />
                  <span style={{ fontSize: 13, color: '#e8eaf2' }}>🕯 Candle</span>
                  <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>— sent to external filling</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.is_pure_oil} onChange={e => setForm(f => ({ ...f, is_pure_oil: e.target.checked, is_candle: e.target.checked ? false : f.is_candle }))} />
                  <span style={{ fontSize: 13, color: '#e8eaf2' }}>Pure Oil</span>
                  <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>— 100% fragrance, no ethanol</span>
                </label>
              </div>

              <Field label="Notes (optional)">
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any additional notes..." rows={2} style={{ ...inp, resize: 'vertical' }} />
              </Field>
            </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : (editing ? 'Save Changes' : 'Create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm archive / permanent delete */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{deleteTarget.mode === 'permanent' ? 'Delete permanently?' : 'Archive container type?'}</h2>
              <button className="modal-close" onClick={() => setDeleteTarget(null)}><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.6)', lineHeight: 1.5 }}>
                {deleteTarget.mode === 'permanent'
                  ? <>
                      <strong style={{ color: '#f87171' }}>"{deleteTarget.type.name}"</strong> will be removed forever. This cannot be undone.<br />
                      <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>Any product still referencing it will block deletion.</span>
                    </>
                  : <>"{deleteTarget.type.name}" will be hidden but preserved. Masters currently using it will block archival.</>
                }
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete}>
                {deleteTarget.mode === 'permanent' ? 'Delete Permanently' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TypeCard({ type, onEdit, onArchive, onRestore, onDeletePermanent, archivedView }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${archivedView ? 'rgba(248,113,113,0.18)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 10, padding: 16, opacity: archivedView ? 0.65 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf2' }}>{type.name}</div>
            {archivedView && (
              <span style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 0.4 }}>ARCHIVED</span>
            )}
          </div>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)', marginTop: 3 }}>{type.code}</div>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          {onRestore && (
            <IconButton className="icon-btn-text" onClick={onRestore} title="Restore"><RotateCcw size={13} /> Restore</IconButton>
          )}
          {onEdit && !archivedView && (
            <IconButton onClick={onEdit} title="Edit"><Edit2 size={13} /></IconButton>
          )}
          {onArchive && (
            <IconButton variant="danger" onClick={onArchive} title="Archive (reversible)"><Trash2 size={13} /></IconButton>
          )}
          {onDeletePermanent && (
            <IconButton variant="danger" onClick={onDeletePermanent} title="Delete permanently"><Trash2 size={13} /></IconButton>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)', fontSize: 10, fontWeight: 600 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-muted)', flexShrink: 0 }} />Unit: {type.default_unit}</span>
        {type.is_candle && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#fb7185', fontSize: 10, fontWeight: 600 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#fb7185', flexShrink: 0 }} />Candle</span>}
        {type.is_pure_oil && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#9d3b5e', fontSize: 10, fontWeight: 600 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#9d3b5e', flexShrink: 0 }} />Pure Oil</span>}
      </div>

      {type.notes && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic' }}>{type.notes}</div>
      )}
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

const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
