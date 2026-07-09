import { useState, useEffect } from 'react'
import { useLocation } from 'wouter'
import {
  AlertTriangle, Clock, Package, Layers, Beaker, RotateCcw, ChevronRight,
  ShoppingCart, TrendingDown, Users, Truck, ArrowDownToLine, Factory,
  FlaskConical, Star, AlertOctagon, RefreshCw
} from 'lucide-react'
import { useAuth } from '../SMModule.jsx'
import axios from 'axios'
import GlowingEffect from '../components/GlowingEffect.jsx'
import { InfoIcon } from '../components/Tooltip.jsx'

import { fmtDate as fmt } from '../utils/date.js'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

function isOverdue(d) { return d && new Date(d) < new Date() }

const STATUS_COLORS = {
  draft:            { text: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.08)' },
  confirmed:        { text: '#60a5fa', bg: 'rgba(37,99,235,0.18)' },
  queued:           { text: '#fbbf24', bg: 'rgba(245,158,11,0.18)' },
  in_production:    { text: '#f472b6', bg: 'rgba(244,114,182,0.18)' },
  waiting_external: { text: '#a78bfa', bg: 'rgba(167,139,250,0.18)' },
  completed:        { text: '#4ade80', bg: 'rgba(34,197,94,0.18)' },
  ready_to_ship:    { text: '#34d399', bg: 'rgba(16,185,129,0.18)' },
}

// Quiet status — a small dot + label (refined), no filled pill.
function StatusBadge({ status }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.draft
  const labels = { draft:'Draft', confirmed:'Confirmed', queued:'Queued', in_production:'In Production', waiting_external:'Waiting External', completed:'Completed', ready_to_ship:'Ready to Ship' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 500, color: s.text }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.text, flexShrink: 0 }} />
      {labels[status] || status}
    </span>
  )
}

// Calm card — surface + hairline (no colored left-border, no glow). Editorial.
function Card({ children, style = {} }) {
  return (
    <div className="card" style={{ padding: 22, ...style }}>
      {children}
    </div>
  )
}

// Editorial section header — Playfair title, muted count, quiet action link.
function SectionTitle({ title, count, action, navigate }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
      <h3 className="serif" style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'baseline', gap: 9 }}>
        {title}
        {count != null && count > 0 && (
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{count}</span>
        )}
      </h3>
      {action && (
        <button onClick={() => navigate(action.path)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          {action.label} <ChevronRight size={13} />
        </button>
      )}
    </div>
  )
}

function Empty({ text }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 16px', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>{text}</div>
  )
}

function ptLabel(pt) { return (pt || '').replace(/_/g, ' ') }

function lineStep(o) {
  const total = parseInt(o.line_count) || 0
  const done = parseInt(o.lines_done) || 0
  const sentFilling = parseInt(o.lines_sent_filling) || 0
  const fillingDone = parseInt(o.lines_filling_done) || 0
  const labelingDone = parseInt(o.lines_labeling_done) || 0
  if (!total) return null
  if (done === total) return `All done (${done}/${total})`
  if (labelingDone > 0) return `Packing (${labelingDone}/${total})`
  if (fillingDone > 0) return `Labeling (${fillingDone}/${total})`
  if (sentFilling > 0) return `Sent for filling (${sentFilling}/${total})`
  return `${o.has_candle ? 'Filling — Candle' : 'Filling'} (${total})`
}

function calcPct(o) {
  const total = parseInt(o.line_count) || 0
  if (!total) return 0
  const sent = parseInt(o.lines_sent_filling) || 0
  const filling = parseInt(o.lines_filling_done) || 0
  const labeling = parseInt(o.lines_labeling_done) || 0
  const done = parseInt(o.lines_done) || 0
  return Math.round((sent * 15 + filling * 40 + labeling * 80 + done * 100) / total)
}

export default function Dashboard() {
  const [watchlist, setWatchlist]               = useState([])
  const [activeOrders, setActiveOrders]         = useState([])
  const [draftOrders, setDraftOrders]           = useState([])
  const [stats, setStats]                       = useState(null)
  const [externalProcessing, setExternal]       = useState([])
  const [incomingSummary, setIncoming]          = useState([])
  const [warehouseQueue, setWarehouseQueue]     = useState([])
  const [loading, setLoading]                   = useState(true)
  const [refreshing, setRefreshing]             = useState(false)
  const [queueModal, setQueueModal]             = useState(null)
  const [epMarkSentModal, setEpMarkSentModal]   = useState(null)
  const [epMarkSentQty, setEpMarkSentQty]       = useState('')
  const [epMarkSentSaving, setEpMarkSentSaving] = useState(false)
  const [epReturnModal, setEpReturnModal]       = useState(null)
  const [epReturnQty, setEpReturnQty]           = useState('')
  const [epReturnNotes, setEpReturnNotes]       = useState('')
  const [epReturning, setEpReturning]           = useState(false)
  const [alerts, setAlerts]                     = useState([])
  const [, navigate]                            = useLocation()
  const { user }                                = useAuth()

  useEffect(() => { loadAll() }, [])

  async function loadAll(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    const [w, a, s, ep, inc, wq, dr, al] = await Promise.allSettled([
      axios.get('/api/dashboard/priority-watchlist', api()),
      axios.get('/api/dashboard/active-orders', api()),
      axios.get('/api/dashboard/stats', api()),
      axios.get('/api/dashboard/external-processing', api()),
      axios.get('/api/dashboard/incoming-summary', api()),
      axios.get('/api/dashboard/warehouse-queue', api()),
      axios.get('/api/dashboard/draft-orders', api()),
      axios.get('/api/dashboard/alerts', api()),
    ])
    if (w.status === 'fulfilled') setWatchlist(w.value.data)
    if (a.status === 'fulfilled') setActiveOrders(a.value.data)
    if (s.status === 'fulfilled') setStats(s.value.data)
    if (ep.status === 'fulfilled') setExternal(ep.value.data)
    if (inc.status === 'fulfilled') setIncoming(inc.value.data)
    if (wq.status === 'fulfilled') setWarehouseQueue(wq.value.data)
    else console.error('[dashboard] warehouse-queue:', wq.reason?.response?.data?.error || wq.reason?.message)
    if (dr.status === 'fulfilled') setDraftOrders(dr.value.data)
    if (al.status === 'fulfilled') setAlerts(al.value.data)
    setLoading(false)
    setRefreshing(false)
  }

  async function acknowledgeAlert(id) {
    try {
      await axios.post(`/api/dashboard/alerts/${id}/acknowledge`, {}, api())
      setAlerts(prev => prev.filter(a => a.id !== id))
    } catch {}
  }

  async function acknowledgeAllAlerts() {
    try {
      await axios.post('/api/dashboard/alerts/acknowledge-all', {}, api())
      setAlerts([])
    } catch {}
  }

  if (loading) {
    return (
      <div style={{ padding: 28 }}>
        <div style={{ color: 'rgba(232,234,242,0.4)', fontSize: 14, paddingTop: 40, textAlign: 'center' }}>Loading dashboard...</div>
      </div>
    )
  }

  return (
    <>
    <div style={{ padding: 28, maxWidth: 1800 }}>

      {/* ── Header (editorial) ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="ed-kicker">
            <span className="num">01</span>
            <span className="eyebrow">
              {new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </span>
          </div>
          <h1 className="ed-title">Dashboard</h1>
          <p className="ed-sub">What needs your hand today.</p>
        </div>
        <button onClick={() => loadAll(true)} disabled={refreshing} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 14px', color: 'rgba(232,234,242,0.6)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} /> Refresh
        </button>
      </div>
      <div className="ed-rule" style={{ margin: '22px 0 28px' }} />

      {/* ── Alerts banner (reservation displacements, etc) ── */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 24, background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} color="#f87171" />
              <span style={{ fontSize: 14, fontWeight: 800, color: '#f87171' }}>{alerts.length} Alert{alerts.length !== 1 ? 's' : ''}</span>
              <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>· Unacknowledged events that need your attention</span>
            </div>
            <button onClick={acknowledgeAllAlerts} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 12px', color: 'rgba(232,234,242,0.7)', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
              Acknowledge all
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {alerts.slice(0, 5).map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                <span style={{ background: a.severity === 'critical' ? 'rgba(220,38,38,0.2)' : 'rgba(251,191,36,0.15)', color: a.severity === 'critical' ? '#f87171' : '#fbbf24', padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 800, textTransform: 'uppercase' }}>
                  {a.alert_type.replace(/_/g, ' ')}
                </span>
                <div style={{ flex: 1, fontSize: 12, color: 'rgba(232,234,242,0.75)' }}>
                  {a.message}
                  {a.related_order_number && (
                    <span style={{ marginLeft: 6, fontFamily: 'monospace', color: '#a78bfa' }}>· {a.related_order_number}</span>
                  )}
                </div>
                <button onClick={() => acknowledgeAlert(a.id)} title="Acknowledge" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '3px 10px', color: 'rgba(232,234,242,0.6)', fontSize: 10, cursor: 'pointer', fontWeight: 600 }}>
                  Ack
                </button>
              </div>
            ))}
            {alerts.length > 5 && (
              <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', textAlign: 'center', padding: '4px 0' }}>
                + {alerts.length - 5} more alerts
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Stats ── */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20, marginBottom: 28 }}>
          {[
            { label: 'Total Products',  value: stats.total_products, sub: `${stats.low_stock} need attention`, color: '#3b82f6', icon: <Factory size={18} color="#3b82f6" />, path: '/stock', tip: 'Total products registered in the system (all categories).' },
            { label: 'Active Orders',   value: stats.active_orders,  sub: 'In production or queued',           color: '#a78bfa', icon: <Clock size={18} color="#a78bfa" />,   path: '/production-orders', tip: 'Production orders with status draft, confirmed, queued, in_production or waiting_external.' },
            { label: 'Low Stock Items', value: stats.low_stock,      sub: stats.low_stock > 0 ? 'Below minimum level' : 'All healthy', color: stats.low_stock > 0 ? '#f59e0b' : '#22c55e', icon: <TrendingDown size={18} color={stats.low_stock > 0 ? '#f59e0b' : '#22c55e'} />, path: '/stock', tip: 'Products whose current stock is below their defined minimum level.' },
            { label: 'Pending POs',     value: stats.pending_pos,    sub: stats.pending_pos > 0 ? 'Awaiting receipt' : 'No open orders', color: stats.pending_pos > 0 ? '#fb923c' : '#22c55e', icon: <ShoppingCart size={18} color={stats.pending_pos > 0 ? '#fb923c' : '#22c55e'} />, path: '/incoming-orders', tip: 'Purchase orders with status pending or partial — awaiting goods receipt.' },
            { label: 'MUSE Active', value: activeOrders.filter(o => !o.client_id).length, sub: 'Own brand in production', color: '#fbbf24', icon: <Star size={18} color="#fbbf24" />, path: '/production-orders', tip: 'MUSE (own brand) production orders in active state.' },
          ].map(card => (
            <div key={card.label} onClick={() => navigate(card.path)}
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', cursor: 'pointer', position: 'relative', transition: 'border-color .2s, transform .2s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-h)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14 }}>
                <span className="eyebrow">{card.label}</span>
                {card.tip && <InfoIcon text={card.tip} maxWidth={240} />}
              </div>
              <div className="kpi-num">{card.value}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: card.color, flexShrink: 0 }} />
                {card.sub}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Row 2: Low Stock + Active Orders + Draft Orders ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 24 }}>

        {/* Low Stock */}
        <Card color="#f59e0b">
          <SectionTitle icon={<AlertTriangle size={16} color="#fbbf24" />} title="Low Stock Alerts" count={watchlist.length} color="#fbbf24" action={{ label: 'View stock', path: '/stock' }} navigate={navigate} />
          {watchlist.length === 0 ? (
            <Empty text="All stock levels healthy" />
          ) : (
            <div className="ed-list">
              {watchlist.map(item => (
                <div key={item.id} className="ed-li">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{item.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.product_code} · {item.category.replace('_',' ')}</div>
                    {item.pending_po_qty > 0 && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>+{Number(item.pending_po_qty).toLocaleString()} on order</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: item.current_stock <= 0 ? '#f87171' : '#fbbf24' }}>
                      {Number(item.current_stock).toLocaleString()} {item.unit}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>min: {Number(item.min_stock_level).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Active Production Orders */}
        <Card color="#60a5fa">
          <SectionTitle icon={<Clock size={16} color="#60a5fa" />} title="Active Production Orders" count={activeOrders.length} color="#60a5fa" action={{ label: 'View all', path: '/production-orders' }} navigate={navigate} />
          {activeOrders.length === 0 ? (
            <Empty text="No active production orders" />
          ) : (
            <div className="ed-list">
              {activeOrders.map(order => (
                <div key={order.id} onClick={() => navigate('/production-orders')}
                  className="ed-li" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{order.order_number}</span>
                      <StatusBadge status={order.status} />
                      {order.order_type === 'LARGE_CLIENT' && <span style={{ fontSize: 9, color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Major</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                      {!order.client_id && <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em' }}>MUSE</span>}
                      {order.client_name || 'MUSE Internal'}
                    </div>
                  </div>
                  {order.due_date && (
                    <div style={{ fontSize: 12, color: isOverdue(order.due_date) ? '#f87171' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      Due {fmt(order.due_date)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Draft Orders */}
        <Card color="#94a3b8">
          <SectionTitle icon={<Clock size={16} color="#94a3b8" />} title="Draft Orders" count={draftOrders.length} color="#94a3b8" action={{ label: 'View all', path: '/production-orders' }} navigate={navigate} />
          {draftOrders.length === 0 ? (
            <Empty text="No draft orders" />
          ) : (
            <div className="ed-list">
              {draftOrders.map(order => (
                <div key={order.id} onClick={() => navigate('/production-orders')}
                  className="ed-li" style={{ cursor: 'pointer' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{order.order_number}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {!order.client_id && <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', marginRight: 5 }}>MUSE</span>}
                      {order.client_name || 'MUSE Internal'} · {order.line_count} line{order.line_count !== '1' ? 's' : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
                    {order.due_date ? <span style={{ color: isOverdue(order.due_date) ? '#f87171' : 'var(--text-muted)' }}>Due {fmt(order.due_date)}</span> : fmt(order.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Warehouse Queue ── */}
      <Card color="#f472b6" style={{ marginBottom: 24 }}>
        <SectionTitle icon={<Layers size={16} color="#f472b6" />} title="Warehouse Queue" count={warehouseQueue.length} color="#f472b6" action={{ label: 'View all', path: '/manufacturing-queue' }} navigate={navigate} />
        {warehouseQueue.length === 0 ? (
          <Empty text="No orders in the warehouse queue" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {warehouseQueue.map(o => {
              const sc = STATUS_COLORS[o.status] || STATUS_COLORS.draft
              const step = lineStep(o)
              const total = parseInt(o.line_count) || 0
              const pct = calcPct(o)
              const overdue = isOverdue(o.due_date)
              const isWaiting = o.status === 'waiting_external'
              return (
                <div key={o.id} onClick={() => setQueueModal(o)}
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '13px 15px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, transition: 'border-color .15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-h)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                >
                  {/* Header row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{o.order_number}</span>
                    <StatusBadge status={o.status} />
                  </div>

                  {/* Client / MUSE */}
                  {o.client_name
                    ? <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{o.client_name}</div>
                    : <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', alignSelf: 'flex-start' }}>MUSE</span>
                  }

                  {/* Products */}
                  {o.product_types && (
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.35 }}>
                      {o.product_types.split(', ').map(pt => (
                        <div key={pt} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ptLabel(pt)}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Waiting External info */}
                  {isWaiting && (
                    <div style={{ padding: '7px 9px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                      {o.external_type && (
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {o.external_type}
                        </div>
                      )}
                      {o.external_supplier && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{o.external_supplier}</div>
                      )}
                      {o.external_expected_at && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: isOverdue(o.external_expected_at) ? '#f87171' : '#fbbf24', marginTop: 2 }}>
                          ETA: {fmt(o.external_expected_at)}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Progress bar */}
                  {total > 0 && !isWaiting && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>
                        <span>{step || `${total} lines`}</span>
                        <span>{pct}%</span>
                      </div>
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: sc.text, borderRadius: 2, transition: 'width 0.3s' }} />
                      </div>
                    </div>
                  )}

                  {/* Due date */}
                  {o.due_date && (
                    <div style={{ fontSize: 10, color: overdue ? '#f87171' : 'var(--text-muted)', fontWeight: overdue ? 700 : 400 }}>
                      {overdue ? 'Overdue · ' : 'Due '}
                      {fmt(o.due_date)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ── Incoming PO Orders ── */}
      <Card color="#34d399" style={{ marginBottom: 24 }}>
        <SectionTitle icon={<ArrowDownToLine size={16} color="#34d399" />} title="Incoming Orders" count={incomingSummary.length} color="#34d399" action={{ label: 'View all', path: '/incoming-orders' }} navigate={navigate} />
        {incomingSummary.length === 0 ? (
          <Empty text="No open purchase orders" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Product', 'PO #', 'Supplier', 'Qty Ordered', 'Received', 'Progress', 'ETA'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 9.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.16em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {incomingSummary.map(po => {
                  const overdue = isOverdue(po.estimated_delivery_date)
                  const pct = po.quantity > 0 ? Math.min(100, (po.quantity_received / po.quantity) * 100) : 0
                  const remaining = Number(po.quantity) - Number(po.quantity_received)
                  return (
                    <tr key={po.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '12px 12px' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{po.product_name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{po.product_code}</div>
                      </td>
                      <td style={{ padding: '12px 12px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{po.order_number || '—'}</td>
                      <td style={{ padding: '12px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>{po.supplier || '—'}</td>
                      <td style={{ padding: '12px 12px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{Number(po.quantity).toLocaleString()} {po.unit}</td>
                      <td style={{ padding: '12px 12px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                        {Number(po.quantity_received).toLocaleString()} {po.unit}
                        {remaining > 0 && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{Number(remaining).toLocaleString()} left</div>}
                      </td>
                      <td style={{ padding: '12px 12px', width: 90 }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{pct.toFixed(0)}%</div>
                        <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 2 }} />
                        </div>
                      </td>
                      <td style={{ padding: '12px 12px', fontSize: 12, fontWeight: overdue ? 700 : 400, color: overdue ? '#f87171' : 'var(--text-secondary)' }}>
                        {fmt(po.estimated_delivery_date)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── External Processing ── */}
      <Card color="#fb923c" style={{ marginBottom: 24 }}>
        <SectionTitle icon={<Truck size={16} color="#fb923c" />} title="External Processing" count={externalProcessing.length} color="#fb923c" action={{ label: 'View all', path: '/external-processing' }} navigate={navigate} />
        {externalProcessing.length === 0 ? (
          <Empty text="No items currently at external suppliers" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {externalProcessing.map(item => {
              const overdue = isOverdue(item.expected_return)
              const daysAway = item.expected_return ? Math.ceil((new Date(item.expected_return) - new Date()) / 86400000) : null
              return (
                <div key={item.id} style={{ background: 'var(--surface-2)', border: `1px solid ${overdue ? 'rgba(192,57,43,0.4)' : 'var(--border)'}`, borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{item.product_name}</div>
                      {item.order_number && <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{item.order_number}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {item.status === 'requested' && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Requested</span>}
                      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{item.processing_type}</span>
                    </div>
                  </div>
                  {item.status === 'partial' && (() => {
                    const isLabels = item.processing_type === 'labels'
                    const refQty = isLabels ? parseFloat(item.qty_requested || 0) : parseFloat(item.qty_sent || 0)
                    const outstanding = Math.max(0, refQty - parseFloat(item.qty_returned || 0))
                    return (
                      <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 700 }}>Partial Return</span>
                        <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.6)' }}>
                          {Number(item.qty_returned).toLocaleString()} received · <strong style={{ color: '#fbbf24' }}>{Number(outstanding).toLocaleString()} outstanding</strong>
                        </span>
                      </div>
                    )
                  })()}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    {[
                      { label: 'Supplier', val: item.supplier || '—' },
                      (() => {
                        const isLabels = item.processing_type === 'labels'
                        const refQty = isLabels ? item.qty_requested : item.qty_sent
                        const refLabel = isLabels ? 'Requested' : 'Sent'
                        if (item.status === 'requested') return { label: 'Qty Requested', val: item.qty_requested ? Number(item.qty_requested).toLocaleString() : '—' }
                        if (item.status === 'partial') return { label: `Qty ${refLabel} / Received`, val: `${Number(refQty || 0).toLocaleString()} / ${Number(item.qty_returned || 0).toLocaleString()}` }
                        return { label: `Qty ${refLabel}`, val: Number(refQty || 0).toLocaleString() }
                      })(),
                      { label: item.status === 'requested' ? 'Created' : 'Sent', val: fmt(item.status === 'requested' ? item.created_at : item.sent_date) },
                      { label: 'Expected Return', val: item.expected_return ? (
                        <span style={{ color: overdue ? '#f87171' : daysAway !== null && daysAway <= 3 ? '#fbbf24' : 'rgba(232,234,242,0.7)' }}>
                          {fmt(item.expected_return)} <span style={{ fontSize: 10 }}>{overdue ? `(${Math.abs(daysAway)}d overdue)` : daysAway === 0 ? '(today)' : daysAway != null ? `(${daysAway}d)` : ''}</span>
                        </span>
                      ) : '—' },
                    ].map(r => (
                      <div key={r.label}>
                        <div style={{ fontSize: 9, color: 'rgba(232,234,242,0.35)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{r.label}</div>
                        <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.7)' }}>{r.val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {item.status === 'requested' && item.processing_type !== 'labels' ? (
                      <button onClick={() => { setEpMarkSentModal(item); setEpMarkSentQty('') }}
                        style={{ flex: 1, background: 'var(--accent-soft)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '7px 0', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Mark Sent
                      </button>
                    ) : (
                      <button onClick={() => { setEpReturnModal(item); setEpReturnQty(''); setEpReturnNotes('') }}
                        style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-h)', borderRadius: 6, padding: '7px 0', color: item.status === 'partial' ? '#fbbf24' : '#4ade80', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        {item.status === 'partial' ? 'Mark Remaining Return' : 'Mark Returned'}
                      </button>
                    )}
                    {(item.status === 'partial' || item.status === 'requested') && (
                      <button onClick={async () => {
                        const isLabels = item.processing_type === 'labels'
                        const refQty = isLabels ? Number(item.qty_requested || 0) : Number(item.qty_sent || 0)
                        const outstanding = Math.max(0, refQty - Number(item.qty_returned || 0))
                        if (!confirm(`Close this EP record? ${outstanding} items still outstanding will be written off.`)) return
                        try {
                          await axios.put(`/api/external-processing/${item.id}/close`, {}, api())
                          loadAll(true)
                        } catch {}
                      }} title="Force close — no more returns expected"
                        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Close
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ── Major Client Reserved Stock ── */}
      {stats?.large_clients?.length > 0 && (
        <Card color="#a78bfa">
          <SectionTitle icon={<Users size={16} color="#a78bfa" />} title="Major Client Reserved Stock" color="#a78bfa" action={{ label: 'Manage customers', path: '/customers' }} navigate={navigate} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {stats.large_clients.map(c => (
              <div key={c.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</div>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Major</span>
                </div>
                <div style={{ display: 'flex', gap: 20 }}>
                  <div>
                    <div style={{ fontSize: 20, fontFamily: 'Archivo Black, sans-serif', color: '#a78bfa' }}>{c.reserved_count || 0}</div>
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.4 }}>SKU types</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 20, fontFamily: 'Archivo Black, sans-serif', color: '#c4b5fd' }}>{Number(c.total_reserved || 0).toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Total reserved</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

    </div>

    {/* ── Modals ── */}
    {/* ── Warehouse Queue Order Modal ── */}
    {queueModal && (() => {
      const o = queueModal
      const total = parseInt(o.line_count) || 0
      const pct = calcPct(o)
      const step = lineStep(o)
      return (
        <div className="modal-overlay" onClick={() => setQueueModal(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {o.order_number}
                <StatusBadge status={o.status} />
              </h2>
              <button className="modal-close" onClick={() => setQueueModal(null)}>×</button>
            </div>
            <div className="modal-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Client</div>
                <div style={{ fontSize: 13, color: '#e8eaf2', fontWeight: 600 }}>{o.client_name || '—'}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Due Date</div>
                <div style={{ fontSize: 13, color: isOverdue(o.due_date) ? '#f87171' : '#e8eaf2', fontWeight: 600 }}>{fmt(o.due_date)}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Lines</div>
                <div style={{ fontSize: 13, color: '#e8eaf2', fontWeight: 600 }}>{total} line{total !== 1 ? 's' : ''}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Type</div>
                <div style={{ fontSize: 13, color: '#e8eaf2', fontWeight: 600 }}>{o.order_type || 'STANDARD'}</div>
              </div>
            </div>
            {total > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.5)' }}>{step || 'Progress'}</span>
                  <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>{pct}%</span>
                </div>
                <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #4ade80, #22d3ee)', borderRadius: 3, transition: 'width 0.4s ease' }} />
                </div>
              </div>
            )}
            {o.status === 'waiting_external' && (
              <div style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
                <div style={{ fontSize: 11, color: '#a78bfa', fontWeight: 700, marginBottom: 4 }}>Waiting External</div>
                <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.6)' }}>{o.external_type}{o.external_supplier ? ` — ${o.external_supplier}` : ''}{o.external_expected_at ? ` · ETA ${fmt(o.external_expected_at)}` : ''}</div>
              </div>
            )}
            {o.product_types && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Products</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {o.product_types.split(', ').map(pt => (
                    <span key={pt} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 10px', fontSize: 11, color: 'var(--text-secondary)' }}>{ptLabel(pt)}</span>
                  ))}
                </div>
              </div>
            )}
            </div>
            <div className="modal-footer">
              <button onClick={() => { setQueueModal(null); navigate('/manufacturing-queue') }} className="btn btn-primary" style={{ width: '100%' }}>
                Open in Manufacturing Queue
              </button>
            </div>
          </div>
        </div>
      )
    })()}

    {/* ── EP Mark Sent Modal ── */}
    {epMarkSentModal && (
      <div className="modal-overlay" onClick={() => setEpMarkSentModal(null)}>
        <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h2>Mark as Sent</h2>
              <p>{epMarkSentModal.product_name}{epMarkSentModal.qty_requested ? ` — requested: ${Number(epMarkSentModal.qty_requested).toLocaleString()}` : ''}</p>
            </div>
            <button className="modal-close" onClick={() => setEpMarkSentModal(null)}>×</button>
          </div>
          <div className="modal-body">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="label">Qty Sent *</label>
              <input type="number" value={epMarkSentQty} onChange={e => setEpMarkSentQty(e.target.value)} autoFocus
                placeholder={epMarkSentModal.qty_requested ? String(epMarkSentModal.qty_requested) : '0'} className="input" />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setEpMarkSentModal(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={epMarkSentSaving} onClick={async () => {
              const qty = parseFloat(epMarkSentQty || epMarkSentModal.qty_requested)
              if (!qty || qty <= 0) return
              setEpMarkSentSaving(true)
              try {
                await axios.put(`/api/external-processing/${epMarkSentModal.id}/mark-sent`, { qty_sent: qty }, api())
                setEpMarkSentModal(null)
                loadAll(true)
              } catch (err) { alert(err.response?.data?.error || 'Failed') }
              finally { setEpMarkSentSaving(false) }
            }}>
              {epMarkSentSaving ? 'Saving...' : 'Confirm Sent'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── EP Return Modal ── */}
    {epReturnModal && (
      <div className="modal-overlay" onClick={() => setEpReturnModal(null)}>
        <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h2>Mark Return</h2>
              <p>{epReturnModal.product_name} — {epReturnModal.processing_type === 'labels' ? `requested: ${epReturnModal.qty_requested}` : `sent: ${epReturnModal.qty_sent}`}</p>
            </div>
            <button className="modal-close" onClick={() => setEpReturnModal(null)}>×</button>
          </div>
          <div className="modal-body">
            <div className="form-group">
              <label className="label">Qty Returned</label>
              <input type="number" value={epReturnQty} onChange={e => setEpReturnQty(e.target.value)}
                placeholder={`max ${epReturnModal.qty_sent}`} className="input" />
            </div>
            {(() => {
              const qtyRef = parseFloat(epReturnModal.processing_type === 'labels' ? epReturnModal.qty_requested : epReturnModal.qty_sent)
              const isShort = epReturnQty && parseFloat(epReturnQty) > 0 && parseFloat(epReturnQty) < qtyRef
              return (
                <div className="form-group">
                  <label className="label" style={isShort ? { color: '#fbbf24' } : undefined}>
                    {isShort ? 'Reason for short return (required) *' : 'Notes (optional)'}
                  </label>
                  <input type="text" value={epReturnNotes} onChange={e => setEpReturnNotes(e.target.value)}
                    placeholder={isShort ? 'e.g. 15 reprints pending, 5 damaged in transit' : 'e.g. all received in good condition'}
                    className="input"
                    style={isShort ? { background: 'rgba(251,191,36,0.06)', borderColor: 'rgba(251,191,36,0.3)' } : undefined} />
                  {isShort && (
                    <div style={{ fontSize: 10, color: 'rgba(251,191,36,0.75)', marginTop: 5 }}>
                      Returning {Number(epReturnQty).toLocaleString()} of {Number(qtyRef).toLocaleString()} — please explain the {Number(qtyRef - parseFloat(epReturnQty)).toLocaleString()} missing.
                    </div>
                  )}
                </div>
              )
            })()}
            {epReturnModal.client_label_id && (
              <div style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)', borderRadius: 8, padding: '8px 12px', fontSize: 11, color: 'rgba(74,222,128,0.8)' }}>
                Label stock will be automatically updated on return
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setEpReturnModal(null)}>Cancel</button>
            <button className="btn btn-primary"
              disabled={epReturning || !epReturnQty || (parseFloat(epReturnQty) > 0 && parseFloat(epReturnQty) < parseFloat(epReturnModal.processing_type === 'labels' ? epReturnModal.qty_requested : epReturnModal.qty_sent) && !epReturnNotes.trim())}
              onClick={async () => {
                const qty = parseFloat(epReturnQty)
                if (!qty || qty <= 0) return
                const qtyRef = parseFloat(epReturnModal.processing_type === 'labels' ? epReturnModal.qty_requested : epReturnModal.qty_sent)
                const isShort = qty < qtyRef
                if (isShort && !epReturnNotes.trim()) return
                setEpReturning(true)
                try {
                  await axios.put(`/api/external-processing/${epReturnModal.id}/return`, {
                    qty_returned: qty,
                    notes: epReturnNotes || undefined,
                    short_return_reason: isShort ? epReturnNotes : undefined,
                  }, api())
                  setEpReturnModal(null)
                  loadAll(true)
                } catch (err) {
                  alert(err.response?.data?.error || 'Failed to record return')
                } finally { setEpReturning(false) }
              }}>
              {epReturning ? 'Saving...' : 'Confirm Return'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
