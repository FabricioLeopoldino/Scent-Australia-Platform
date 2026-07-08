// Volume formatter — internal storage is always in ml.
// Display in litres when value >= 1000 ml (SA ScentSystem pattern).

export function fmtVolume(ml, unit) {
  // Non-ml units (g, oz, units) display as-is
  if (unit && unit !== 'ml') {
    const n = parseFloat(ml)
    if (isNaN(n)) return '—'
    return `${Number(n).toLocaleString('en-AU')} ${unit}`
  }

  const n = parseFloat(ml)
  if (isNaN(n) || n === 0) return '0 ml'

  // Below 1L — show ml
  if (Math.abs(n) < 1000) {
    return `${Number(n).toLocaleString('en-AU')} ml`
  }

  // 1L or more — show in litres
  const l = n / 1000
  const fmt = l % 1 === 0
    ? l.toLocaleString('en-AU')
    : l.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 3 })
  return `${fmt} L`
}

// For tables where you want value + unit separated (e.g., "1,250" "L" in different cells/spans)
export function splitVolume(ml, unit) {
  if (unit && unit !== 'ml') {
    const n = parseFloat(ml)
    return { value: isNaN(n) ? '—' : Number(n).toLocaleString('en-AU'), unit: unit }
  }
  const n = parseFloat(ml)
  if (isNaN(n)) return { value: '—', unit: 'ml' }
  if (Math.abs(n) < 1000) return { value: Number(n).toLocaleString('en-AU'), unit: 'ml' }
  const l = n / 1000
  const v = l % 1 === 0
    ? l.toLocaleString('en-AU')
    : l.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 3 })
  return { value: v, unit: 'L' }
}
