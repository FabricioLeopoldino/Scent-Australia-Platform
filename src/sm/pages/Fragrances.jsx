import { useState, useEffect } from 'react'
import { Search, FlaskConical, Lock, Info } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import { splitVolume } from '../utils/volume.js'
import GlowingEffect from '../components/GlowingEffect.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

// Phase B (owner 2026-07-28): this page is a READ-ONLY view of the shared
// Fragrance Library — the SA oils (sa.products OILS) with their REAL stock —
// NOT the retired legacy FRAG_* catalog (which was always 0 here). Oil is
// created and stocked in SA (Scent Stock Manager); to change stock, go there.
// Data source: /api/fragrance-library?segment= (D14), filtered by exclusivity.
const SEGMENT_BY_MODULE = { MUSE: 'MUSE' } // anything else (SM/OPS) → STANDARD

export default function Fragrances() {
  const activeModule = typeof localStorage !== 'undefined' ? localStorage.getItem('platform_active_module') : null
  const segment = SEGMENT_BY_MODULE[activeModule] || 'STANDARD'
  const [oils, setOils]       = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get('/api/fragrance-library', { ...api(), params: { segment } })
      setOils(Array.isArray(r.data) ? r.data : [])
    } catch { addToast('Failed to load the Fragrance Library', 'error') }
    finally { setLoading(false) }
  }

  const displayed = oils.filter(o =>
    !search ||
    (o.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (o.code || '').toLowerCase().includes(search.toLowerCase())
  )
  const totalMl = oils.reduce((sum, o) => sum + parseFloat(o.current_stock || 0), 0)
  const emptyCount = oils.filter(o => parseFloat(o.current_stock || 0) <= 0).length

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <FlaskConical size={20} color="#a78bfa" />
        <div>
          <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Fragrance Library</h1>
          <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Shared oil pool — the SA Fragrance Library, with live stock</p>
        </div>
      </div>

      {/* Read-only note — oil is managed in SA */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 8, padding: '9px 14px', margin: '14px 0 22px', fontSize: 12.5, color: 'rgba(232,234,242,0.7)' }}>
        <Info size={14} color="#60a5fa" style={{ flexShrink: 0 }} />
        Read-only view. Oils are registered and their stock managed in <strong style={{ color: '#e8eaf2' }}>Scent Stock Manager (SA)</strong> — open the <strong style={{ color: '#e8eaf2' }}>Fragrance Library</strong> tile to manage them.
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 22, maxWidth: 560 }}>
        <Stat label="Oils available" value={oils.length} color="#a78bfa" />
        <Stat label="Total Stock" value={(() => { const s = splitVolume(totalMl, 'ml'); return `${s.value} ${s.unit}` })()} color="#60a5fa" />
        <Stat label="Out of Stock" value={emptyCount} color={emptyCount > 0 ? '#f87171' : '#4ade80'} />
      </div>

      {/* Search */}
      <div style={{ position: 'relative', maxWidth: 360, marginBottom: 20 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search oils..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <FlaskConical size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>{oils.length === 0 ? 'No oils in the Fragrance Library yet' : 'No matches'}</div>
          {oils.length === 0 && <div style={{ fontSize: 12, marginTop: 6 }}>Register oils in Scent Stock Manager (SA)</div>}
        </div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'visible', position: 'relative' }}>
          <GlowingEffect spread={30} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Oil', 'Code', 'Stock (SA)', 'Availability', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(o => {
                const stock = parseFloat(o.current_stock || 0)
                const isEmpty = stock <= 0
                // Oils are always mL (SA convention); force 'ml' regardless of the
                // DB's literal case ('mL') so splitVolume converts to L like the SA page.
                const s = splitVolume(stock, 'ml')
                return (
                  <tr key={o.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, color: '#a78bfa' }}>{o.name}</td>
                    <td style={{ padding: '10px 16px', fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)' }}>{o.code}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: isEmpty ? '#f87171' : '#4ade80' }}>{s.value}</span>
                      <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginLeft: 4 }}>{s.unit}</span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {o.exclusivity
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'rgba(251,191,36,0.1)', color: '#fbbf24', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}><Lock size={10} /> {o.exclusivity} only</span>
                        : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>Shared</span>}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {isEmpty
                        ? <span style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>OUT</span>
                        : <span style={{ background: 'rgba(34,197,94,0.1)', color: '#4ade80', padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>OK</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {displayed.length} oil{displayed.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderLeft: `3px solid ${color}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 22, fontFamily: 'Archivo Black, sans-serif', color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginTop: 4 }}>{label}</div>
    </div>
  )
}
