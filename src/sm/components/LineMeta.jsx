// Shared per-line production metadata: the scent name + explicit label/packing
// state. Used on BOTH the Production Orders detail and the Manufacturing Queue so
// the factory floor reads the same thing in both places (and so a change can't
// drift between them — the "— N/A" bug came from two copies going out of sync).
//
// Owner-reported (2026-07-22): an order with and without label/packing looked
// identical, because the UI only showed a badge WHEN the line needed one. Absence
// was ambiguous — "doesn't need it" vs "nobody set it". So both states are now
// shown explicitly: a lit chip when required, a muted "No label / No packing"
// when not.

// Scent name in priority order: commercial override → legacy fragrance → D14
// Fragrance Library oil. Same order the Shopify draft-order title uses.
export function lineScent(line) {
  return line.variant_name || line.fragrance_name || line.oil_name || null
}

function Pill({ on, onLabel, offLabel, onColor }) {
  const bg = on ? `${onColor}1e` : 'rgba(255,255,255,0.04)'
  const bd = on ? `${onColor}55` : 'rgba(255,255,255,0.1)'
  const fg = on ? onColor : 'rgba(232,234,242,0.4)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, letterSpacing: 0.3, background: bg, border: `1px solid ${bd}`, color: fg }}>
      {on ? onLabel : offLabel}
    </span>
  )
}

// Explicit label + packing chips. Always renders both, so "no label" is a
// deliberate statement, not a missing element.
export function LineFlags({ line, style }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', ...style }}>
      <Pill on={!!line.needs_labeling} onLabel="🏷️ Label" offLabel="No label" onColor="#fbbf24" />
      <Pill on={!!line.needs_packing} onLabel="📦 Packing" offLabel="No packing" onColor="#60a5fa" />
    </span>
  )
}

// What the customer actually asked for on an Atelier order — Metallic Foil, an
// uploaded label, the finish chosen. Found 2026-09-09: this rode as a Shopify
// line property with no SKU of its own (order #1024's "Standard" and
// "Metallic foil" lines shared one variant_id — foil is applied to the
// label/packaging by whoever prints them, never a different component), and a
// matched order dropped it on the way into production with nothing to show it
// ever existed. Renders nothing when there is nothing to show, same as the
// components list beside it.
export function CustomerProperties({ line, style }) {
  const props = Array.isArray(line.customer_properties) ? line.customer_properties : []
  const visible = props.filter((p) => p?.name && !String(p.name).startsWith('_')) // leading _ = internal, not the customer's own choice
  if (!visible.length) return null
  const isUrl = (v) => /^https?:\/\//.test(String(v || ''))
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 10px', marginBottom: 8, borderRadius: 6, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', ...style }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.4, paddingTop: 1 }}>Customer asked for:</span>
      {visible.map((p, i) => (
        <span key={i} style={{ fontSize: 11, color: 'rgba(232,234,242,0.85)' }}>
          <strong>{p.name}:</strong>{' '}
          {isUrl(p.value)
            ? <a href={p.value} target="_blank" rel="noreferrer" style={{ color: '#fbbf24' }}>view file</a>
            : p.value}
          {i < visible.length - 1 ? ' ·' : ''}
        </span>
      ))}
    </div>
  )
}
