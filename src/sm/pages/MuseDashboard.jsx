import { useState, useEffect } from 'react'
import { Star, Package, TrendingUp, TrendingDown, AlertTriangle, FlaskConical, ShoppingBag, ArrowRight } from 'lucide-react'
import axios from 'axios'
import { useLocation } from 'wouter'
import { useToast } from '../SMModule.jsx'
import { splitVolume } from '../utils/volume.js'
import { fmtDate } from '../utils/date.js'
import MuseHeader from '../components/MuseHeader.jsx'
import GlowingEffect from '../components/GlowingEffect.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export default function MuseDashboard() {
  const [masters, setMasters]     = useState([])
  const [variants, setVariants]   = useState([])
  const [orders, setOrders]       = useState([])
  const [fragrances, setFragrances] = useState([])
  const [materials, setMaterials] = useState([])
  const [loading, setLoading]     = useState(true)
  const [, navigate]              = useLocation()
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [m, p, o, f, mat] = await Promise.all([
        axios.get('/api/masters', { ...api(), params: { segment: 'MUSE' } }),
        axios.get('/api/products', { ...api(), params: { category: 'FINISHED_GOOD' } }),
        axios.get('/api/production-orders', api()),
        axios.get('/api/products', { ...api(), params: { category: 'FRAGRANCE' } }),
        axios.get('/api/products', api()),
      ])
      setMasters(m.data)
      setVariants(p.data.filter(v => v.segment === 'MUSE' && v.master_product_id && !v.archived))
      // Components, labels and raw materials — the things that actually run out.
      // They were invisible here until 2026-08-12, so a label at zero showed
      // nowhere while 445 made-to-order variants shouted "out of stock".
      setMaterials((mat.data || []).filter(x =>
        ['COMPONENT', 'LABEL', 'RAW_MATERIAL'].includes(x.category)
        && !x.is_master && !x.archived && (x.segment === 'MUSE' || x.segment === 'SHARED')))
      setOrders(o.data.filter(o => !o.client_id))  // MUSE orders only
      setFragrances(f.data)
    } catch { addToast('Failed to load MUSE dashboard', 'error') }
    finally { setLoading(false) }
  }

  if (loading) return <div style={{ padding: 28, color: 'rgba(232,234,242,0.4)' }}>Loading...</div>

  const activeOrders   = orders.filter(o => ['draft', 'confirmed', 'queued', 'in_production', 'waiting_external'].includes(o.status))
  const recentProduced = orders.filter(o => o.status === 'fulfilled').slice(0, 5)
  // A MUSE variant sitting at zero is NORMAL — the range is made to order, and
  // 445 of 450 are at zero on any given day. Flagging those as "out of stock"
  // filled this panel with 445 false alarms and hid the ten materials that were
  // genuinely negative. An alarm that always fires is one nobody reads.
  //
  // So the rule is the same one the SM dashboard already uses: something is only
  // low when a minimum was DELIBERATELY set and the stock is under it. Negative
  // is always wrong, minimum or not — it means material left that we never knew
  // we had. Availability subtracts what is already reserved, matching the stock
  // table so the two screens cannot disagree.
  const avail = (x) => (parseFloat(x.current_stock) || 0) - (parseFloat(x.reserved_qty) || 0)
  const watched = [...materials, ...variants]
  const negative = watched.filter(x => (parseFloat(x.current_stock) || 0) < 0)
  const lowStock = watched.filter(x => !negative.includes(x)
    && parseFloat(x.min_stock_level || 0) > 0 && avail(x) < parseFloat(x.min_stock_level))
  const madeToOrder = variants.filter(v => parseFloat(v.current_stock) <= 0
    && !(parseFloat(v.min_stock_level || 0) > 0)).length
  const totalStock     = variants.reduce((s, v) => s + parseFloat(v.current_stock || 0), 0)
  const topStock       = [...variants].sort((a, b) => parseFloat(b.current_stock) - parseFloat(a.current_stock)).slice(0, 5)

  // Master lookup for variant display
  const masterById = {}
  masters.forEach(m => { masterById[m.id] = m })

  return (
    <div style={{ padding: 28, maxWidth: 1600 }}>
      <MuseHeader subtitle="Dashboard" />
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 className="ed-title">MUSE Dashboard</h1>
        <p className="ed-sub">Own brand overview · masters, variants, production.</p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 28 }}>
        <StatCard label="MUSE Masters" value={masters.length} color="#fbbf24" icon={<Star size={16} />} onClick={() => navigate('/muse/products')} />
        <StatCard label="Active Variants" value={variants.length} color="#60a5fa" icon={<Package size={16} />} onClick={() => navigate('/muse-stock')} />
        <StatCard label="Total Stock" value={(() => { const s = splitVolume(totalStock, 'units'); return `${s.value}` })()} subValue="units across all variants" color="#4ade80" icon={<TrendingUp size={16} />} />
        <StatCard label="Active Orders" value={activeOrders.length} color="#a78bfa" icon={<ShoppingBag size={16} />} onClick={() => navigate('/production-orders')} />
        <StatCard label="Needs Attention" value={negative.length + lowStock.length}
          subValue={negative.length ? `${negative.length} below zero` : 'materials under minimum'}
          color={negative.length ? '#f87171' : lowStock.length > 0 ? '#fbbf24' : '#4ade80'}
          icon={<AlertTriangle size={16} />} onClick={() => navigate('/muse-stock')} />
      </div>

      {/* Row: Top variants + Low/Out of stock */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18, marginBottom: 24 }}>
        {/* Top variants by stock */}
        <Card title="Top Variants by Stock" color="#60a5fa" icon={<Package size={14} />} action={{ label: 'View all', onClick: () => navigate('/muse-stock') }}>
          {topStock.length === 0 ? (
            <Empty text="No variants yet" hint="Create a MUSE Master with fragrances, then run a production order" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {topStock.map(v => {
                const master = masterById[v.master_product_id]
                const fragName = v.name?.includes('—') ? v.name.split('—').slice(1).join('—').trim() : v.name
                const s = splitVolume(v.current_stock, v.unit)
                const isLow = parseFloat(v.current_stock) < parseFloat(v.min_stock_level || 0)
                const isOut = parseFloat(v.current_stock) <= 0
                return (
                  <div key={v.id} onClick={() => navigate('/muse-stock')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', transition: 'border-color .15s' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-h)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{master?.name || '(unknown master)'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{fragName}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: isOut ? '#f87171' : isLow ? '#fbbf24' : '#4ade80' }}>
                        {s.value} <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>{s.unit}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Low/Out of stock */}
        <Card title="Stock Alerts" color="#fbbf24" icon={<AlertTriangle size={14} />}>
          {negative.length === 0 && lowStock.length === 0 ? (
            <Empty text="Nothing below its minimum"
              hint={madeToOrder ? `${madeToOrder} variants sit at zero, which is normal — they are made to order` : 'No item is under the level set for it'} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...negative, ...lowStock].slice(0, 8).map(x => {
                const isNeg = negative.includes(x)
                const master = masterById[x.master_product_id]
                // A material has no master; a variant reads better as format + scent.
                const title = master ? master.name : x.name
                const sub = master
                  ? (x.name?.includes('—') ? x.name.split('—').slice(1).join('—').trim() : x.name)
                  : `${Number(x.current_stock)} ${x.unit || ''}${Number(x.min_stock_level) > 0 ? ` · min ${Number(x.min_stock_level)}` : ''}`
                return (
                  <div key={x.id} style={{ padding: '9px 12px', background: 'var(--surface-2)', border: `1px solid ${isNeg ? 'rgba(248,113,113,0.35)' : 'var(--border)'}`, borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
                      </div>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, flexShrink: 0, color: isNeg ? '#f87171' : '#fbbf24' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: isNeg ? '#f87171' : '#fbbf24', flexShrink: 0 }} />
                        {isNeg ? 'Below zero' : 'Low'}
                      </span>
                    </div>
                  </div>
                )
              })}
              {(negative.length + lowStock.length) > 8 && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 2 }}>
                  and {negative.length + lowStock.length - 8} more
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Row: Active production + Recent produced */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {/* Active production */}
        <Card title="Active Production" color="#a78bfa" icon={<ShoppingBag size={14} />} action={{ label: 'View all', onClick: () => navigate('/production-orders') }}>
          {activeOrders.length === 0 ? (
            <Empty text="No active MUSE orders" hint="Create a production order to start" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeOrders.slice(0, 6).map(o => (
                <div key={o.id} onClick={() => navigate('/production-orders')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', transition: 'border-color .15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-h)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{o.order_number}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {o.lines?.length || 0} line{o.lines?.length !== 1 ? 's' : ''}
                      {o.due_date && ` · Due ${fmtDate(o.due_date)}`}
                    </div>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: '#a78bfa' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#a78bfa', flexShrink: 0 }} />
                    {o.status.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Recently produced */}
        <Card title="Recently Fulfilled" color="#4ade80" icon={<TrendingUp size={14} />} action={{ label: 'View all', onClick: () => navigate('/production-orders') }}>
          {recentProduced.length === 0 ? (
            <Empty text="No fulfilled orders yet" hint="Completed MUSE orders show here after auto-fulfilled" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recentProduced.map(o => (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{o.order_number}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {o.lines?.length || 0} line{o.lines?.length !== 1 ? 's' : ''} · Fulfilled {fmtDate(o.updated_at)}
                    </div>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: '#4ade80' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', flexShrink: 0 }} />
                    Done
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Quick actions */}
      <div style={{ marginTop: 28, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <QuickAction label="Create New Master" icon={<Star size={14} />} color="#fbbf24" onClick={() => navigate('/muse/products')} />
        <QuickAction label="View Fragrances" icon={<FlaskConical size={14} />} color="#a78bfa" onClick={() => navigate('/fragrances')} />
        <QuickAction label="New Production Order" icon={<ShoppingBag size={14} />} color="#60a5fa" onClick={() => navigate('/production-orders')} />
      </div>
    </div>
  )
}

// ─── Components ───
function StatCard({ label, value, subValue, color, icon, onClick }) {
  return (
    <div onClick={onClick} className="card" style={{ padding: '18px 20px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ marginBottom: 12 }}>
        <span className="eyebrow">{label}</span>
      </div>
      <div className="kpi-num" style={{ fontSize: 34 }}>{value}</div>
      {subValue && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{subValue}</div>}
    </div>
  )
}

function Card({ title, color, icon, action, children }) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <GlowingEffect spread={30} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 className="serif" style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h3>
        {action && (
          <button onClick={action.onClick} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            {action.label} <ArrowRight size={12} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Empty({ text, hint }) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{text}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  )
}

function QuickAction({ label, icon, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '9px 16px', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600,
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-h)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      {icon} {label}
    </button>
  )
}
