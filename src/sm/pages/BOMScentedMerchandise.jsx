import { useState, useEffect } from 'react'
import { BookOpen, Tag, Briefcase, ChevronRight, X, Search, Package } from 'lucide-react'
import axios from 'axios'
import { useLocation } from 'wouter'
import { useToast } from '../SMModule.jsx'
import BOMEditor from '../components/BOMEditor.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export default function BOMScentedMerchandise() {
  const [tab, setTab] = useState('standard')
  const [standardMasters, setStandardMasters] = useState([])
  const [majorMasters, setMajorMasters] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [, navigate] = useLocation()
  const [highlightCode, setHighlightCode] = useState('') // master coming from a "Edit in BOM page" link
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  // Hash deep-link from BOMEditor's "Edit in BOM page" button. Switches to the right tab
  // (Standard vs Major), scrolls to the matching card, and glows it for ~3.5s.
  useEffect(() => {
    if (loading) return
    const m = (window.location.hash || '').match(/^#m-(.+)$/)
    if (!m) return
    const code = decodeURIComponent(m[1])
    const inStd = standardMasters.find(x => x.product_code === code)
    const inMaj = majorMasters.find(x => x.product_code === code)
    if (!inStd && !inMaj) return
    setTab(inStd ? 'standard' : 'major')
    setHighlightCode(code)
    const t1 = setTimeout(() => {
      const el = document.getElementById(`bom-card-${code}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    const t2 = setTimeout(() => {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      setHighlightCode('')
    }, 4000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [loading, standardMasters, majorMasters])

  async function load() {
    setLoading(true)
    try {
      const [std, maj] = await Promise.all([
        axios.get('/api/masters', { ...api(), params: { segment: 'STANDARD' } }),
        axios.get('/api/masters', { ...api(), params: { segment: 'MAJOR' } }),
      ])
      setStandardMasters(std.data)
      setMajorMasters(maj.data)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to load masters', 'error')
    } finally { setLoading(false) }
  }

  const masters = tab === 'standard' ? standardMasters : majorMasters
  const filtered = search.trim()
    ? masters.filter(m =>
        m.name?.toLowerCase().includes(search.toLowerCase()) ||
        m.product_code?.toLowerCase().includes(search.toLowerCase()) ||
        m.client_name?.toLowerCase().includes(search.toLowerCase())
      )
    : masters

  // For Major: group by client
  const majorGrouped = tab === 'major'
    ? filtered.reduce((acc, m) => {
        const key = m.client_name || 'Unknown client'
        if (!acc[key]) acc[key] = []
        acc[key].push(m)
        return acc
      }, {})
    : null

  // For Standard: group by container
  const standardGrouped = tab === 'standard'
    ? filtered.reduce((acc, m) => {
        const key = m.container_name?.trim() || 'No container'
        if (!acc[key]) acc[key] = []
        acc[key].push(m)
        return acc
      }, {})
    : null
  const standardGroupNames = standardGrouped
    ? Object.keys(standardGrouped).sort((a, b) => {
        if (a === 'No container') return 1
        if (b === 'No container') return -1
        return a.localeCompare(b)
      })
    : []

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <BookOpen size={22} color="#60a5fa" />
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Bill of Materials</h1>
      </div>
      <div style={{ fontSize: 13, color: 'rgba(232,234,242,0.5)', marginBottom: 22 }}>
        Centralized BOM management for Scented Merchandise masters
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <TabBtn active={tab === 'standard'} onClick={() => setTab('standard')} icon={<Tag size={13} />} label="Standard" count={standardMasters.length} color="#60a5fa" />
        <TabBtn active={tab === 'major'} onClick={() => setTab('major')} icon={<Briefcase size={13} />} label="Major Client" count={majorMasters.length} color="#a78bfa" />
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 18, maxWidth: 360 }}>
        <Search size={14} color="rgba(232,234,242,0.4)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${tab === 'standard' ? 'masters' : 'masters or client'}...`}
          style={{
            width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {loading ? (
        <div style={{ padding: 28, color: 'rgba(232,234,242,0.4)' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <EmptyState text={search ? `No matches for "${search}"` : `No ${tab === 'standard' ? 'Standard' : 'Major Client'} masters yet — create one in Stock page`} />
      ) : tab === 'standard' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {standardGroupNames.map(group => (
            <div key={group}>
              <div style={{ fontSize: 11, fontWeight: 700, color: group === 'No container' ? 'rgba(232,234,242,0.4)' : 'rgba(96,165,250,0.8)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Package size={12} /> {group}
                <span style={{ color: 'rgba(232,234,242,0.3)', fontWeight: 500 }}>· {standardGrouped[group].length} master{standardGrouped[group].length !== 1 ? 's' : ''}</span>
              </div>
              <MasterGrid masters={standardGrouped[group]} onSelect={setSelected} color="#60a5fa" highlightCode={highlightCode} />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {Object.entries(majorGrouped).map(([clientName, list]) => (
            <div key={clientName}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(167,139,250,0.7)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Briefcase size={12} /> {clientName} <span style={{ color: 'rgba(232,234,242,0.3)', fontWeight: 500 }}>· {list.length}</span>
              </div>
              <MasterGrid masters={list} onSelect={setSelected} color="#a78bfa" highlightCode={highlightCode} />
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


function TabBtn({ active, onClick, icon, label, count, color }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none',
      borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
      color: active ? color : 'rgba(232,234,242,0.5)',
      padding: '10px 16px', fontSize: 13, fontWeight: active ? 700 : 500,
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {icon} {label}
      {count > 0 && (
        <span style={{
          background: active ? `${color}33` : 'rgba(255,255,255,0.08)',
          color: active ? color : 'rgba(232,234,242,0.4)',
          padding: '0 6px', borderRadius: 10, fontSize: 10, fontWeight: 700, marginLeft: 2,
        }}>{count}</span>
      )}
    </button>
  )
}

function MasterGrid({ masters, onSelect, color, highlightCode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
      {masters.map(m => (
        <div key={m.id}
          id={`bom-card-${m.product_code}`}
          className={highlightCode === m.product_code ? 'bom-card-glow' : ''}
          onClick={() => onSelect(m)} style={{
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            borderLeft: `3px solid ${color}`, borderRadius: 12, padding: 14, cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>{m.name}</div>
            <ChevronRight size={13} color="rgba(232,234,242,0.3)" />
          </div>
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)', marginBottom: 8 }}>{m.product_code}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {m.container_name && <Chip color={color}>{m.container_name}</Chip>}
            {m.volume_ml && <Chip color="#60a5fa">{m.volume_ml}{m.volume_unit || 'ml'}</Chip>}
            {m.is_candle && <Chip color="#fb7185">🕯</Chip>}
            <Chip color="#4ade80">BOM: {m.bom_component_count || 0}</Chip>
          </div>
        </div>
      ))}
    </div>
  )
}

function BOMDrawer({ master, onClose }) {
  const isMajor = master.segment === 'MAJOR'
  const accent = isMajor ? '#a78bfa' : '#60a5fa'
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
              {isMajor ? <Briefcase size={14} color={accent} /> : <Tag size={14} color={accent} />}
              <span style={{ background: `${accent}26`, color: accent, padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800 }}>
                {isMajor ? 'MAJOR CLIENT' : 'STANDARD'} MASTER
              </span>
              {master.client_name && (
                <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>· {master.client_name}</span>
              )}
            </div>
            <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 18, color: '#e8eaf2' }}>{master.name}</h2>
            <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace', marginTop: 2 }}>{master.product_code}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'rgba(232,234,242,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        <BOMEditor productCode={master.product_code} master={master} clientId={isMajor ? master.client_id : undefined} segment={isMajor ? 'MAJOR' : 'SM'} />
      </div>
    </div>
  )
}

function Chip({ color, children }) {
  return <span style={{ background: `${color}1a`, color, padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700 }}>{children}</span>
}

function EmptyState({ text }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(232,234,242,0.3)' }}>
      <BookOpen size={36} style={{ opacity: 0.5, marginBottom: 12 }} />
      <div style={{ fontSize: 13 }}>{text}</div>
    </div>
  )
}
