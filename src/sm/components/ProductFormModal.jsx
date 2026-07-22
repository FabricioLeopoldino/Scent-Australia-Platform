import { useState, useEffect, useRef } from 'react'
import { X, Upload } from 'lucide-react'
import JsBarcode from 'jsbarcode'
import { useInkColor } from '../utils/theme.js'
import axios from 'axios'
import MlHint from './MlHint.jsx'

function api() { return { headers: { Authorization: `Bearer ${localStorage.getItem('platform_token')}` } } }

export const CODE_PREFIXES = {
  FRAGRANCE: 'FRAG_',
  RAW_MATERIAL: 'RAW_',
  COMPONENT: 'COMP_',
  LABEL: 'LABEL_',
  FINISHED_GOOD: 'FG_',
  READY_FORMULA: 'RF-FRAG_',
  DIFFUSER: 'DIF_',
}

export const CAT_COLORS = {
  FRAGRANCE: '#a78bfa',
  RAW_MATERIAL: '#fbbf24',
  COMPONENT: '#60a5fa',
  LABEL: '#f472b6',
  FINISHED_GOOD: '#4ade80',
  READY_FORMULA: '#fb923c',
  DIFFUSER: '#38bdf8',
}

export const ALL_PROD_CATEGORIES = [
  { key: 'COMPONENT', label: 'Component' },
  { key: 'RAW_MATERIAL', label: 'Raw Material' },
  { key: 'LABEL', label: 'Label' },
  { key: 'FRAGRANCE', label: 'Fragrance' },
  { key: 'FINISHED_GOOD', label: 'Finished Good' },
  { key: 'READY_FORMULA', label: 'Ready Formula' },
  { key: 'DIFFUSER', label: 'Diffuser' },
]

// Product segment — scopes where a component/material is available.
// MUSE / STANDARD / SHARED → live in `products` (general stock).
// MAJOR → routes to `client_stock` for the selected Major client (reserved stock).
export const PRODUCT_SEGMENTS = [
  { key: 'MUSE',     label: 'MUSE',         color: '#f472b6' },
  { key: 'STANDARD', label: 'Standard',     color: '#60a5fa' },
  { key: 'MAJOR',    label: 'Major',        color: '#a78bfa' },
  { key: 'SHARED',   label: 'Shared (all)', color: '#fbbf24' },
]

export const EMPTY_PRODUCT_FORM = {
  name: '', product_code: '', category: 'COMPONENT', sub_category: '',
  segment: 'STANDARD', client_id: '',
  unit: 'units', current_stock: '0', min_stock_level: '0',
  supplier: '', supplier_code: '', bin_location: '', barcode: '',
  lead_time: '', notes: '', image_data: '', volume_ml: '', default_oil_pct: '',
  price: '', description: '',
}

export function defaultUnitForCategory(cat) {
  if (cat === 'FRAGRANCE' || cat === 'READY_FORMULA' || cat === 'RAW_MATERIAL') return 'ml'
  return 'units'
}

export function requiresBarcode(cat) {
  return ['RAW_MATERIAL', 'COMPONENT', 'FINISHED_GOOD', 'DIFFUSER'].includes(cat)
}

// Barcode auto-derived from the product code (spaces → dashes, uppercased).
export function autoBarcode(code) {
  return (code || '').trim().replace(/\s+/g, '-').toUpperCase()
}

// Apply a new product code to the form, keeping the barcode in sync with it
// unless the barcode was manually customised (i.e. no longer matches the code).
function syncedCodeUpdate(f, rawCode) {
  const code = (rawCode || '').toUpperCase()
  const next = { ...f, product_code: code }
  if (!f.barcode || f.barcode === autoBarcode(f.product_code)) {
    next.barcode = autoBarcode(code)
  }
  return next
}

// Suggest next sequential code for a category: FG_00001, FRAG_00002, etc.
export function suggestProductCode(category, products) {
  const prefix = CODE_PREFIXES[category]
  if (!prefix) return ''
  const nums = (products || [])
    .filter(p => p.product_code?.toUpperCase().startsWith(prefix))
    .map(p => parseInt(p.product_code.slice(prefix.length), 10))
    .filter(n => !isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return prefix + String(next).padStart(5, '0')
}

function resizeImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        const MAX = 900
        let w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX }
          else { w = Math.round(w * MAX / h); h = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.72))
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Shared product create/edit modal with helpers:
 * category pills, sequential code suggestion, barcode generator + preview,
 * MlHint, category-conditional fields, image upload.
 *
 * Props:
 *   mode        — 'create' | 'edit'
 *   form, setForm — controlled form state (shape = EMPTY_PRODUCT_FORM)
 *   saving      — disables save button
 *   onClose, onSave — callbacks
 *   allProducts — list used to compute next sequential code
 *   categories  — optional subset of ALL_PROD_CATEGORIES (default: all)
 */
// `segments` scopes the segment picker the same way `categories` scopes the
// category list — a page that only owns one segment (e.g. MUSE Stock) shouldn't
// offer to create Major-client reserved stock from its own "New Product" button.
export default function ProductFormModal({ mode, form, setForm, saving, onClose, onSave, allProducts, categories, segments }) {
  const fileRef = useRef(null)
  const cats = categories || ALL_PROD_CATEGORIES
  const segs = segments || PRODUCT_SEGMENTS
  const [majorClients, setMajorClients] = useState([])
  const [majorLoading, setMajorLoading] = useState(false)

  // Lazy-load Major clients only when the user picks the Major segment.
  useEffect(() => {
    if (form.segment !== 'MAJOR' || majorClients.length > 0 || majorLoading) return
    setMajorLoading(true)
    axios.get('/api/clients', api())
      .then(r => setMajorClients((r.data || []).filter(c => c.is_large_client)))
      .catch(() => {})
      .finally(() => setMajorLoading(false))
  }, [form.segment])

  const majorBlocked = form.segment === 'MAJOR' && (!form.client_id || majorClients.length === 0)

  function changeCategory(cat) {
    setForm(f => {
      let next = { ...f, category: cat, unit: defaultUnitForCategory(cat) }
      if (mode === 'create') {
        const isAutoCode = !f.product_code || Object.values(CODE_PREFIXES).some(p => f.product_code.toUpperCase().startsWith(p))
        if (isAutoCode) next = syncedCodeUpdate(next, suggestProductCode(cat, allProducts || []))
      }
      return next
    })
  }

  async function handleImage(file) {
    if (!file?.type?.startsWith('image/')) return
    const dataUrl = await resizeImage(file)
    setForm(f => ({ ...f, image_data: dataUrl }))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{mode === 'create' ? 'New Product' : 'Edit Product'}</h2>
          <button className="modal-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <PField label="Category *" full>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {cats.map(c => (
                <button key={c.key} type="button" onClick={() => changeCategory(c.key)} style={{
                  background: form.category === c.key ? `${CAT_COLORS[c.key]}25` : 'rgba(255,255,255,0.05)',
                  border: form.category === c.key ? `1px solid ${CAT_COLORS[c.key]}` : '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 6, padding: '5px 13px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  color: form.category === c.key ? CAT_COLORS[c.key] : 'rgba(232,234,242,0.55)',
                }}>{c.label}</button>
              ))}
            </div>
          </PField>

          <PField label="Segment *" full>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {segs.map(s => {
                // Major routes to client_stock — only meaningful at creation time. Disable on edit.
                const isMajorDisabled = s.key === 'MAJOR' && mode === 'edit'
                return (
                  <button key={s.key} type="button"
                    disabled={isMajorDisabled}
                    title={isMajorDisabled ? 'To convert this product to a Major client\'s Reserved Stock, delete it and recreate via the Major option.' : undefined}
                    onClick={() => { if (isMajorDisabled) return; setForm(f => ({ ...f, segment: s.key, client_id: s.key === 'MAJOR' ? f.client_id : '' })) }}
                    style={{
                      background: form.segment === s.key ? `${s.color}25` : 'rgba(255,255,255,0.05)',
                      border: form.segment === s.key ? `1px solid ${s.color}` : '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 6, padding: '5px 13px', fontSize: 11, fontWeight: 700,
                      cursor: isMajorDisabled ? 'not-allowed' : 'pointer',
                      opacity: isMajorDisabled ? 0.35 : 1,
                      color: form.segment === s.key ? s.color : 'rgba(232,234,242,0.55)',
                    }}>{s.label}</button>
                )
              })}
            </div>
            <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginTop: 5 }}>
              {mode === 'edit'
                ? <>To convert to a Major client's Reserved Stock, <strong>delete this product and recreate</strong> using the Major option.</>
                : <>MUSE / Standard / Shared live in general stock. <strong style={{ color: '#a78bfa' }}>Major</strong> goes into the selected client's Reserved Stock.</>}
            </div>
          </PField>

          {mode === 'create' && form.segment === 'MAJOR' && (
            <PField label="Major Client *" full>
              {majorLoading ? (
                <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.4)', padding: '8px 0' }}>Loading clients…</div>
              ) : majorClients.length === 0 ? (
                <div style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, padding: 10, fontSize: 12, color: '#f87171', lineHeight: 1.5 }}>
                  No Major clients yet. Create one in <strong>/customers</strong> (toggle <em>"Major Client"</em>) before creating Reserved Stock items.
                </div>
              ) : (
                <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} style={pInput}>
                  <option value="">— Select a Major client —</option>
                  {majorClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.45)', marginTop: 5 }}>
                Saved as Reserved Stock for this client. Appears in <strong>/sm-stock → Reserved Stock</strong> tab and is available only in this client's BOMs.
              </div>
            </PField>
          )}

          <PField label="Name *" full>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Glass Bottle 100ml" style={pInput} />
          </PField>

          <PField label="Product Code *">
            <input value={form.product_code} onChange={e => setForm(f => syncedCodeUpdate(f, e.target.value))} placeholder="e.g. COMP_00001" style={{ ...pInput, fontFamily: 'monospace' }} />
            {mode === 'create' && CODE_PREFIXES[form.category] && (
              <div style={{ marginTop: 6 }}>
                <button type="button" onClick={() => setForm(f => syncedCodeUpdate(f, suggestProductCode(form.category, allProducts || [])))}
                  style={{ background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 5, padding: '2px 10px', fontSize: 11, fontWeight: 700, color: '#60a5fa', cursor: 'pointer' }}>
                  Use {suggestProductCode(form.category, allProducts || [])}
                </button>
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(74,222,128,0.7)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4ade80' }} />
              This code is also the Shopify SKU
            </div>
          </PField>

          <PField label="Unit">
            <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} style={pInput}>
              <option value="units">units</option>
              <option value="ml">ml</option>
              <option value="L">L</option>
              <option value="g">g</option>
              <option value="kg">kg</option>
            </select>
          </PField>

          {mode === 'create' && (
            <PField label="Initial Stock">
              <input type="number" step="any" min={0} value={form.current_stock} onChange={e => setForm(f => ({ ...f, current_stock: e.target.value }))} style={pInput} />
              <MlHint value={form.current_stock} unit={form.unit} />
            </PField>
          )}
          <PField label="Min Stock Level">
            <input type="number" step="any" min={0} value={form.min_stock_level} onChange={e => setForm(f => ({ ...f, min_stock_level: e.target.value }))} style={pInput} />
            <MlHint value={form.min_stock_level} unit={form.unit} />
          </PField>

          {['FINISHED_GOOD', 'READY_FORMULA'].includes(form.category) && (
            <PField label="Volume (ml)">
              <input type="number" min={0} step="any" value={form.volume_ml} onChange={e => setForm(f => ({ ...f, volume_ml: e.target.value }))} placeholder="e.g. 100" style={pInput} />
              <MlHint value={form.volume_ml} unit="ml" />
            </PField>
          )}
          {form.category === 'FRAGRANCE' && (
            <PField label="Default Oil %">
              <input type="number" min={0} max={100} step="any" value={form.default_oil_pct} onChange={e => setForm(f => ({ ...f, default_oil_pct: e.target.value }))} placeholder="e.g. 25" style={pInput} />
            </PField>
          )}

          {form.category === 'DIFFUSER' && (
            <PField label="Price (AUD)">
              <input type="number" min={0} step="0.01" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="Not set yet" style={pInput} />
            </PField>
          )}
          {form.category === 'DIFFUSER' && (
            <PField label="Description" full>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3} placeholder="Shown on the Shopify product page..." style={{ ...pInput, resize: 'vertical', fontFamily: 'inherit' }} />
            </PField>
          )}

          <PField label={`Barcode${requiresBarcode(form.category) ? ' *' : ''}`} full>
            <BarcodeField value={form.barcode} productCode={form.product_code} onChange={v => setForm(f => ({ ...f, barcode: v }))} />
          </PField>

          <PField label="Bin Location">
            <input value={form.bin_location} onChange={e => setForm(f => ({ ...f, bin_location: e.target.value }))} placeholder="e.g. A-01-3" style={{ ...pInput, fontFamily: 'monospace' }} />
          </PField>
          <PField label="Sub-category">
            <input value={form.sub_category} onChange={e => setForm(f => ({ ...f, sub_category: e.target.value }))} placeholder="Optional" style={pInput} />
          </PField>

          <PField label="Supplier">
            <input value={form.supplier} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Supplier name" style={pInput} />
          </PField>
          <PField label="Supplier Code">
            <input value={form.supplier_code} onChange={e => setForm(f => ({ ...f, supplier_code: e.target.value }))} placeholder="Supplier's SKU" style={{ ...pInput, fontFamily: 'monospace' }} />
          </PField>

          <PField label="Lead Time (days)">
            <input type="number" min={0} value={form.lead_time} onChange={e => setForm(f => ({ ...f, lead_time: e.target.value }))} placeholder="e.g. 14" style={pInput} />
          </PField>
          <PField label="Image">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {form.image_data && <img src={form.image_data} alt="" style={{ width: 40, height: 40, borderRadius: 7, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.15)' }} />}
              <button onClick={() => fileRef.current?.click()} type="button" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,234,242,0.8)', padding: '7px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Upload size={12} /> {form.image_data ? 'Replace' : 'Upload'}
              </button>
              {form.image_data && (
                <button onClick={() => setForm(f => ({ ...f, image_data: '' }))} type="button" style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#f87171', padding: '7px 9px', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>Remove</button>
              )}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleImage(f); e.target.value = '' }} />
            </div>
          </PField>

          <PField label="Notes" full>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Optional notes..." style={{ ...pInput, resize: 'vertical', fontFamily: 'inherit' }} />
          </PField>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}
            disabled={saving || (mode === 'create' && majorBlocked)}
            title={majorBlocked ? 'Select a Major client first' : undefined}>
            {saving ? 'Saving...' : mode === 'create' ? 'Create Product' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

const pInput = {
  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8, padding: '9px 12px', color: '#e8eaf2', fontSize: 13, outline: 'none', boxSizing: 'border-box',
}

function PField({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(232,234,242,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

function BarcodeField({ value, productCode, onChange }) {
  const svgRef = useRef(null)
  const ink = useInkColor()
  useEffect(() => {
    if (!svgRef.current || !value) return
    try {
      JsBarcode(svgRef.current, value, {
        format: 'CODE128', width: 1.6, height: 44,
        displayValue: true, fontSize: 10, margin: 6,
        background: 'transparent', lineColor: ink,
      })
    } catch { svgRef.current.innerHTML = '' }
  }, [value, ink])

  function generate() {
    const code = (productCode || '').trim().replace(/\s+/g, '-').toUpperCase()
    if (code) onChange(code)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder="Auto-filled from product code — or scan/type to override"
          style={{ ...pInput, fontFamily: 'monospace', flex: 1 }} />
        <button type="button" onClick={generate} disabled={!productCode} title="Generate barcode from product code"
          style={{
            background: productCode ? 'rgba(37,99,235,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${productCode ? 'rgba(37,99,235,0.35)' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 700,
            cursor: productCode ? 'pointer' : 'not-allowed',
            color: productCode ? '#60a5fa' : 'rgba(232,234,242,0.3)', whiteSpace: 'nowrap', flexShrink: 0,
          }}>
          Generate
        </button>
      </div>
      {value && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, display: 'flex', justifyContent: 'center' }}>
          <svg ref={svgRef} />
        </div>
      )}
    </div>
  )
}
