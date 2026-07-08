// Sequential code suggestion for master products, segmented by prefix.
// Standard → CS00001 · Major → MC00001 · MUSE → MUSE00001 (5-digit suffix).

export const MASTER_PREFIXES = {
  STANDARD: 'CS',
  MAJOR: 'MC',
  MUSE: 'MUSE',
}

export function suggestMasterCode(masters, prefix) {
  if (!prefix) return ''
  const len = prefix.length
  const nums = (masters || [])
    .map(m => (m.product_code || '').toUpperCase())
    .filter(c => c.startsWith(prefix) && /^[A-Z]+\d+$/.test(c))
    .map(c => parseInt(c.slice(len), 10))
    .filter(n => !Number.isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return prefix + String(next).padStart(5, '0')
}
