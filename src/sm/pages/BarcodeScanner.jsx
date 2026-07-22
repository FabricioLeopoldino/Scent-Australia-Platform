import { useState, useEffect, useRef } from 'react'
import { ScanBarcode, Package, RotateCcw, MapPin, Truck, ClipboardCheck } from 'lucide-react'
import axios from 'axios'
import { useToast } from '../SMModule.jsx'
import Tooltip from '../components/Tooltip.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

const CAT_COLORS = { FRAGRANCE:'#a78bfa', RAW_MATERIAL:'#fbbf24', COMPONENT:'#60a5fa', FINISHED_GOOD:'#4ade80', READY_FORMULA:'#fb923c' }

const WORKFLOWS = [
  { key: 'general',    label: 'General',      icon: ScanBarcode,    color: '#60a5fa',  desc: 'Quick add / remove / adjust stock' },
  { key: 'receiving',  label: 'Receiving',     icon: Truck,          color: '#34d399',  desc: 'Receive against a purchase order' },
  { key: 'picking',    label: 'Picking',       icon: ClipboardCheck, color: '#f472b6',  desc: 'View production orders needing this product' },
  { key: 'cycle',      label: 'Cycle Count',   icon: RotateCcw,      color: '#fbbf24',  desc: 'Verify and correct stock levels' },
  { key: 'transfer',   label: 'Transfer',      icon: MapPin,         color: '#fb923c',  desc: 'Move product to a new bin location' },
]

export default function BarcodeScanner() {
  const [workflow, setWorkflow]     = useState('general')
  const [barcode, setBarcode]       = useState('')
  const [found, setFound]           = useState(null)
  const [notFound, setNotFound]     = useState(false)
  const [scanning, setScanning]     = useState(false)

  // General workflow
  const [action, setAction]         = useState('add')
  const [quantity, setQuantity]     = useState('')
  const [newStock, setNewStock]     = useState('')
  const [notes, setNotes]           = useState('')

  // Receiving workflow
  const [selectedPO, setSelectedPO] = useState(null)
  const [receiveQty, setReceiveQty] = useState('')
  const [receiveNotes, setReceiveNotes] = useState('')
  const [tolWarn, setTolWarn] = useState(null)
  const [discrepancyReason, setDiscrepancyReason] = useState('')

  // Transfer workflow
  const [newLocation, setNewLocation] = useState('')

  const [saving, setSaving]         = useState(false)
  const [lastActions, setLastActions] = useState([])
  const barcodeRef = useRef(null)
  const { addToast } = useToast()

  useEffect(() => { barcodeRef.current?.focus() }, [])

  // Reset state on workflow change
  useEffect(() => {
    clearScan()
  }, [workflow])

  function clearScan() {
    setFound(null); setNotFound(false); setBarcode('')
    setQuantity(''); setNewStock(''); setNotes('')
    setSelectedPO(null); setReceiveQty(''); setReceiveNotes('')
    setNewLocation('')
    setTolWarn(null); setDiscrepancyReason('')
    setTimeout(() => barcodeRef.current?.focus(), 50)
  }

  async function handleScan(e) {
    e?.preventDefault()
    if (!barcode.trim()) return
    setNotFound(false); setFound(null); setScanning(true)
    try {
      const res = await axios.get(`/api/barcode/${encodeURIComponent(barcode.trim())}`, api())
      setFound(res.data)
      setNewStock(res.data.current_stock)
      setNewLocation(res.data.bin_location || '')
    } catch (e) {
      if (e.response?.status === 404) setNotFound(true)
      else addToast('Scan error', 'error')
    } finally { setScanning(false) }
  }

  // ─── General ───────────────────────────────
  async function handleGeneral() {
    if (action === 'adjust' && newStock === '') { addToast('Enter new stock value', 'error'); return }
    if (action !== 'adjust' && (!quantity || parseFloat(quantity) <= 0)) { addToast('Enter a valid quantity', 'error'); return }
    setSaving(true)
    try {
      let endpoint, payload
      if (action === 'adjust') {
        endpoint = '/api/stock/adjust'
        payload  = { product_id: found.id, new_stock: parseFloat(newStock), notes: notes || null }
      } else {
        endpoint = `/api/stock/${action}`
        payload  = { product_id: found.id, quantity: parseFloat(quantity), notes: notes || null }
      }
      const res = await axios.post(endpoint, payload, api())
      const delta = action === 'add' ? +parseFloat(quantity) : action === 'remove' ? -parseFloat(quantity) : parseFloat(newStock) - parseFloat(found.current_stock)
      addToast(`${found.name} — stock ${action}`)
      pushHistory({ product: found.name, code: found.product_code, action, delta, newBalance: res.data.current_stock, unit: found.unit })
      clearScan()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  // ─── Receiving ─────────────────────────────
  // Same tolerance rule as Incoming Orders: first attempt WITHOUT force_accept;
  // if the server flags tolerance_exceeded, require a discrepancy reason before
  // accepting. (This page used to always send force_accept:true, silently
  // skipping the check that Incoming Orders enforces for the same operation.)
  async function handleReceive(force = false) {
    if (!selectedPO) { addToast('Select a purchase order', 'error'); return }
    if (!receiveQty || parseFloat(receiveQty) <= 0) { addToast('Enter received quantity', 'error'); return }
    if (force && !discrepancyReason.trim()) { addToast('A discrepancy reason is required', 'error'); return }
    setSaving(true)
    try {
      const res = await axios.post(`/api/purchase-orders/${selectedPO.id}/receive`, {
        quantity_received: parseFloat(receiveQty),
        notes: receiveNotes || null,
        force_accept: force,
        discrepancy_reason: force ? discrepancyReason.trim() : undefined
      }, api())
      if (res.data?.tolerance_exceeded) { setTolWarn(res.data); return }
      addToast(`Received ${receiveQty} ${found.unit} — PO ${selectedPO.order_number || '#'+selectedPO.id}`)
      pushHistory({ product: found.name, code: found.product_code, action: 'receive', delta: +parseFloat(receiveQty), unit: found.unit })
      setTolWarn(null); setDiscrepancyReason('')
      clearScan()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  // ─── Cycle Count ───────────────────────────
  async function handleCycleCount() {
    if (newStock === '') { addToast('Enter actual stock count', 'error'); return }
    setSaving(true)
    try {
      const res = await axios.post('/api/stock/adjust', {
        product_id: found.id,
        new_stock: parseFloat(newStock),
        notes: `Cycle count${notes ? ': ' + notes : ''}`
      }, api())
      const delta = parseFloat(newStock) - parseFloat(found.current_stock)
      addToast(`Cycle count saved — ${found.name}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ' (no change)'}`)
      pushHistory({ product: found.name, code: found.product_code, action: 'cycle', delta, newBalance: res.data.current_stock, unit: found.unit })
      clearScan()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  // ─── Transfer ──────────────────────────────
  async function handleTransfer() {
    if (!newLocation.trim()) { addToast('Enter new bin location', 'error'); return }
    if (newLocation.trim() === found.bin_location) { addToast('Location unchanged', 'error'); return }
    setSaving(true)
    try {
      await axios.put(`/api/products/${found.id}/location`, { bin_location: newLocation.trim() }, api())
      addToast(`${found.name} moved to ${newLocation}`)
      pushHistory({ product: found.name, code: found.product_code, action: `→ ${newLocation}`, delta: 0, unit: '' })
      clearScan()
    } catch (e) { addToast(e.response?.data?.error || 'Failed', 'error') }
    finally { setSaving(false) }
  }

  function pushHistory(entry) {
    setLastActions(prev => [{ ...entry, time: new Date() }, ...prev.slice(0, 14)])
  }

  const wf = WORKFLOWS.find(w => w.key === workflow)

  return (
    <div style={{ padding: 28, maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 22, color: '#e8eaf2' }}>Barcode Scanner</h1>
        <p style={{ fontSize: 13, color: 'rgba(232,234,242,0.4)', marginTop: 4 }}>Scan a product barcode or type it manually</p>
      </div>

      {/* Workflow tabs */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {WORKFLOWS.map(w => {
          const Icon = w.icon
          const active = workflow === w.key
          return (
            <Tooltip key={w.key} text={w.desc} position="bottom">
              <button onClick={() => setWorkflow(w.key)} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                background: active ? `${w.color}18` : 'rgba(255,255,255,0.04)',
                border: active ? `1px solid ${w.color}50` : '1px solid rgba(255,255,255,0.09)',
                borderRadius: 8, padding: '7px 14px', cursor: 'pointer',
                color: active ? w.color : 'rgba(232,234,242,0.5)',
                fontSize: 12, fontWeight: 700
              }}>
                <Icon size={13} /> {w.label}
              </button>
            </Tooltip>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: lastActions.length > 0 ? '1fr 280px' : '1fr', gap: 20 }}>
        <div>
          {/* Scan input */}
          <div style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${wf.color}30`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <ScanBarcode size={16} color={wf.color} />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#e8eaf2' }}>Scan Product</span>
              <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.35)', marginLeft: 4 }}>— {wf.desc}</span>
            </div>
            <form onSubmit={handleScan} style={{ display: 'flex', gap: 10 }}>
              <input
                ref={barcodeRef}
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
                placeholder="Scan barcode or type manually..."
                style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: `2px solid ${wf.color}40`, borderRadius: 8, padding: '10px 14px', color: '#e8eaf2', fontSize: 14, outline: 'none', fontFamily: 'monospace' }}
                autoComplete="off"
              />
              <button type="submit" disabled={scanning} style={{ background: wf.color.startsWith('#') ? undefined : wf.color, backgroundColor: wf.color, border: 'none', borderRadius: 8, padding: '10px 18px', color: 'white', fontWeight: 700, fontSize: 13, cursor: scanning ? 'not-allowed' : 'pointer', opacity: scanning ? 0.7 : 1 }}>
                {scanning ? '...' : 'Search'}
              </button>
            </form>
            {notFound && (
              <div style={{ marginTop: 10, padding: '9px 14px', background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, fontSize: 13, color: '#f87171' }}>
                No product found for barcode: <strong style={{ fontFamily: 'monospace' }}>{barcode}</strong>
              </div>
            )}
          </div>

          {/* Product card */}
          {found && (
            <div style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${wf.color}30`, borderRadius: 12, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, padding: '12px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e8eaf2', marginBottom: 4 }}>{found.name}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(232,234,242,0.5)' }}>{found.product_code}</span>
                    {found.category && <span style={{ background: `${CAT_COLORS[found.category] || '#888'}18`, color: CAT_COLORS[found.category] || '#888', padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>{found.category}</span>}
                    {found.bin_location && <span style={{ fontSize: 11, color: '#fb923c' }}>📍 {found.bin_location}</span>}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: Number(found.current_stock) <= 0 ? '#f87171' : '#4ade80' }}>
                    {Number(found.current_stock).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)' }}>{found.unit} in stock</div>
                </div>
              </div>

              {/* ── General ── */}
              {workflow === 'general' && (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                    {[['add','Add Stock','#22c55e'],['remove','Remove Stock','#f87171'],['adjust','Set Stock','#60a5fa']].map(([k,l,c]) => (
                      <button key={k} onClick={() => setAction(k)} style={{ flex: 1, background: action === k ? `${c}20` : 'rgba(255,255,255,0.04)', border: action === k ? `1px solid ${c}60` : '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '8px 0', cursor: 'pointer', color: action === k ? c : 'rgba(232,234,242,0.5)', fontSize: 12, fontWeight: 700 }}>{l}</button>
                    ))}
                  </div>
                  {action === 'adjust' ? (
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>New Stock Value ({found.unit})</label>
                      <input type="number" value={newStock} onChange={e => setNewStock(e.target.value)} step="any" style={inp} autoFocus />
                    </div>
                  ) : (
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Quantity ({found.unit})</label>
                      <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min={0.01} step="any" placeholder="0" style={inp} autoFocus />
                    </div>
                  )}
                  <div style={{ marginBottom: 16 }}>
                    <label style={lbl}>Notes (optional)</label>
                    <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Batch, PO, reason..." style={inp} />
                  </div>
                  <ActionButtons onCancel={clearScan} onConfirm={handleGeneral} saving={saving} confirmLabel={action === 'add' ? 'Add Stock' : action === 'remove' ? 'Remove Stock' : 'Set Stock'} confirmColor={action === 'add' ? '#22c55e' : action === 'remove' ? '#dc2626' : '#2563eb'} />
                </>
              )}

              {/* ── Receiving ── */}
              {workflow === 'receiving' && (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Open Purchase Orders</div>
                    {!found.open_pos?.length ? (
                      <div style={{ padding: '12px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 13, color: 'rgba(232,234,242,0.4)' }}>
                        No open purchase orders for this product
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {found.open_pos.map(po => {
                          const remaining = Number(po.quantity) - Number(po.quantity_received)
                          const isSelected = selectedPO?.id === po.id
                          return (
                            <div key={po.id} onClick={() => { setSelectedPO(po); setReceiveQty(String(remaining > 0 ? remaining : '')) }} style={{ padding: '10px 14px', background: isSelected ? 'rgba(52,211,153,0.08)' : 'rgba(255,255,255,0.03)', border: `1px solid ${isSelected ? 'rgba(52,211,153,0.3)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2' }}>{po.order_number || `PO #${po.id}`}</div>
                                <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginTop: 1 }}>{po.supplier || 'No supplier'}</div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: 12, color: '#34d399', fontWeight: 700 }}>{Number(po.quantity_received).toLocaleString()} / {Number(po.quantity).toLocaleString()} {found.unit}</div>
                                {po.estimated_delivery_date && <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)' }}>{new Date(po.estimated_delivery_date).toLocaleDateString('en-AU')}</div>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {selectedPO && (
                    <>
                      <div style={{ marginBottom: 12 }}>
                        <label style={lbl}>Quantity Received ({found.unit})</label>
                        <input type="number" value={receiveQty} onChange={e => setReceiveQty(e.target.value)} min={0.01} step="any" style={inp} autoFocus />
                      </div>
                      <div style={{ marginBottom: 16 }}>
                        <label style={lbl}>Notes (optional)</label>
                        <input value={receiveNotes} onChange={e => setReceiveNotes(e.target.value)} placeholder="Condition, batch, remarks..." style={inp} />
                      </div>
                      {tolWarn && (
                        <div style={{ marginBottom: 16, padding: 14, background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.35)', borderRadius: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', marginBottom: 6 }}>⚠️ Outside receiving tolerance</div>
                          <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.7)', marginBottom: 10 }}>
                            Expected {Number(tolWarn.expected).toLocaleString()} · Received {Number(tolWarn.received).toLocaleString()} · Difference {Number(tolWarn.difference) > 0 ? '+' : ''}{Number(tolWarn.difference).toLocaleString()} ({tolWarn.diff_pct}%)
                          </div>
                          <label style={lbl}>Discrepancy reason (required)</label>
                          <input value={discrepancyReason} onChange={e => setDiscrepancyReason(e.target.value)} placeholder="e.g. supplier short-shipped, damaged units" style={inp} />
                        </div>
                      )}
                      <ActionButtons
                        onCancel={clearScan}
                        onConfirm={() => handleReceive(!!tolWarn)}
                        saving={saving}
                        confirmLabel={tolWarn ? 'Accept with Discrepancy' : 'Confirm Receipt'}
                        confirmColor={tolWarn ? '#d97706' : '#34d399'}
                      />
                    </>
                  )}
                </>
              )}

              {/* ── Picking ── */}
              {workflow === 'picking' && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                      Production Orders Needing This Product
                    </div>
                    {!found.picking_orders?.length ? (
                      <div style={{ padding: '12px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 13, color: 'rgba(232,234,242,0.4)' }}>
                        No active orders require this product
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {found.picking_orders.map(o => {
                          const needed = Number(o.quantity_required) - Number(o.quantity_debited)
                          const overdue = o.due_date && new Date(o.due_date) < new Date()
                          return (
                            <div key={o.id} style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.03)', border: `1px solid ${overdue ? 'rgba(248,113,113,0.25)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2', fontFamily: 'monospace' }}>{o.order_number}</div>
                                <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginTop: 1 }}>
                                  Status: {o.status.replace(/_/g,' ')}
                                </div>
                                {o.due_date && <div style={{ fontSize: 10, color: overdue ? '#f87171' : 'rgba(232,234,242,0.35)', marginTop: 1 }}>Due {new Date(o.due_date).toLocaleDateString('en-AU')}{overdue ? ' ⚠' : ''}</div>}
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#f472b6' }}>{Number(needed).toLocaleString()} {o.unit}</div>
                                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)' }}>needed</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={clearScan} style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '9px 0', color: '#e8eaf2', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>← Scan Another</button>
                  </div>
                </>
              )}

              {/* ── Cycle Count ── */}
              {workflow === 'cycle' && (
                <>
                  <div style={{ marginBottom: 14, padding: '10px 14px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 2 }}>System stock level</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#fbbf24' }}>{Number(found.current_stock).toLocaleString()} {found.unit}</div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={lbl}>Actual Count ({found.unit})</label>
                    <input type="number" value={newStock} onChange={e => setNewStock(e.target.value)} step="any" min={0} placeholder="Enter physical count..." style={inp} autoFocus />
                    {newStock !== '' && newStock !== String(found.current_stock) && (
                      <div style={{ marginTop: 6, fontSize: 12, color: parseFloat(newStock) < parseFloat(found.current_stock) ? '#f87171' : '#4ade80' }}>
                        Discrepancy: {parseFloat(newStock) > parseFloat(found.current_stock) ? '+' : ''}{(parseFloat(newStock) - parseFloat(found.current_stock)).toFixed(2)} {found.unit}
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={lbl}>Reason / Notes (optional)</label>
                    <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Reason for discrepancy..." style={inp} />
                  </div>
                  <ActionButtons onCancel={clearScan} onConfirm={handleCycleCount} saving={saving} confirmLabel="Save Count" confirmColor="#fbbf24" />
                </>
              )}

              {/* ── Transfer ── */}
              {workflow === 'transfer' && (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Current Location</div>
                    <div style={{ fontSize: 14, color: found.bin_location ? '#fb923c' : 'rgba(232,234,242,0.3)', fontWeight: 700 }}>
                      {found.bin_location ? `📍 ${found.bin_location}` : 'No location assigned'}
                    </div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={lbl}>New Bin Location *</label>
                    <input value={newLocation} onChange={e => setNewLocation(e.target.value)} placeholder="e.g. A-03-2, Shelf B, Cold Room..." style={inp} autoFocus />
                  </div>
                  <ActionButtons onCancel={clearScan} onConfirm={handleTransfer} saving={saving} confirmLabel="Move to Location" confirmColor="#fb923c" disabled={!newLocation.trim() || newLocation.trim() === found.bin_location} />
                </>
              )}
            </div>
          )}

          {/* Ready to scan hint */}
          {!found && !notFound && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(232,234,242,0.2)' }}>
              <ScanBarcode size={48} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 13 }}>Ready to scan</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>Point scanner at barcode or type manually above</div>
            </div>
          )}
        </div>

        {/* Recent scan history */}
        {lastActions.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Recent Actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {lastActions.map((a, i) => (
                <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 9, padding: '9px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#e8eaf2' }}>{a.product}</div>
                    <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)', marginTop: 2 }}>
                      {a.time.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} · {a.action}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {a.delta !== 0 && a.unit ? (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 700, color: a.delta > 0 ? '#4ade80' : '#f87171' }}>
                          {a.delta > 0 ? '+' : ''}{a.delta.toLocaleString()} {a.unit}
                        </div>
                        {a.newBalance !== undefined && <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.35)' }}>→ {Number(a.newBalance).toLocaleString()}</div>}
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: '#fb923c' }}>{a.action}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActionButtons({ onCancel, onConfirm, saving, confirmLabel, confirmColor, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <button onClick={onCancel} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '9px 16px', color: 'rgba(232,234,242,0.6)', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>← Scan Another</button>
      <button onClick={onConfirm} disabled={saving || disabled} style={{ flex: 1, background: confirmColor, border: 'none', borderRadius: 8, padding: '9px 0', color: 'white', fontSize: 13, cursor: saving || disabled ? 'not-allowed' : 'pointer', fontWeight: 700, opacity: saving || disabled ? 0.55 : 1 }}>
        {saving ? 'Saving...' : confirmLabel}
      </button>
    </div>
  )
}

const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }
const inp = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
