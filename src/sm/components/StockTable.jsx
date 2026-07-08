// Shared products table — same layout used by /stock, /sm-stock and /muse-stock.
// Columns: Image · Product · Code · Shopify SKU · Segment · Barcode · Status · Total · Reserved · Available · Min · Bin · Actions
// Shopify SKU = product_code (single source of truth). When Shopify integration ships,
// this is the field that gets pushed. If a product ever needs a different SKU on Shopify,
// add an editable override field — for now keep it simple.
// Caller passes the products (already filtered) plus action callbacks. Buttons render
// only when their callback is provided, so each page shows what makes sense.
import { useRef, useEffect } from 'react'
import JsBarcode from 'jsbarcode'
import { useInkColor } from '../utils/theme.js'
import IconButton from './IconButton.jsx'
import { Edit2, Printer, Trash2, Upload, Image as ImageIcon, ExternalLink } from 'lucide-react'
import { PRODUCT_SEGMENTS, CAT_COLORS } from './ProductFormModal.jsx'

// Tiered status based on available stock vs min_stock_level:
//   avail <= 0                       → OUT OF STOCK  (red)
//   avail <  25% of min  (dropped ≥75%)  → CRITICAL   (red)
//   avail <  50% of min  (dropped ≥50%)  → LOW STOCK  (orange)
//   avail <  100% of min (dropped any)   → ATTENTION  (yellow)
//   avail >= min                          → SAFE       (green)
// When min == 0 we can't compute tiers, so anything above 0 is SAFE.
const STATUS_TONE = (stock, reserved, min) => {
  const avail = stock - reserved
  if (avail <= 0) return { label: 'OUT OF STOCK', color: '#ef4444' }
  if (min <= 0) return { label: 'SAFE', color: '#4ade80' }
  if (avail < min * 0.25) return { label: 'CRITICAL', color: '#f87171' }
  if (avail < min * 0.5) return { label: 'LOW STOCK', color: '#fb923c' }
  if (avail < min) return { label: 'ATTENTION', color: '#fbbf24' }
  return { label: 'SAFE', color: '#4ade80' }
}

function fmt(n, unit) {
  return `${Number(n).toLocaleString()}${unit ? ` ${unit}` : ''}`
}

function BarcodeTag({ value }) {
  const ref = useRef(null)
  const ink = useInkColor()
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', width: 1.1, height: 24,
        displayValue: false, margin: 0, background: 'transparent', lineColor: ink,
      })
    } catch { ref.current.innerHTML = '' }
  }, [value, ink])
  return <svg ref={ref} style={{ maxWidth: 110 }} />
}

function ImageCell({ image, name, accent, onUpload, onZoom }) {
  const inputRef = useRef(null)
  const showUpload = !!onUpload
  return (
    <div style={{ position: 'relative', width: 40, height: 40, flexShrink: 0 }}>
      {image ? (
        <img src={image} alt={name} onClick={(e) => { e.stopPropagation(); onZoom?.(image) }}
          style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', border: `1px solid ${accent}55`, cursor: onZoom ? 'zoom-in' : 'default' }} />
      ) : showUpload ? (
        <button onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }} title="Upload image"
          style={{ width: 40, height: 40, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, color: 'rgba(232,234,242,0.3)' }}>
          <Upload size={14} />
        </button>
      ) : (
        <div style={{ width: 40, height: 40, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ImageIcon size={13} color="rgba(232,234,242,0.2)" />
        </div>
      )}
      {showUpload && image && (
        <button onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }} title="Replace image"
          style={{ position: 'absolute', right: -5, bottom: -5, width: 18, height: 18, borderRadius: '50%', background: '#0f1117', border: `1px solid ${accent}`, color: accent, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <Upload size={9} />
        </button>
      )}
      {showUpload && (
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }} />
      )}
    </div>
  )
}

export default function StockTable({
  products, accent = '#60a5fa',
  onAdjust, onEdit, onPrint, onDelete, onUpload, onZoom, onRestore, onShopify,
}) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {['Product', 'Code', 'Shopify SKU', 'Segment', 'Barcode', 'Status', 'Total Stock', 'Reserved', 'Available', 'Min Level', 'Bin Location', 'Actions'].map(h => (
              <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.length === 0 ? (
            <tr><td colSpan={12} style={{ padding: '32px 14px', textAlign: 'center', color: 'rgba(232,234,242,0.3)', fontSize: 13 }}>No products</td></tr>
          ) : products.map(p => {
            const stock = parseFloat(p.current_stock) || 0
            const reserved = parseFloat(p.reserved_qty) || 0
            const avail = stock - reserved
            const min = parseFloat(p.min_stock_level) || 0
            const status = STATUS_TONE(stock, reserved, min)
            const bc = p.barcode || p.product_code
            const seg = PRODUCT_SEGMENTS.find(s => s.key === p.segment)
            const reservationTip = Array.isArray(p.reservation_detail)
              ? p.reservation_detail.map(d => `${d.order_number || 'Order'}: ${fmt(d.qty, p.unit)}`).join('\n')
              : ''
            return (
              <tr key={p.id} style={{ borderBottom: '1px solid var(--border)', opacity: p.archived ? 0.55 : 1 }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <ImageCell image={p.image_data} name={p.name} accent={accent} onUpload={onUpload ? (f) => onUpload(p.id, f) : undefined} onZoom={onZoom} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {p.name}
                        {p.archived && <span style={{ fontSize: 9, fontWeight: 700, color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Archived</span>}
                      </div>
                      {p.category && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                          {p.category.replace('_', ' ')}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{p.product_code}</td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }} title="This is the SKU that will sync to Shopify">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6b784d', flexShrink: 0 }} />
                    {p.product_code}
                  </span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {seg ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, letterSpacing: 0.3, whiteSpace: 'nowrap', color: seg.color }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
                      {seg.label}
                    </span>
                  ) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {bc ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <BarcodeTag value={bc} />
                      <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', fontFamily: 'monospace' }}>{bc}</span>
                    </div>
                  ) : <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)' }}>—</span>}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: 0.3, color: status.color }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.color, flexShrink: 0 }} />
                    {status.label}
                  </span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf2' }}>{fmt(stock, p.unit)}</span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {reserved === 0 ? (
                    <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.3)' }}>—</span>
                  ) : (
                    <span title={reservationTip || undefined} style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', cursor: reservationTip ? 'help' : 'default', borderBottom: reservationTip ? '1px dashed rgba(251,191,36,0.4)' : 'none' }}>
                      {fmt(reserved, p.unit)}
                    </span>
                  )}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: status.color }}>
                    {fmt(avail, p.unit)}
                  </span>
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'rgba(232,234,242,0.5)' }}>
                  {min > 0 ? fmt(min, p.unit) : '—'}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: p.bin_location ? 'rgba(232,234,242,0.6)' : 'rgba(232,234,242,0.25)', fontFamily: 'monospace' }}>
                  {p.bin_location || '—'}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {onAdjust && !p.archived && <IconButton className="icon-btn-text" onClick={() => onAdjust(p, 'add')} title="Adjust stock">Adjust</IconButton>}
                    {onEdit && !p.archived && <IconButton onClick={() => onEdit(p)} title="Edit product"><Edit2 size={13} /></IconButton>}
                    {onShopify && !p.archived && (
                      <IconButton onClick={() => onShopify(p)} title={p.shopify_product_id ? 'Synced to Shopify' : 'Publish to Shopify'} style={p.shopify_product_id ? { color: '#4ade80' } : undefined}>
                        <ExternalLink size={13} />
                      </IconButton>
                    )}
                    {onPrint && <IconButton onClick={() => onPrint(p)} title="Print barcode"><Printer size={13} /></IconButton>}
                    {onRestore && p.archived && <IconButton className="icon-btn-text" onClick={() => onRestore(p)} title="Restore product">Restore</IconButton>}
                    {onDelete && !p.archived && <IconButton variant="danger" onClick={() => onDelete(p)} title="Archive"><Trash2 size={13} /></IconButton>}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function btnStyle(color) {
  return {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
    color, fontSize: 11, fontWeight: 600,
  }
}
