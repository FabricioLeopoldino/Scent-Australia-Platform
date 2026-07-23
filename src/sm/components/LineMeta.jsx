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
