import { useState, useEffect, useCallback, useRef } from 'react'
import { Search, FileText, AlertTriangle, CheckCircle2 } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import GlowingEffect from '../components/GlowingEffect.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

// Statement — the question the History list could not answer (owner 2026-08-19).
//
// He put it plainly: he thinks of History & Activity as an audit source. His
// test case was one fragrance over one month — how much was there, how much was
// used, by which business. Searching the list already worked; it returned 271
// rows for Zen Garden and not one of them answered him. Only their total would.
//
// So this is not another filter. It is open, move, close, and check the closing
// figure against the shelf. When those two disagree, something changed stock
// without going through the ledger, and saying so is the point of the page.
const fmt = (n, unit) => n == null ? '—'
  : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`

const firstOfMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export default function Statement() {
  const [q, setQ] = useState('')
  const [options, setOptions] = useState([])
  const [picked, setPicked] = useState(null)
  const [from, setFrom] = useState(firstOfMonth())
  const [to, setTo] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const { addToast } = useToast()

  // Search is debounced; picking is explicit. "Santal" matches seven different
  // products, and a statement must never quietly average across more than one.
  useEffect(() => {
    if (!q.trim()) { setOptions([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await axios.get('/api/platform/statement/products', { ...api(), params: { q } })
        setOptions(r.data || []); setOpen(true)
      } catch { setOptions([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const load = useCallback(async () => {
    if (!picked) return
    setLoading(true)
    try {
      const r = await axios.get('/api/platform/statement', {
        ...api(),
        params: { schema: picked.schema, code: picked.code, from: from || undefined, to: to || undefined },
      })
      setData(r.data)
    } catch (e) {
      addToast(e.response?.status === 403 ? 'Admin or root only' : 'Could not build the statement', 'error')
      setData(null)
    } finally { setLoading(false) }
  }, [picked, from, to, addToast])

  useEffect(() => { load() }, [load])

  const inp = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 11px', color: '#e8eaf2', fontSize: 12, outline: 'none' }
  const unit = data?.product?.unit || ''

  return (
    <div style={{ padding: 28, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
        <FileText size={22} color="#60a5fa" />
        <div>
          <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Statement</h1>
          <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>
            One product, one period: what was there, what moved, and who used it.
          </p>
        </div>
      </div>

      {/* Pick a product and a period */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 18 }}>
        <GlowingEffect spread={30} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div ref={box} style={{ position: 'relative', flex: 1, minWidth: 280 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'rgba(232,234,242,0.4)' }} />
            <input
              value={picked ? `${picked.name} · ${picked.code}` : q}
              onChange={(e) => { setPicked(null); setData(null); setQ(e.target.value) }}
              onFocus={() => { if (picked) { setQ(''); setPicked(null); setData(null) } }}
              placeholder="Fragrance, component, label…"
              style={{ ...inp, paddingLeft: 28, width: '100%' }} />
            {open && options.length > 0 && !picked && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: '#1a1c24', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, maxHeight: 300, overflowY: 'auto', zIndex: 30 }}>
                {options.map((o) => (
                  <div key={`${o.schema}-${o.code}`}
                    onClick={() => { setPicked(o); setOpen(false) }}
                    style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{o.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      {o.schema} · {o.code} · {o.category} · {fmt(o.stock, o.unit)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inp} title="From" />
          <span style={{ color: 'rgba(232,234,242,0.4)', fontSize: 12 }}>→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inp} title="To (blank = today)" />
        </div>
      </div>

      {!picked && (
        <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)', fontSize: 13 }}>
          Choose a product to see its statement.
        </div>
      )}
      {loading && <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Building…</div>}

      {data && !loading && (
        <div className="card" style={{ padding: '20px 24px' }}>
          <GlowingEffect spread={30} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{data.product.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
              {data.product.schema} · {data.product.code}
              {data.period.from ? ` · from ${data.period.from}` : ' · all time'}
              {data.period.to ? ` to ${data.period.to}` : ''}
            </div>
          </div>

          {/* The caveat that matters, and it is not about the number below.
              Fourteen MUSE components have never had a receipt of any kind, so
              the zero they start from is an assumption nobody made on purpose —
              there are bottles on the shelf the system was never told about. */}
          {data.ever_received === false && (
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 13px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, marginBottom: 16 }}>
              <AlertTriangle size={15} color="#fbbf24" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 11.5, color: 'rgba(232,234,242,0.85)', lineHeight: 1.5 }}>
                This product has never been received into stock — no delivery has ever been
                entered. The figures below are relative to that, not absolute.
              </div>
            </div>
          )}

          <Row label="Opening balance" value={fmt(data.opening, unit)} strong />

          <div style={{ margin: '10px 0', paddingLeft: 14, borderLeft: '2px solid rgba(255,255,255,0.08)' }}>
            {data.movements.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>No movement in this period.</div>
            )}
            {data.movements.map((m) => (
              <div key={m.type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', gap: 12 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                  {m.business}
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>
                    {m.movements} movement{m.movements === 1 ? '' : 's'}
                  </span>
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'monospace', whiteSpace: 'nowrap',
                  color: m.effect < 0 ? '#f87171' : m.effect > 0 ? '#4ade80' : 'var(--text-muted)' }}>
                  {m.effect > 0 ? '+' : m.effect < 0 ? '−' : ''}{fmt(Math.abs(m.effect), unit)}
                </span>
              </div>
            ))}
          </div>

          <Row label="Received" value={`+ ${fmt(data.received, unit)}`} color="#4ade80" />
          <Row label="Used" value={`− ${fmt(data.used, unit)}`} color="#f87171" />
          <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '10px 0' }} />
          <Row label="Closing balance" value={fmt(data.closing, unit)} strong />
          <Row label="Stock on the shelf" value={fmt(data.product.stock_now, unit)} />

          {/* The audit property. A statement that does not balance is not a
              report, it is a rumour — so it says which it is. */}
          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 16, padding: '10px 13px', borderRadius: 8,
            background: data.reconciles ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
            border: `1px solid ${data.reconciles ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.35)'}` }}>
            {data.reconciles
              ? <CheckCircle2 size={15} color="#4ade80" style={{ flexShrink: 0, marginTop: 1 }} />
              : <AlertTriangle size={15} color="#f87171" style={{ flexShrink: 0, marginTop: 1 }} />}
            <div style={{ fontSize: 11.5, color: 'rgba(232,234,242,0.85)', lineHeight: 1.5 }}>
              {data.reconciles
                ? 'The statement balances: opening plus movements equals the stock on the shelf.'
                : `Out by ${fmt(Math.abs(data.closing - data.product.stock_now), unit)}. Stock changed without a movement being recorded — most often a bulk correction made directly, or history that predates the platform.`}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, value, strong, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', gap: 12 }}>
      <span style={{ fontSize: strong ? 13.5 : 12.5, fontWeight: strong ? 700 : 500, color: strong ? 'var(--text-primary)' : 'rgba(232,234,242,0.7)' }}>{label}</span>
      <span style={{ fontSize: strong ? 14 : 12.5, fontWeight: 700, fontFamily: 'monospace', color: color || 'var(--text-primary)', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}
