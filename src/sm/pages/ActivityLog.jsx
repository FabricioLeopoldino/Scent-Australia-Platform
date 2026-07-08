import { useState, useEffect } from 'react'
import { Search, Download } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import SearchSelect from '../components/SearchSelect.jsx'
import { fmt } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const ACTION_META = {
  product_created:               { label: 'Product Created',        color: '#34d399' },
  product_deleted:               { label: 'Product Deleted',        color: '#f87171' },
  client_created:                { label: 'Client Created',         color: '#34d399' },
  user_created:                  { label: 'User Created',           color: '#34d399' },
  po_created:                    { label: 'PO Created',             color: '#f59e0b' },
  po_cancelled:                  { label: 'PO Cancelled',           color: '#f87171' },
  po_received:                   { label: 'PO Received',            color: '#34d399' },
  production_order_created:      { label: 'Order Created',          color: '#60a5fa' },
  production_order_deleted:      { label: 'Order Deleted',          color: '#f87171' },
  production_order_status_changed: { label: 'Status Changed',       color: '#a78bfa' },
  production_started:            { label: 'Production Started',     color: '#f472b6' },
  production_completed:          { label: 'Production Completed',   color: '#4ade80' },
  sku_published:                 { label: 'SKU Published',          color: '#818cf8' },
}

const PRESETS = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7days',     label: '7 Days' },
  { key: 'thismonth', label: 'This Month' },
  { key: 'all',       label: 'All Time' },
]

function getRange(key) {
  const now = new Date()
  const p = d => String(d).padStart(2,'0')
  const f = d => `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`
  switch(key) {
    case 'today':     return { from: f(now), to: f(now) }
    case 'yesterday': { const d = new Date(now); d.setDate(d.getDate()-1); return { from: f(d), to: f(d) } }
    case '7days':     { const d = new Date(now); d.setDate(d.getDate()-7); return { from: f(d), to: f(now) } }
    case 'thismonth': return { from: `${now.getFullYear()}-${p(now.getMonth()+1)}-01`, to: f(now) }
    default:          return { from: '', to: '' }
  }
}

export default function ActivityLog() {
  const [logs, setLogs]         = useState([])
  const [users, setUsers]       = useState([])
  const [loading, setLoading]   = useState(false)
  const [preset, setPreset]     = useState('7days')
  const [from, setFrom]         = useState('')
  const [to, setTo]             = useState('')
  const [userFilter, setUserFilter]   = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [search, setSearch]     = useState('')
  const { addToast } = useToast()

  useEffect(() => {
    const r = getRange(preset)
    setFrom(r.from); setTo(r.to)
    loadUsers()
  }, [preset])

  useEffect(() => { loadLogs() }, [from, to, userFilter, actionFilter])

  async function loadUsers() {
    try {
      const res = await axios.get('/api/users', api())
      setUsers(res.data)
    } catch {}
  }

  async function loadLogs() {
    setLoading(true)
    try {
      const params = {}
      if (from) params.from = from + 'T00:00:00'
      if (to)   params.to   = to   + 'T23:59:59'
      if (userFilter)   params.user_id = userFilter
      if (actionFilter) params.action  = actionFilter
      const res = await axios.get('/api/audit', { ...api(), params })
      setLogs(res.data)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to load log', 'error')
    } finally { setLoading(false) }
  }

  const displayed = logs.filter(l =>
    !search ||
    (l.entity_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (l.user_name   || '').toLowerCase().includes(search.toLowerCase()) ||
    (l.action      || '').toLowerCase().includes(search.toLowerCase())
  )

  const allActions = [...new Set(logs.map(l => l.action))]


  return (
    <div style={{ padding: 28 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Activity Log</h1>
        <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 4 }}>All system actions — admin and root only</p>
      </div>

      {/* Date presets */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {PRESETS.map(p => (
          <button key={p.key} onClick={() => setPreset(p.key)} style={{
            background: preset === p.key ? '#2563eb' : 'rgba(255,255,255,0.05)',
            color: preset === p.key ? 'white' : 'rgba(232,234,242,0.6)',
            border: preset === p.key ? 'none' : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 20, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer'
          }}>{p.label}</button>
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 6 }}>
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset('') }} style={inp2} />
          <span style={{ color: 'rgba(232,234,242,0.4)', fontSize: 12 }}>→</span>
          <input type="date" value={to}   onChange={e => { setTo(e.target.value);   setPreset('') }} style={inp2} />
        </div>
      </div>

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ width: 180 }}>
          <SearchSelect
            value={userFilter}
            onChange={v => setUserFilter(v)}
            options={users.map(u => ({ value: u.id, label: u.name }))}
            placeholder="All Users"
          />
        </div>
        <div style={{ width: 210 }}>
          <SearchSelect
            value={actionFilter}
            onChange={v => setActionFilter(v)}
            options={allActions.map(a => ({ value: a, label: ACTION_META[a]?.label || a }))}
            placeholder="All Actions"
          />
        </div>
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ ...inp2, paddingLeft: 28, width: 200 }} />
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'rgba(232,234,242,0.4)', alignSelf: 'center' }}>
          {displayed.length} event{displayed.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Log table */}
      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading...</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Date', 'User', 'Action', 'Entity', 'Details'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: '32px 14px', textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No activity in this period</td></tr>
              ) : displayed.map(log => {
                const meta = ACTION_META[log.action] || { label: log.action, color: '#e8eaf2' }
                return (
                  <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '9px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', whiteSpace: 'nowrap' }}>{fmt(log.created_at)}</td>
                    <td style={{ padding: '9px 14px', fontSize: 12, color: '#e8eaf2', fontWeight: 600 }}>{log.user_name || '—'}</td>
                    <td style={{ padding: '9px 14px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: meta.color, fontSize: 10, fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />{meta.label}</span>
                    </td>
                    <td style={{ padding: '9px 14px' }}>
                      {log.entity_name && <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf2' }}>{log.entity_name}</div>}
                      {log.entity_type && <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', textTransform: 'uppercase' }}>{log.entity_type}</div>}
                    </td>
                    <td style={{ padding: '9px 14px', fontSize: 11, color: 'rgba(232,234,242,0.45)', maxWidth: 240 }}>
                      {log.details && Object.keys(log.details).length > 0
                        ? Object.entries(log.details).map(([k, v]) => `${k}: ${v}`).join(' · ')
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const inp2 = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none' }
