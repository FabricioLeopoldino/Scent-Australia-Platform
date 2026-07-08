/**
 * MlHelper — inline mL → L converter displayed below any mL input field.
 * Only renders when unit === 'mL' and value > 0.
 *
 * Usage:
 *   <MlHelper value={quantity} unit={product.unit} />
 */
export default function MlHelper({ value, unit }) {
  if (unit !== 'mL') return null;
  const ml = parseFloat(value);
  if (!ml || isNaN(ml) || ml <= 0) return null;

  const litres = ml / 1000;
  const formatted = litres % 1 === 0
    ? litres.toLocaleString('en-AU')
    : litres.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 3 });

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 6,
      padding: '4px 10px',
      background: 'rgba(16,185,129,0.1)',
      border: '1px solid rgba(16,185,129,0.25)',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 600,
      color: '#10b981',
    }}>
      <span style={{ opacity: 0.7 }}>📐</span>
      {ml.toLocaleString('en-AU')} mL = <strong style={{ color: '#34d399' }}>{formatted} L</strong>
    </div>
  );
}
