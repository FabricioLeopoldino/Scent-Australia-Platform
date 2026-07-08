import { useState, useEffect } from 'react'
import { Briefcase, Search, ChevronRight, Package, Tag, Layers, Truck } from 'lucide-react'
import axios from 'axios'
import Button from '../components/Button.jsx'
import { useLocation } from 'wouter'
import { useToast } from '../SMModule.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export default function MajorClients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [, navigate]          = useLocation()
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await axios.get('/api/major-clients', api())
      setClients(r.data)
    } catch { addToast('Failed to load major clients', 'error') }
    finally { setLoading(false) }
  }

  const displayed = clients.filter(c =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Briefcase size={20} color="#a78bfa" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Major Clients</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>Premium B2B clients with their own components from China and dedicated catalogs</p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => navigate('/customers')}>
          Manage Clients
        </Button>
      </div>

      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search major clients..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px 8px 34px', color: '#e8eaf2', fontSize: 13, outline: 'none' }}
        />
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>
          <Briefcase size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div>{clients.length === 0 ? 'No major clients yet' : 'No matches'}</div>
          {clients.length === 0 && (
            <div style={{ fontSize: 12, marginTop: 6 }}>Mark a client as Major in the Clients page to see them here</div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {displayed.map(c => (
            <ClientCard key={c.id} client={c} onClick={() => navigate(`/major-clients/${c.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({ client, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderLeft: '3px solid #a78bfa', borderRadius: 12, padding: 18,
      cursor: 'pointer', transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e8eaf2', marginBottom: 4 }}>{client.name}</div>
          {client.email && <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{client.email}</div>}
        </div>
        <ChevronRight size={14} color="rgba(232,234,242,0.3)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Stat icon={<Package size={11} />} label="Masters" value={client.master_count || 0} color="#fbbf24" />
        <Stat icon={<Layers size={11} />} label="Stock" value={client.client_stock_count || 0} color="#60a5fa" />
        <Stat icon={<Tag size={11} />} label="Labels" value={client.label_count || 0} color="#e879f9" />
        <Stat icon={<Truck size={11} />} label="Ship" value={client.awaiting_ship_count || 0} color="#4ade80" />
      </div>
    </div>
  )
}

function Stat({ icon, label, value, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'rgba(232,234,242,0.4)', marginBottom: 3 }}>
        {icon}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: value > 0 ? color : 'rgba(232,234,242,0.4)' }}>{value}</div>
      <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', fontWeight: 700, marginTop: 2 }}>{label}</div>
    </div>
  )
}
