import { useState, useEffect, useCallback } from 'react'
import { Search, Download, History as HistoryIcon, ScrollText } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import { fmt } from '../utils/date.js'
import GlowingEffect from '../components/GlowingEffect.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

// Centralized cross-system report (owner 2026-07-28): one page that unions the
// stock history (kind="history") or audit events (kind="activity") of SA +
// Scented Merchandise + MUSE, with a System column, filters and CSV export.
// Backend: /api/platform/history|activity (+ /export). Admin/root only.
const SYS_COLOR = { SA: '#60a5fa', 'Scented Merchandise': '#4ade80', MUSE: '#fbbf24', Platform: '#a78bfa' }

// A movement can belong to two systems at once — oil leaves SA's shelf BECAUSE
// of a MUSE sale, and the label says "SA · MUSE". Colour it by the business
// that caused it (the second half), because that is the part the SA-only rows
// around it do not have. Without this the rows this feature exists to surface
// would be the only grey ones on the screen.
const sysColour = (system) =>
  SYS_COLOR[system] || SYS_COLOR[String(system || '').split(' · ').pop()] || '#94a3b8'

// The two tabs do not cover the same systems. Stock movements only ever belong
// to SA or SM — the platform schema has no transactions table. Audit events do
// include platform-level ones (sign-ins, module access, password changes,
// transfers, product links), so only Activity offers that filter.
const CONFIG = {
  history: {
    title: 'History', sub: 'All stock movements across SA · Scented Merchandise · MUSE',
    icon: HistoryIcon, endpoint: 'history', searchPlaceholder: 'Search product or code…',
    columns: ['Date', 'System', 'By', 'Type', 'Product', 'Qty', 'Balance after', 'Notes'],
    systems: ['ALL', 'SA', 'Scented Merchandise', 'MUSE'],
  },
  activity: {
    title: 'Activity', sub: 'All system actions across SA · Scented Merchandise · MUSE · Platform',
    icon: ScrollText, endpoint: 'activity', searchPlaceholder: 'Search entity or action…',
    columns: ['Date', 'System', 'By', 'Action', 'Entity', 'Details'],
    systems: ['ALL', 'SA', 'Scented Merchandise', 'MUSE', 'Platform'],
  },
}


// The Details column held raw JSON on one clipped line, so it read as
// `{"unit": "mL", "category": "OILS", "orderNumber": "30.7.26", "productCo` —
// broken mid-key, and useless on the page that is meant to be the audit record.
// This turns it into something a person reads: keys as words, values inline, a
// list summarised by its first entry rather than dumped.
const LABEL = { shopify_order_id: 'shopify id', shopify_order_number: 'order', refund_id: 'refund',
  order_status: 'status', product_type: 'format', productCode: 'product', orderNumber: 'order',
  totalQuantity: 'qty', receiveType: 'received', shopify_order: 'order' }
const words = (k) => LABEL[k] || k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

function readable(raw) {
  if (!raw) return '—'
  let o
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return String(raw) }
  if (o == null || typeof o !== 'object') return String(raw)
  const parts = []
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) {
      // "lines" is the common one: show what it is, not how it is stored.
      const first = v[0]
      const shown = first && typeof first === 'object'
        ? Object.values(first).filter((x) => typeof x !== 'object').slice(0, 3).join(' ')
        : String(first ?? '')
      const noun = v.length === 1 ? words(k).replace(/s$/, '') : words(k)
      parts.push(`${v.length} ${noun}: ${shown}${v.length > 1 ? ' …' : ''}`)
    } else if (typeof v === 'object') {
      // a from/to pair, as product_updated writes
      const inner = Object.entries(v).map(([a, b]) => `${a} ${b}`).join(' → ')
      parts.push(`${words(k)} ${inner}`)
    } else {
      parts.push(`${words(k)} ${v}`)
    }
  }
  return parts.length ? parts.join('  ·  ') : '—'
}

function SysBadge({ system }) {
  const c = sysColour(system)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: c, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, flexShrink: 0 }} />
      {system}
    </span>
  )
}

const SCOPE_BY_MODULE = { MUSE: 'MUSE', SM: 'Scented Merchandise', OPS: 'SM' }
const SCOPE_LABEL = { MUSE: 'MUSE', 'Scented Merchandise': 'Scented Merchandise', SM: 'Scented Merchandise & MUSE' }

export default function HistoryActivity({ kind = 'history' }) {
  const cfg = CONFIG[kind]
  // Opened inside a module view (MUSE / Scented / P&O) → scope to that module's own
  // data only; the top-level "History & Activity" tile (REPORTS view) shows all systems.
  const activeModule = typeof localStorage !== 'undefined' ? localStorage.getItem('platform_active_module') : null
  const scope = SCOPE_BY_MODULE[activeModule]  // undefined => full cross-system
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [system, setSystem] = useState(scope || 'ALL')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [exporting, setExporting] = useState(false)
  const { addToast } = useToast()

  const params = useCallback(() => {
    const p = {}
    if (system !== 'ALL') p.system = system
    if (from) p.from = from
    if (to) p.to = to
    if (search) p.search = search
    return p
  }, [system, from, to, search])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await axios.get(`/api/platform/${cfg.endpoint}`, { ...api(), params: params() })
      setRows(Array.isArray(r.data) ? r.data : [])
    } catch (e) {
      addToast(e.response?.status === 403 ? 'Admin or root only' : `Failed to load ${kind}`, 'error')
      setRows([])
    } finally { setLoading(false) }
  }, [cfg.endpoint, kind, params, addToast])

  // debounce the search; other filters apply immediately
  useEffect(() => { const t = setTimeout(load, search ? 300 : 0); return () => clearTimeout(t) }, [load, search])

  async function exportCsv() {
    setExporting(true)
    try {
      const r = await axios.get(`/api/platform/${cfg.endpoint}/export`, { ...api(), params: params(), responseType: 'blob' })
      const url = URL.createObjectURL(r.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      addToast(e.response?.status === 403 ? 'Admin or root only' : 'Export failed', 'error')
    } finally { setExporting(false) }
  }

  const Icon = cfg.icon
  const chip = active => ({
    background: active ? '#2563eb' : 'rgba(255,255,255,0.05)',
    color: active ? 'white' : 'rgba(232,234,242,0.6)',
    border: active ? 'none' : '1px solid rgba(255,255,255,0.1)',
    borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
  })
  const inp = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 10px', color: '#e8eaf2', fontSize: 12, outline: 'none' }

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon size={22} color="#60a5fa" />
          <div>
            <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>{cfg.title}</h1>
            <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>{scope ? `${SCOPE_LABEL[scope]} only` : cfg.sub}</p>
          </div>
        </div>
        <button onClick={exportCsv} disabled={exporting || rows.length === 0}
          style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.35)', borderRadius: 8, padding: '8px 14px', color: '#4ade80', fontSize: 12, fontWeight: 700, cursor: exporting || rows.length === 0 ? 'not-allowed' : 'pointer', opacity: exporting || rows.length === 0 ? 0.5 : 1 }}>
          <Download size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {/* Controls — SA glowing panel */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 18 }}>
        <GlowingEffect spread={30} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {scope ? (
            <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(232,234,242,0.55)' }}>Showing: {SCOPE_LABEL[scope]}</span>
          ) : cfg.systems.map(s => (
            <button key={s} onClick={() => setSystem(s)} style={chip(system === s)}>{s === 'ALL' ? 'All Systems' : s}</button>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} title="From" />
            <span style={{ color: 'rgba(232,234,242,0.4)', fontSize: 12 }}>→</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} title="To" />
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={cfg.searchPlaceholder} style={{ ...inp, paddingLeft: 28, width: 220 }} />
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'rgba(232,234,242,0.3)', fontSize: 14 }}>No {kind} records for these filters</div>
      ) : (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'visible', position: 'relative' }}>
          <GlowingEffect spread={30} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {cfg.columns.map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.system}-${r.id}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '9px 14px', fontSize: 11, color: 'rgba(232,234,242,0.5)', whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</td>
                  <td style={{ padding: '9px 14px' }}><SysBadge system={r.system} /></td>
                  <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.75)', whiteSpace: 'nowrap' }}>{r.performed_by}</td>
                  {kind === 'history' ? (
                    <>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.7)' }}>{r.type}</td>
                      <td style={{ padding: '9px 14px', fontSize: 13, color: '#e8eaf2' }}>
                        {r.product_name || '—'}
                        {r.product_code && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', fontFamily: 'monospace', marginLeft: 6 }}>{r.product_code}</span>}
                      </td>
                      {/* Direction comes from the SERVER, from the transaction type — it is
                          not in the number. quantity is stored as a MAGNITUDE, so the old
                          code (`quantity > 0 ? '+' : ''`, green unless negative) printed
                          every sale as a green "+400 mL". The owner spotted it: the screen
                          was stating the opposite of what happened.
                          A type that does not commit to a direction (an adjustment can go
                          either way) renders with no sign and no colour. Saying nothing
                          beats saying the wrong thing. */}
                      <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
                        color: r.direction === 'out' ? '#f87171' : r.direction === 'in' ? '#4ade80' : 'var(--text-muted)' }}>
                        {r.quantity != null
                          ? `${r.direction === 'out' ? '−' : r.direction === 'in' ? '+' : ''}${Math.abs(Number(r.quantity)).toLocaleString()}`
                          : '—'} <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>{r.unit || ''}</span>
                      </td>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.6)', whiteSpace: 'nowrap' }}>{r.balance_after != null ? Number(r.balance_after).toLocaleString() : '—'}</td>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: 'rgba(232,234,242,0.45)', maxWidth: 220 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>{r.action}</td>
                      <td style={{ padding: '9px 14px', fontSize: 13, color: '#e8eaf2' }}>
                        {r.entity_name || '—'}
                        {r.entity_type && <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginLeft: 6 }}>{r.entity_type}</span>}
                      </td>
                      <td style={{ padding: '9px 14px', fontSize: 11, color: 'rgba(232,234,242,0.4)', maxWidth: 320 }}>
                        {/* title carries the full text so nothing is lost when it wraps */}
                        <div title={r.details || ''} style={{ lineHeight: 1.5, wordBreak: 'break-word' }}>{readable(r.details)}</div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(232,234,242,0.35)' }}>
            {rows.length.toLocaleString()} record{rows.length !== 1 ? 's' : ''}{rows.length >= 10000 ? ' (capped — narrow the filters)' : ''}
          </div>
        </div>
      )}
    </div>
  )
}
