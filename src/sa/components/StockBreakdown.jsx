import { SECTORS } from '../../../shared/sectors.js';
import { displayStock } from '../utils/unitConversion';

// Who holds an oil, under its total: the main store (only when it holds
// something), SA, then MUSE as ONE figure with its units under it. One
// component for the Fragrance Library table, the oil sheet and the MUSE
// screens, so the three always read the same.
//
// The MUSE units are PART of "MUSE total", never added to it. They are set
// apart on purpose (owner, 10 Nov 2026: read flat, SA 47.7 + MUSE total 20 +
// Atelier 20 looks like 87.7): a rule above the MUSE block, the total in bold,
// and each unit smaller, indented and marked "↳".
//
// `own` is the stock of the screen's own unit (MUSE_ATELIER in The Atelier):
// it is always shown, even at zero, and highlighted. `fill` stretches the
// figures to the right edge (the oil sheet's card).
export default function StockBreakdown({ sectors, unit = 'mL', own = null, size = 11, fill = false }) {
  const val = (k) => Number(sectors?.[k]) || 0;
  const shown = (k) => Math.abs(val(k)) > 0.0005;
  const museParts = SECTORS.filter((s) => s.company === 'MUSE' && (shown(s.key) || s.key === own));
  const cell = (key, label, v, { title = label, color = 'var(--text-secondary)', weight, sub = false, first = false } = {}) => {
    const neg = v < 0;
    const style = {
      color: neg ? '#f87171' : color, fontWeight: neg ? 700 : weight,
      ...(sub && { fontSize: size - 1 }),
      ...(first && { borderTop: '1px solid var(--border, rgba(148,163,184,0.25))', marginTop: 3, paddingTop: 3 }),
    };
    const tip = neg ? `${title} is below zero — shown in red, never blocked` : title;
    return [
      <span key={`${key}-l`} style={{ ...style, ...(sub && { paddingLeft: 6 }) }} title={tip}>{sub ? `↳ ${label}` : label}</span>,
      <span key={`${key}-v`} style={{ ...style, textAlign: 'right' }} title={tip}>{displayStock(v, unit)}</span>,
    ];
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: fill ? '1fr auto' : 'auto auto', columnGap: 8, fontSize: size, lineHeight: 1.5,
      marginTop: 4, whiteSpace: 'nowrap', justifyContent: fill ? undefined : 'start' }}>
      {shown('MAIN') && cell('MAIN', 'Main', val('MAIN'), { title: 'Main store — oil waiting for its split', color: '#38bdf8' })}
      {cell('SA', 'SA', val('SA'), { weight: 600 })}
      {museParts.length > 0 && cell('MUSE_TOTAL', 'MUSE total', museParts.reduce((t, s) => t + val(s.key), 0),
        { title: 'MUSE, all units — the lines under it are part of this figure', color: 'var(--text-primary)', weight: 700, first: true })}
      {museParts.map((s) => cell(s.key, s.key === 'MUSE' ? 'Shared' : s.short, val(s.key), {
        title: s.key === own ? `${s.label} — this unit` : s.label, sub: true,
        ...(s.key === own ? { color: '#d4b574', weight: 700 } : {}),
      }))}
    </div>
  );
}
