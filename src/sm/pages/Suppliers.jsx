import { useState, useEffect } from 'react'
import { Plus, Edit2, X, Search, Package, Clock, Trash2 } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import IconButton from '../components/IconButton.jsx'
import { useToast } from '../SMModule.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const EMPTY_FORM = { name: '', contact_name: '', contact_email: '', contact_phone: '', website: '', lead_time: '', notes: '' }

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const { addToast } = useToast()

  useEffect(() => { loadSuppliers() }, [search])

  async function loadSuppliers() {
    setLoading(true)
    try {
      const params = search ? { search } : {}
      const res = await axios.get('/api/suppliers', { ...api(), params })
      setSuppliers(res.data)
    } catch { addToast('Failed to load suppliers', 'error') }
    finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null); setForm(EMPTY_FORM); setShowModal(true)
  }

  async function handleDelete() {
    try {
      await axios.delete(`/api/suppliers/${deleteTarget.id}`, api())
      addToast('Supplier deleted')
      setDeleteTarget(null)
      loadSuppliers()
    } catch (e) { addToast(e.response?.data?.error || 'Delete failed', 'error') }
  }

  function openEdit(s) {
    setEditing(s)
    setForm({
      name: s.name,
      contact_name: s.contact_name || '',
      contact_email: s.contact_email || '',
      contact_phone: s.contact_phone || '',
      website: s.website || '',
      lead_time: s.lead_time ?? '',
      notes: s.notes || '',
    })
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { addToast('Supplier name is required', 'error'); return }
    setSaving(true)
    try {
      const payload = { ...form, lead_time: form.lead_time !== '' ? parseInt(form.lead_time) : null }
      if (editing) {
        await axios.put(`/api/suppliers/${editing.id}`, payload, api())
        addToast('Supplier updated')
      } else {
        await axios.post('/api/suppliers', payload, api())
        addToast('Supplier created')
      }
      setShowModal(false)
      loadSuppliers()
    } catch (e) { addToast(e.response?.data?.error || 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2', marginBottom: 4 }}>Suppliers</h1>
          <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)' }}>Manage supplier contacts and lead times</p>
        </div>
        <Button onClick={openCreate}>
          <Plus size={15} /> New Supplier
        </Button>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search suppliers..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {/* List */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : suppliers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          No suppliers yet. Add your first supplier.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
          {suppliers.map(s => (
            <div key={s.id} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e8eaf2' }}>{s.name}</div>
                  {s.contact_name && <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', marginTop: 2 }}>{s.contact_name}</div>}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <IconButton onClick={() => openEdit(s)} title="Edit supplier"><Edit2 size={13} /></IconButton>
                  <IconButton variant="danger" onClick={() => setDeleteTarget(s)} title="Delete supplier"><Trash2 size={13} /></IconButton>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {s.contact_email && (
                  <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', minWidth: 14 }}>✉</span>
                    <a href={`mailto:${s.contact_email}`} style={{ color: '#60a5fa', textDecoration: 'none' }}
                      onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                      onMouseLeave={e => e.target.style.textDecoration = 'none'}>
                      {s.contact_email}
                    </a>
                  </div>
                )}
                {s.contact_phone && (
                  <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', minWidth: 14 }}>✆</span>
                    {s.contact_phone}
                  </div>
                )}
                {s.website && (
                  <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.3)', minWidth: 14 }}>🌐</span>
                    <a href={s.website.startsWith('http') ? s.website : `https://${s.website}`} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#60a5fa', textDecoration: 'none' }}
                      onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                      onMouseLeave={e => e.target.style.textDecoration = 'none'}>
                      {s.website}
                    </a>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                {s.lead_time != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                    <Clock size={12} style={{ color: '#fbbf24' }} />
                    <span style={{ color: '#fbbf24', fontWeight: 700 }}>{s.lead_time}d</span>
                    <span style={{ color: 'rgba(232,234,242,0.35)' }}>lead time</span>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, marginLeft: 'auto' }}>
                  <Package size={12} style={{ color: 'rgba(232,234,242,0.35)' }} />
                  <span style={{ color: 'rgba(232,234,242,0.5)' }}>{s.product_count || 0} product{s.product_count != 1 ? 's' : ''}</span>
                </div>
              </div>

              {s.notes && (
                <div style={{ marginTop: 10, padding: '7px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 7, fontSize: 11, color: 'rgba(232,234,242,0.4)', fontStyle: 'italic' }}>
                  {s.notes}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing ? 'Edit Supplier' : 'New Supplier'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <F label="Supplier Name *" full>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. PrintCo Australia" style={inp} />
              </F>
              <F label="Contact Person">
                <input value={form.contact_name} onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))} placeholder="John Smith" style={inp} />
              </F>
              <F label="Email">
                <input type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} placeholder="contact@supplier.com" style={inp} />
              </F>
              <F label="Phone">
                <input value={form.contact_phone} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} placeholder="+61 ..." style={inp} />
              </F>
              <F label="Website" full>
                <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} placeholder="www.supplier.com" style={inp} />
              </F>
              <F label="Lead Time (days)">
                <input type="number" min={0} value={form.lead_time} onChange={e => setForm(f => ({ ...f, lead_time: e.target.value }))} placeholder="7" style={inp} />
              </F>
              <F label="Notes" full>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="MOQ, payment terms, notes..." style={{ ...inp, resize: 'vertical', width: '100%' }} />
              </F>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Supplier'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Supplier"
          message={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
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

const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none' }
