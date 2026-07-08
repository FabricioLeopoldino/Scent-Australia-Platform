export default function MlHint({ value, unit }) {
  if (unit !== 'ml') return null
  const ml = parseFloat(value)
  if (!ml || isNaN(ml) || ml <= 0) return null
  const litres = ml / 1000
  const fmt = litres % 1 === 0
    ? litres.toLocaleString('en-AU')
    : litres.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 3 })
  return (
    <div style={{ marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 6, fontSize: 11, fontWeight: 600, color: '#10b981' }}>
      📐 {ml.toLocaleString('en-AU')} ml = <strong style={{ color: '#34d399' }}>{fmt} L</strong>
    </div>
  )
}
