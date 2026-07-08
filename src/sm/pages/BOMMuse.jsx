import { useState, useEffect } from 'react'
import { BookOpen, Star, ChevronRight, X, Search, Package } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import BOMEditor from '../components/BOMEditor.jsx'
import MuseHeader from '../components/MuseHeader.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export default function BOMMuse() {
  const [masters, setMasters] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [highlightCode, setHighlightCode] = useState('') // master product_code coming from a "Edit in BOM" link
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  // When navigated from a master drawer (BOMEditor "Edit in BOM page" button) the URL hash
  // is `#m-<product_code>`. Scroll to the matching card and glow it briefly so the user
  // immediately sees which master corresponds to the one they came from.
  useEffect(() => {
    if (loading || masters.length === 0) return
    const m = (window.location.hash || '').match(/^#m-(.+)$/)
    if (!m) return
    const code = decodeURIComponent(m[1])
    if (!masters.find(x => x.product_code === code)) return
    setHighlightCode(code)
    const t1 = setTimeout(() => {
      const el = document.getElementById(`bom-card-${code}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    const t2 = setTimeout(() => {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      setHighlightCode('')
    }, 4000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [loading, masters])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get('/api/masters', { ...api(), params: { segment: 'MUSE' } })
      setMasters(r.data)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to load masters', 'error')
    } finally { setLoading(false) }
  }

  const filtered = search.trim()
    ? masters.filter(m =>
        m.name?.toLowerCase().includes(search.toLowerCase()) ||
        m.product_code?.toLowerCase().includes(search.toLowerCase())
      )
    : masters

  // Group masters by container — keeps the page organized as the catalog grows
  const grouped = filtered.reduce((acc, m) => {
    const key = m.container_name?.trim() || 'No container'
    if (!acc[key]) acc[key] = []
    acc[key].push(m)
    return acc
  }, {})
  const groupNames = Object.keys(grouped).sort((a, b) => {
    if (a === 'No container') return 1
    if (b === 'No container') return -1
    return a.localeCompare(b)
  })

  return (
    <div style={{ padding: 28 }}>
      <MuseHeader subtitle="Bill of Materials" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <BookOpen size={22} color="#fbbf24" />
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Bill of Materials</h1>
      </div>
      <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.5)', marginBottom: 22 }}>
        Centralized BOM management for MUSE masters
      </div>

      <div style={{ position: 'relative', marginBottom: 18, maxWidth: 360 }}>
        <Search size={14} color="rgba(232,234,242,0.4)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search masters..."
          style={{
            width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {loading ? (
        <div style={{ padding: 28, color: 'rgba(232,234,242,0.4)' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(232,234,242,0.3)' }}>
          <BookOpen size={36} style={{ opacity: 0.5, marginBottom: 12 }} />
          <div style={{ fontSize: 13 }}>{search ? `No matches for "${search}"` : 'No MUSE masters yet — create one in Products'}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {groupNames.map(group => (
            <div key={group}>
              <div style={{ fontSize: 11, fontWeight: 700, color: group === 'No container' ? 'rgba(232,234,242,0.4)' : 'rgba(167,139,250,0.8)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Package size={12} /> {group}
                <span style={{ color: 'rgba(232,234,242,0.3)', fontWeight: 500 }}>· {grouped[group].length} master{grouped[group].length !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
                {grouped[group].map(m => (
                  <div key={m.id}
                    id={`bom-card-${m.product_code}`}
                    className={highlightCode === m.product_code ? 'bom-card-glow' : ''}
                    onClick={() => setSelected(m)} style={{
                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                    borderLeft: '3px solid #fbbf24', borderRadius: 12, padding: 14, cursor: 'pointer', transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4, gap: 10 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
                        {m.image_data
                          ? <img src={m.image_data} alt="" style={{ width: 40, height: 40, borderRadius: 7, objectFit: 'cover', border: '1px solid rgba(251,191,36,0.25)', flexShrink: 0 }} />
                          : <div style={{ width: 40, height: 40, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Star size={14} color="rgba(232,234,242,0.2)" /></div>}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{m.name}</div>
                          <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)', marginTop: 2 }}>{m.product_code}</div>
                        </div>
                      </div>
                      <ChevronRight size={13} color="rgba(232,234,242,0.3)" />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {m.volume_ml && <Chip color="#60a5fa">{m.volume_ml}{m.volume_unit || 'ml'}</Chip>}
                      {m.is_candle && <Chip color="#fb7185">🕯</Chip>}
                      <Chip color="#4ade80">BOM: {m.bom_component_count || 0}</Chip>
                      <Chip color="#a78bfa">Fragrances: {m.fragrance_count || 0}</Chip>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <BOMDrawer master={selected} onClose={() => { setSelected(null); load() }} />
      )}
    </div>
  )
}

function BOMDrawer({ master, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 720, height: '100vh',
        background: 'var(--card-bg)', borderLeft: '1px solid var(--border-h)', boxShadow: 'var(--shadow-md)',
        overflowY: 'auto', padding: 28,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Star size={14} color="#fbbf24" />
              <span style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800 }}>MUSE MASTER</span>
            </div>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 18, color: '#e8eaf2' }}>{master.name}</h2>
            <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', marginTop: 2 }}>{master.product_code}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        <BOMEditor productCode={master.product_code} master={master} segment="MUSE" />
      </div>
    </div>
  )
}

function Chip({ color, children }) {
  return <span style={{ background: `${color}1a`, color, padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700 }}>{children}</span>
}
