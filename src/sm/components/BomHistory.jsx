import { useState, useEffect } from 'react'
import { X, History, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

// Version history + one-click restore for a master's BOM. The backend has
// snapshotted every change to product_bom_history all along (and exposes a
// rollback endpoint) — this is the UI that was missing. Reused by every screen
// that edits a BOM (via BOMEditor), so the history looks the same everywhere.
export default function BomHistory({ productCode, onClose, onRestored }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [restoring, setRestoring] = useState(null)
  const { addToast } = useToast()

  useEffect(() => {
    axios.get(`/api/product-bom/${encodeURIComponent(productCode)}/history`, api())
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(() => addToast('Failed to load history', 'error'))
      .finally(() => setLoading(false))
  }, [productCode])

  async function restore(version) {
    setRestoring(version)
    try {
      await axios.post(`/api/product-bom/${encodeURIComponent(productCode)}/rollback`, { version }, api())
      addToast(`BOM restored to version ${version}`)
      onRestored?.()
      onClose()
    } catch (e) {
      // Rollback is admin/root only (enforced server-side); surface that clearly.
      addToast(e.response?.status === 403 ? 'Only admin or root can restore a version' : (e.response?.data?.error || 'Restore failed'), 'error')
    } finally { setRestoring(null) }
  }

  const actionLabel = (a) => {
    if (!a) return 'changed'
    if (a.startsWith('rollback_v')) return `Rolled back to v${a.slice('rollback_'.length + 1)}`
    return ({ add: 'Component added', edit: 'Component edited', delete: 'Component removed', create: 'Created' }[a]) || a
  }
  const fmt = (d) => d ? new Date(d).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

  // rows come newest-first; the newest version IS the current BOM (nothing to restore to).
  const currentVersion = rows.length ? Math.max(...rows.map(r => r.version)) : null

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} className="sm-solid-panel" style={{ width: '100%', maxWidth: 580, maxHeight: '85vh', overflowY: 'auto', borderRadius: 14, border: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)', padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <History size={16} color="#a78bfa" />
            <span style={{ fontSize: 14, fontWeight: 800, color: '#e8eaf2' }}>BOM change history</span>
            <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{productCode}</span>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={14} />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>No changes recorded yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(row => {
              const isCurrent = row.version === currentVersion
              const isOpen = expanded === row.version
              const snap = Array.isArray(row.snapshot) ? row.snapshot : (() => { try { return JSON.parse(row.snapshot) } catch { return [] } })()
              return (
                <div key={row.version} style={{ border: `1px solid ${isCurrent ? 'rgba(167,139,250,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div onClick={() => setExpanded(isOpen ? null : row.version)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', background: isCurrent ? 'rgba(167,139,250,0.06)' : 'transparent' }}>
                    {isOpen ? <ChevronDown size={14} color="rgba(232,234,242,0.5)" /> : <ChevronRight size={14} color="rgba(232,234,242,0.5)" />}
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#a78bfa', fontFamily: 'monospace' }}>v{row.version}</span>
                    {isCurrent && <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 7px', borderRadius: 10, background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}>CURRENT</span>}
                    <span style={{ fontSize: 12, color: '#e8eaf2', flex: 1 }}>{actionLabel(row.action)}</span>
                    <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>{row.changed_by_name || 'system'} · {fmt(row.changed_at)}</span>
                  </div>
                  {isOpen && (
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '10px 12px' }}>
                      {snap.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', fontStyle: 'italic' }}>Empty BOM at this version.</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {snap.map((c, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(232,234,242,0.75)' }}>
                              <span>{c.component_name} <span style={{ color: 'rgba(232,234,242,0.35)', fontFamily: 'monospace' }}>{c.component_code}</span></span>
                              <span style={{ color: '#e8eaf2', fontWeight: 600 }}>{c.quantity_formula === 'ethanol_pct' ? 'ethanol %' : `${c.quantity_per_unit} ${c.component_unit || ''}`}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {!isCurrent && (
                        <button onClick={() => restore(row.version)} disabled={restoring === row.version}
                          style={{ marginTop: 12, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 8, padding: '6px 14px', cursor: restoring === row.version ? 'not-allowed' : 'pointer', color: '#fbbf24', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <RotateCcw size={12} /> {restoring === row.version ? 'Restoring…' : `Restore this version`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
