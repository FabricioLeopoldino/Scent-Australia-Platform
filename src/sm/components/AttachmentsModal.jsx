import { useState, useEffect, useRef } from 'react'
import { Paperclip, X, Upload, Download, Eye, Trash2, File } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export const ATTACH_TYPES = [
  { value: 'safety_data',   label: 'Safety Data Sheet (SDS)' },
  { value: 'formula_sheet', label: 'Formula Sheet' },
  { value: 'artwork',       label: 'Artwork / Label' },
  { value: 'spec_sheet',    label: 'Specification Sheet' },
  { value: 'certificate',   label: 'Certificate (CoA, CoC)' },
  { value: 'photo',         label: 'Photo' },
  { value: 'other',         label: 'Other' },
]
export const ALLOWED_TYPES = ['application/pdf','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/jpeg','image/jpg','image/png']
export const ALLOWED_EXT = '.pdf,.xls,.xlsx,.jpg,.jpeg,.png'

export default function AttachmentsModal({ product, onClose }) {
  const [attachments, setAttachments] = useState([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [form, setForm] = useState({ attachment_type: 'formula_sheet', version: '', expires_at: '', notes: '' })
  const [file, setFile] = useState(null)
  const fileRef = useRef(null)
  const { addToast } = useToast()
  const user = (() => { try { return JSON.parse(localStorage.getItem('platform_user') || '{}') } catch { return {} } })() || {}
  const canDelete = ['root','admin'].includes(user?.role)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get(`/api/products/${product.id}/attachments`, api())
      setAttachments(r.data)
    } catch (e) { addToast(e.response?.data?.error || 'Failed to load attachments', 'error') }
    finally { setLoading(false) }
  }

  function handleFileChange(e) {
    const f = e.target.files[0]
    if (!f) return
    if (!ALLOWED_TYPES.includes(f.type)) { addToast('Unsupported file type. Use PDF, XLS, XLSX, JPG, or PNG.', 'error'); return }
    if (f.size > 10 * 1024 * 1024) { addToast('File exceeds 10MB limit', 'error'); return }
    setFile(f)
  }

  async function handleUpload() {
    if (!file) { addToast('Select a file to upload', 'error'); return }
    setUploading(true)
    try {
      const reader = new FileReader()
      reader.onload = async (ev) => {
        const base64 = ev.target.result.split(',')[1]
        await axios.post(`/api/products/${product.id}/attachments`, {
          filename: file.name,
          content_type: file.type,
          file_data: base64,
          ...form
        }, api())
        addToast('Attachment uploaded')
        setShowUpload(false)
        setFile(null)
        setForm({ attachment_type: 'formula_sheet', version: '', expires_at: '', notes: '' })
        load()
      }
      reader.onerror = () => addToast('File read error', 'error')
      reader.readAsDataURL(file)
    } catch (e) { addToast(e.response?.data?.error || 'Upload failed', 'error') }
    finally { setUploading(false) }
  }

  async function handleDelete(att) {
    setDeleting(att.id)
    try {
      await axios.delete(`/api/products/${product.id}/attachments/${att.id}`, api())
      addToast('Attachment deleted')
      load()
    } catch (e) { addToast(e.response?.data?.error || 'Delete failed', 'error') }
    finally { setDeleting(null) }
  }

  function canView(att) {
    const ct = att.content_type || ''
    const fn = (att.filename || '').toLowerCase()
    return ct.includes('image') || ct.includes('pdf') || fn.endsWith('.pdf') || fn.endsWith('.jpg') || fn.endsWith('.jpeg') || fn.endsWith('.png')
  }

  async function handleDownload(att) {
    try {
      const res = await axios.get(`/api/products/${product.id}/attachments/${att.id}/download`, { ...api(), responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = att.filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch { addToast('Download failed', 'error') }
  }

  async function handleView(att) {
    try {
      const res = await axios.get(`/api/products/${product.id}/attachments/${att.id}/download`, { ...api(), responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data], { type: att.content_type || 'application/octet-stream' }))
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    } catch { addToast('Failed to open file', 'error') }
  }

  function fmtSize(bytes) {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function attachIcon(contentType) {
    if (contentType?.includes('image')) return <File size={14} color="#60a5fa" />
    if (contentType?.includes('pdf')) return <File size={14} color="#f87171" />
    return <File size={14} color="#fbbf24" />
  }

  const al = { display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }
  const ai = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none', boxSizing: 'border-box' }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Paperclip size={16} color="var(--accent)" />
              <h2>Attachments</h2>
            </div>
            <p>{product.name} <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>{product.product_code}</span></p>
          </div>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal-body">

        {loading ? (
          <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', padding: '12px 0' }}>Loading...</div>
        ) : attachments.length === 0 ? (
          <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.3)', padding: '16px 0', textAlign: 'center' }}>No attachments yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {attachments.map(att => {
              const typeLabel = ATTACH_TYPES.find(t => t.value === att.attachment_type)?.label || att.attachment_type
              const expired = att.expires_at && new Date(att.expires_at) < new Date()
              return (
                <div key={att.id} style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${expired ? 'rgba(248,113,113,0.25)' : 'rgba(255,255,255,0.09)'}`, borderRadius: 9, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flexShrink: 0 }}>{attachIcon(att.content_type)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#e8eaf2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{att.filename}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.1)', padding: '1px 6px', borderRadius: 10 }}>{typeLabel}</span>
                      {att.version && <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 10 }}>v{att.version}</span>}
                      {expired && <span style={{ fontSize: 10, fontWeight: 700, color: '#f87171' }}>EXPIRED</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginTop: 2 }}>
                      {fmtSize(att.file_size)}
                      {att.expires_at && <span style={{ marginLeft: 8 }}>Expires: {new Date(att.expires_at).toLocaleDateString('en-AU')}</span>}
                      <span style={{ marginLeft: 8 }}>{att.uploaded_by_name || 'Unknown'} · {new Date(att.created_at).toLocaleDateString('en-AU')}</span>
                    </div>
                    {att.notes && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>{att.notes}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {canView(att) && (
                      <button onClick={() => handleView(att)} title="View"
                        style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: 6, padding: '5px 8px', color: '#a78bfa', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <Eye size={13} />
                      </button>
                    )}
                    <button onClick={() => handleDownload(att)} title="Download"
                      style={{ background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 6, padding: '5px 8px', color: '#60a5fa', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                      <Download size={13} />
                    </button>
                    {canDelete && (
                      <button onClick={() => handleDelete(att)} disabled={deleting === att.id} style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 6, padding: '5px 8px', cursor: deleting === att.id ? 'not-allowed' : 'pointer', color: '#f87171', opacity: deleting === att.id ? 0.5 : 1 }}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {!showUpload ? (
          <button onClick={() => setShowUpload(true)} style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 0', color: 'rgba(232,234,242,0.6)', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Upload size={13} /> Upload Attachment
          </button>
        ) : (
          <div style={{ padding: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Upload File</span>
              <button onClick={() => { setShowUpload(false); setFile(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,234,242,0.4)', fontSize: 11 }}>Cancel</button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <input ref={fileRef} type="file" accept={ALLOWED_EXT} onChange={handleFileChange} style={{ display: 'none' }} />
              <button onClick={() => fileRef.current?.click()} style={{ width: '100%', background: file ? 'rgba(96,165,250,0.08)' : 'rgba(255,255,255,0.04)', border: `1px dashed ${file ? 'rgba(96,165,250,0.35)' : 'rgba(255,255,255,0.15)'}`, borderRadius: 8, padding: '14px 0', color: file ? '#60a5fa' : 'rgba(232,234,242,0.45)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                {file ? `📄 ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)` : 'Click to select file (PDF, XLS, JPG, PNG · max 10MB)'}
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={al}>Type *</label>
                <select value={form.attachment_type} onChange={e => setForm(f => ({ ...f, attachment_type: e.target.value }))} style={{ ...ai, cursor: 'pointer', appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(232,234,242,0.4)'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}>
                  {ATTACH_TYPES.map(t => <option key={t.value} value={t.value} style={{ background: '#13132b', color: '#e8eaf2' }}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label style={al}>Version (optional)</label>
                <input value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))} style={ai} placeholder="e.g. 2.1, Rev A" />
              </div>
              <div>
                <label style={al}>Expiry Date (optional)</label>
                <input type="date" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} style={ai} />
              </div>
              <div>
                <label style={al}>Notes (optional)</label>
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={ai} placeholder="Any notes..." />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setShowUpload(false); setFile(null) }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleUpload} disabled={uploading || !file}>
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        )}

        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
