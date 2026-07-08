// Shared date formatting utility.
// For TIMESTAMP strings from PostgreSQL (no tz info): appends 'Z' so JS parses as UTC,
// then displays in the user's local browser timezone.
// For DATE-only strings (YYYY-MM-DD): displays as-is without timezone conversion.

function isDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

export function fmt(d, opts = {}) {
  if (!d) return '—'
  if (isDateOnly(d)) {
    // Parse as local date (split to avoid UTC shift)
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y, m - 1, day).toLocaleDateString('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric', ...opts,
    })
  }
  const s = typeof d === 'string' && !/Z$|[+-]\d{2}:\d{2}$/.test(d) ? d + 'Z' : d
  const date = new Date(s)
  if (isNaN(date)) return '—'
  return date.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney', ...opts,
  })
}

export function fmtDate(d) {
  if (!d) return '—'
  if (isDateOnly(d)) {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y, m - 1, day).toLocaleDateString('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  }
  const s = typeof d === 'string' && !/Z$|[+-]\d{2}:\d{2}$/.test(d) ? d + 'Z' : d
  const date = new Date(s)
  if (isNaN(date)) return '—'
  return date.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' })
}
