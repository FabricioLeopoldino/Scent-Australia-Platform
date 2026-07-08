import { useEffect, useState } from 'react'
import { useToast } from '../SMModule.jsx'
import { ArrowDownToLine, Check, X } from 'lucide-react'

// Incoming fragrance transfers from Scent Stock Manager — SM side
// (PRD FR-XFER-3/4/6): confirm receipt (full or partial w/ justification).
export default function TransfersIn() {
  const { addToast } = useToast()
  const [transfers, setTransfers] = useState([])
  const [receiving, setReceiving] = useState(null) // transfer being confirmed
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')

  async function load() {
    const r = await fetch('/api/platform/transfers')
    if (r.ok) setTransfers(await r.json())
  }
  useEffect(() => { load() }, [])

  const pending = transfers.filter((t) => t.status === 'in_transit')
  const history = transfers.filter((t) => t.status !== 'in_transit')
  const mlLabel = (v) => `${(parseFloat(v) / 1000).toFixed(parseFloat(v) % 1000 === 0 ? 0 : 2)} L`
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' }) : '—')

  function openReceive(t) {
    setReceiving(t)
    setQty(String(t.quantity_ml))
    setReason('')
  }

  async function confirmReceive(e) {
    e.preventDefault()
    const res = await fetch(`/api/platform/transfers/${receiving.id}/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        received_qty_ml: parseFloat(qty),
        discrepancy_reason: reason || undefined,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      addToast(`Received ${mlLabel(qty)} of ${receiving.sm_name}`, 'success')
      setReceiving(null)
      load()
    } else {
      addToast(data.error || 'Receive failed', 'error')
    }
  }

  const short = receiving && parseFloat(qty) < parseFloat(receiving.quantity_ml) - 0.001

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4, color: 'var(--text-primary)' }}>Incoming Transfers</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 22 }}>
        Fragrance stock sent from Scent Stock Manager — confirm what physically arrived.
      </p>

      {/* Pending */}
      <div style={{ display: 'grid', gap: 12, marginBottom: 28 }}>
        {pending.length === 0 && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No transfers in transit.
          </div>
        )}
        {pending.map((t) => (
          <div key={t.id} className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                {t.sm_name} <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({t.sm_code})</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                {mlLabel(t.quantity_ml)} · sent by {t.sent_by_name || '—'} · {fmtDate(t.sent_at)}
                {t.notes ? ` · ${t.notes}` : ''}
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => openReceive(t)}>
              <ArrowDownToLine size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              Receive
            </button>
          </div>
        ))}
      </div>

      {/* History */}
      <h2 style={{ fontSize: 15, marginBottom: 10, color: 'var(--text-primary)' }}>History</h2>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr><th>Sent</th><th>Fragrance</th><th>Sent qty</th><th>Received</th><th>Status</th></tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 18, color: 'var(--text-muted)' }}>No history yet</td></tr>
            )}
            {history.map((t) => (
              <tr key={t.id}>
                <td>{fmtDate(t.sent_at)}</td>
                <td>{t.sm_name}</td>
                <td>{mlLabel(t.quantity_ml)}</td>
                <td>
                  {t.status === 'received' ? `${mlLabel(t.received_qty_ml)} · ${t.received_by_name || ''}` : '—'}
                  {t.discrepancy_reason && (
                    <div style={{ fontSize: 11, color: '#fbbf24' }}>{t.discrepancy_reason}</div>
                  )}
                </td>
                <td style={{ fontWeight: 700, fontSize: 12, color: t.status === 'received' ? '#4ade80' : '#f87171' }}>
                  {t.status === 'received' ? <><Check size={12} style={{ verticalAlign: -2 }} /> Received</> : <><X size={12} style={{ verticalAlign: -2 }} /> Cancelled</>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Receive modal */}
      {receiving && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 420 }}>
            <h3 style={{ fontSize: 16, marginBottom: 6, color: 'var(--text-primary)' }}>Receive transfer</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              {receiving.sm_name} — {mlLabel(receiving.quantity_ml)} sent from Scent Stock Manager
            </p>
            <form onSubmit={confirmReceive}>
              <div className="form-group">
                <label>Quantity received (mL)</label>
                <input
                  className="input" type="number" min="0" step="0.001"
                  max={parseFloat(receiving.quantity_ml)}
                  value={qty} onChange={(e) => setQty(e.target.value)} required autoFocus
                />
              </div>
              {short && (
                <div className="form-group">
                  <label style={{ color: '#fbbf24' }}>Justification (short receipt)</label>
                  <input
                    className="input" value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. bottle leaked in transit" required
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button type="button" className="btn" onClick={() => setReceiving(null)}>Cancel</button>
                <button className="btn btn-primary">Confirm receipt</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
