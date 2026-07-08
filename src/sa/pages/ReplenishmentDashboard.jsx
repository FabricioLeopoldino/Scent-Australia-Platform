import { useState, useEffect, useRef } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import * as XLSX from 'xlsx';
import { GlowingEffect } from '../components/GlowingEffect';

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function Tooltip({ text, children }) {
  const [pos, setPos] = useState(null);
  const ref = useRef();

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.top - 8 });
    }
  };

  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'help' }}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: '50%', background: '#94a3b8', color: 'white', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>?</span>
      {pos && (
        <div style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          transform: 'translateX(-50%) translateY(-100%)',
          background: '#1e293b',
          color: '#f1f5f9',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'normal',
          maxWidth: 260,
          zIndex: 99999,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }}>
          {text}
          <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)', width: 10, height: 10, background: '#1e293b', clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
        </div>
      )}
    </span>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const styles = {
    Critical: { background: 'rgba(220,38,38,0.12)', color: '#f87171', border: '1px solid rgba(220,38,38,0.3)' },
    Attention: { background: 'rgba(217,119,6,0.12)', color: '#fbbf24', border: '1px solid rgba(217,119,6,0.3)' },
    Safe:      { background: 'rgba(22,163,74,0.12)', color: '#4ade80', border: '1px solid rgba(22,163,74,0.3)' },
  };
  return <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, ...styles[status] }}>{status}</span>;
}

// ─── Gap cell ─────────────────────────────────────────────────────────────────
function GapCell({ gap }) {
  if (gap === null || gap === undefined) return <span style={{ color: '#94a3b8' }}>—</span>;
  const isUp = gap < -10;
  const isDown = gap > 10;
  return (
    <span style={{ fontWeight: 600, color: isUp ? '#f87171' : isDown ? '#4ade80' : '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
      {isUp && <span style={{ fontSize: 14 }}>↑</span>}
      {isDown && <span style={{ fontSize: 14 }}>↓</span>}
      {gap >= 9990 ? '0' : gap.toFixed(1)}
    </span>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, icon }) {
  const colors = {
    red:    { bg: 'rgba(220,38,38,0.1)', text: '#f87171', border: 'rgba(220,38,38,0.3)' },
    yellow: { bg: 'rgba(217,119,6,0.1)', text: '#fbbf24', border: 'rgba(217,119,6,0.3)' },
    green:  { bg: 'rgba(22,163,74,0.1)', text: '#4ade80', border: 'rgba(22,163,74,0.3)' },
    blue:   { bg: 'rgba(37,99,235,0.1)', text: '#60a5fa', border: 'rgba(37,99,235,0.3)' },
  };
  const c = colors[color] || colors.blue;
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
      <span style={{ fontSize: 22 }}>{icon}</span>
      <span style={{ fontSize: 28, fontWeight: 900, color: c.text, fontFamily: 'Archivo Black, sans-serif' }}>{value}</span>
      <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>{label}</span>
    </div>
  );
}

// ─── Data Confidence badge ───────────────────────────────────────────────────
function ConfidenceBadge({ confidence, spikesRemoved, cleanDays }) {
  const cfg = {
    high:               { bg: 'rgba(22,163,74,0.12)',  color: '#4ade80', label: '●●●● High',        tip: `${cleanDays} days retail history. Conservative uses peak+B2B. ~90-93% confidence.` },
    medium:             { bg: 'rgba(217,119,6,0.12)', color: '#fbbf24', label: '●●●○ Medium',       tip: `${cleanDays} days retail history. Scenarios building accuracy. ~75-85% confidence.` },
    low:                { bg: 'rgba(234,88,12,0.12)', color: '#fb923c', label: '●●○○ Low',          tip: `${cleanDays} days retail history. Lean on B2B forecast more. ~60-75% confidence.` },
    very_low:           { bg: 'rgba(220,38,38,0.12)', color: '#f87171', label: '●○○○ Very Low',     tip: `${cleanDays} day(s) retail history. B2B forecast anchoring scenarios. ~50-60% confidence.` },
    forecast_only:      { bg: 'rgba(37,99,235,0.12)', color: '#60a5fa', label: '◆ B2B Only',        tip: 'No retail history. Scenarios based entirely on B2B forecast. ~45-55% confidence.' },
    no_data:            { bg: 'rgba(148,163,184,0.1)', color: '#94a3b8', label: '○ No Data',        tip: 'No retail history and no B2B forecast. Using minimum 0.1 L/d.' },
    high_no_forecast:   { bg: 'rgba(22,163,74,0.12)',  color: '#4ade80', label: '●●●● Retail Only', tip: `${cleanDays} days retail history. No B2B forecast — retail stream only.` },
    medium_no_forecast: { bg: 'rgba(217,119,6,0.12)', color: '#fbbf24', label: '●●○○ Retail Only', tip: `${cleanDays} days retail history. No B2B forecast imported yet.` },
    low_no_forecast:    { bg: 'rgba(234,88,12,0.12)', color: '#fb923c', label: '●○○○ Retail Only', tip: `${cleanDays} day(s) retail history. No B2B forecast imported yet.` },
  };
  const c = cfg[confidence] || cfg.no_data;
  return (
    <span title={c.tip} style={{ fontSize: 10, background: c.bg, color: c.color, padding: '2px 7px', borderRadius: 4, fontWeight: 700, whiteSpace: 'nowrap', cursor: 'help' }}>
      {c.label}
    </span>
  );
}

// ─── Number formatters ───────────────────────────────────────────────────────
// All stock/demand values come from backend already converted to L (÷1000 done in backend)
// We just need clean formatting here

// Format L value — up to 3 decimal places, thousand separator
const fmt = (v, decimals = 3) => {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) >= 9990) return '0';
  const rounded = parseFloat(Math.abs(v) < 0.001 && v !== 0 ? v.toFixed(4) : v.toFixed(decimals));
  const sign = v < 0 ? '-' : '';
  return sign + rounded.toLocaleString('en-AU', {
    minimumFractionDigits: decimals > 2 ? 1 : decimals,
    maximumFractionDigits: decimals
  });
};

// Format days — whole number, no decimals
const fmtDays = (v) => {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) >= 9990) return '0';
  const rounded = Math.round(v);
  // Avoid -0 display (e.g. -0.3 rounds to -0)
  if (rounded === 0) return '0';
  return rounded.toLocaleString('en-AU');
};

// ─── Product Detail Modal ─────────────────────────────────────────────────────
function ProductDetailModal({ product, detail, loading, onClose }) {
  if (!product) return null;

  const statusColor = product.safetyStatus === 'Critical' ? '#dc2626'
                    : product.safetyStatus === 'Attention' ? '#d97706' : '#16a34a';

  // Build bar chart data from daily sales
  const dailySales = detail?.dailySales || [];
  const maxVol = dailySales.length > 0 ? Math.max(...dailySales.map(d => d.volume_l)) : 1;

  // Days of stock progress bar
  const daysStock = product.daysOfStockActual;
  const safeTarget = 90;
  const pct = Math.min(100, Math.max(0, (daysStock / safeTarget) * 100));
  const barColor = daysStock < 45 ? '#dc2626' : daysStock <= 90 ? '#d97706' : '#16a34a';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}>
      <div className="replenishment-modal" style={{ background: '#0e0e1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, width: '100%', maxWidth: 780, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 25px 60px rgba(0,0,0,0.6)' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ background: '#1f3864', borderRadius: '16px 16px 0 0', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 11, color: '#93c5fd', fontWeight: 600, marginBottom: 4 }}>{product.productCode}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'white', marginBottom: 6 }}>{product.name}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ background: statusColor, color: 'white', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20 }}>{product.safetyStatus}</span>
              <span style={{ background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 11, padding: '2px 10px', borderRadius: 20 }}>{product.supplier || 'No supplier'}</span>
              <span style={{ background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 11, padding: '2px 10px', borderRadius: 20 }}>Lead time: {product.leadTime}d</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: 'white', fontSize: 20, cursor: 'pointer', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        <div style={{ padding: 24 }}>

          {/* Key metrics row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Real Stock', value: `${product.realStock} ${product.unit}`, color: product.realStock <= 0 ? '#dc2626' : '#16a34a' },
              { label: 'Safety Stock', value: `${product.safetyStockLevel} ${product.unit}`, color: '#d97706' },
              ...(product.safetyStatus !== 'Safe' && product.suggestedOrder > 0 ? [
                { label: 'Order (Expected)', value: `${product.suggestedOrder.toLocaleString()} ${product.unit}`, color: '#4ade80' },
                { label: 'Order (Safe)', value: `${product.safeOrder?.toLocaleString() || '—'} ${product.unit}`, color: '#fbbf24' },
              ] : []),
            ].map(m => (
              <div key={m.label} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: '12px 14px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.1)' }}>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.45)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{m.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: m.color }}>{m.value}</div>
              </div>
            ))}
          </div>

          {/* Demand streams breakdown */}
          <div style={{ marginBottom: 16, padding: '14px 16px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', marginBottom: 10 }}>Demand Streams</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Retail avg/day</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#60a5fa' }}>{product.retailDailyAvg ?? '—'} L</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>B2B (Forecast)/day</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#a78bfa' }}>{product.b2bDaily ?? '—'} L</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Total expected/day</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#4ade80' }}>{product.scenarioExpectedRate ?? '—'} L</div>
              </div>
            </div>
          </div>

          {/* 3 Scenarios */}
          <div style={{ marginBottom: 20, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {[
              { label: 'Conservative', days: product.daysConservative, rate: product.scenarioConservativeRate, tip: 'Peak retail + 100% B2B — buy-safe decision', color: '#f87171', bg: 'rgba(220,38,38,0.08)', border: 'rgba(220,38,38,0.25)' },
              { label: 'Expected', days: product.daysExpected, rate: product.scenarioExpectedRate, tip: 'Avg retail + 100% B2B — normal planning', color: '#fbbf24', bg: 'rgba(217,119,6,0.08)', border: 'rgba(217,119,6,0.25)' },
              { label: 'Optimistic', days: product.daysOptimistic, rate: product.scenarioOptimisticRate, tip: 'Min retail + 70% B2B — best case', color: '#4ade80', bg: 'rgba(22,163,74,0.08)', border: 'rgba(22,163,74,0.25)' },
            ].map(s => (
              <div key={s.label} title={s.tip} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: '12px', textAlign: 'center', cursor: 'help' }}>
                <div style={{ fontSize: 10, color: s.color, fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>{s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: s.color }}>{s.days >= 9999 ? '∞' : s.days}d</div>
                <div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)', marginTop: 2 }}>{s.rate} L/d</div>
              </div>
            ))}
          </div>

          {/* Days of stock progress bar */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1' }}>Days of Stock</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: barColor }}>
                {daysStock >= 9990 ? '∞' : daysStock <= 0 ? `${daysStock} days (deficit!)` : `${daysStock} days`}
              </span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.1)', borderRadius: 999, height: 14, overflow: 'hidden', position: 'relative' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 999, transition: 'width 0.6s ease' }} />
              {/* Lead time marker */}
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${Math.min(100,(product.leadTime/safeTarget)*100)}%`, width: 2, background: 'rgba(232,234,242,0.45)' }} title={`Lead time: ${product.leadTime} days`} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'rgba(232,234,242,0.3)' }}>
              <span>0</span>
              <span style={{ color: 'rgba(232,234,242,0.45)' }}>▲ Lead time ({product.leadTime}d)</span>
              <span>90 days (Safe)</span>
            </div>
            {daysStock < product.leadTime && daysStock > 0 && (
              <div style={{ marginTop: 8, padding: '6px 12px', background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, fontSize: 12, color: '#f87171', fontWeight: 600 }}>
                ⚠️ Stock will run out before order arrives — reorder immediately!
              </div>
            )}
            {daysStock <= 0 && (
              <div style={{ marginTop: 8, padding: '6px 12px', background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, fontSize: 12, color: '#f87171', fontWeight: 600 }}>
                🚨 Stock is in deficit — already oversold!
              </div>
            )}
          </div>

          {/* Forecast comparison */}
          {product.hasForecast && (
            <div style={{ marginBottom: 24, padding: '14px 16px', background: 'rgba(37,99,235,0.1)', borderRadius: 10, border: '1px solid rgba(37,99,235,0.25)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#93c5fd', marginBottom: 8 }}>📊 Salesforce Forecast</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>120-day Forecast</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#60a5fa' }}>{product.forecast120Days} L</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Forecast Daily</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#60a5fa' }}>{product.forecastDaily} L/d</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  {(() => {
                    const retail = product.retailDailyAvg || 0;
                    const forecast = product.forecastDaily || 0;
                    // Compare forecast vs retail: ratio shows alignment
                    // Require ≥5 sale days — fewer points make % statistically meaningless
                    if (retail > 0 && forecast > 0 && (product.cleanDays || 0) < 5) {
                      return (
                        <>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Retail vs Forecast</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24' }} title={`Only ${product.cleanDays || 0} sale day(s) — not enough data for a reliable comparison`}>Insuf. ({product.cleanDays || 0}d data)</div>
                        </>
                      );
                    } else if (retail > 0 && forecast > 0) {
                      const ratio = retail / forecast;
                      const pct = Math.round((ratio - 1) * 100);
                      const color = Math.abs(pct) <= 20 ? '#4ade80' : Math.abs(pct) <= 60 ? '#fbbf24' : '#f87171';
                      const label = pct > 0 ? `Retail +${pct}% vs Fcst` : `Retail ${pct}% vs Fcst`;
                      return (
                        <>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }} title="How much retail history differs from Salesforce forecast">Retail vs Forecast</div>
                          <div style={{ fontSize: 13, fontWeight: 800, color }}>{label}</div>
                        </>
                      );
                    } else if (retail > 0) {
                      return (
                        <>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Retail vs Forecast</div>
                          <div style={{ fontSize: 13, fontWeight: 800, color: '#fbbf24' }}>No forecast</div>
                        </>
                      );
                    } else {
                      return (
                        <>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Retail vs Forecast</div>
                          <div style={{ fontSize: 13, fontWeight: 800, color: '#60a5fa' }}>No retail data</div>
                        </>
                      );
                    }
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* Daily consumption bar chart */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 12 }}>
              📦 Daily Consumption — Last 30 Days
            </div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'rgba(232,234,242,0.3)' }}>Loading...</div>
            ) : dailySales.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'rgba(232,234,242,0.45)', background: 'rgba(255,255,255,0.03)', borderRadius: 10, fontSize: 13 }}>
                No sales recorded in the last 30 days
              </div>
            ) : (
              <>
                {/* Bar chart */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 12px 0', marginBottom: 8, overflow: 'hidden' }}>
                  {dailySales.map((d, i) => {
                    const h = maxVol > 0 ? Math.max(4, (d.volume_l / maxVol) * 96) : 4;
                    const isLarge = d.volume_l > product.avgDailyDemand * 1.5;
                    return (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                        <div title={`${d.date}: ${d.volume_l.toFixed(2)} L`} style={{
                          width: '100%', height: h, borderRadius: '3px 3px 0 0',
                          background: isLarge ? '#f59e0b' : '#3b82f6',
                          cursor: 'default', transition: 'opacity 0.2s'
                        }} />
                      </div>
                    );
                  })}
                </div>

                {/* Avg daily line label */}
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'rgba(232,234,242,0.45)', marginBottom: 8 }}>
                  <span>🔵 Normal day</span>
                  <span>🟡 High volume day (&gt;1.5× avg)</span>
                </div>

                {/* Date labels - show first and last */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(232,234,242,0.3)', marginBottom: 16 }}>
                  <span>{dailySales[0]?.date}</span>
                  <span>{dailySales[dailySales.length - 1]?.date}</span>
                </div>

                {/* Summary table */}
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <th style={{ padding: '6px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>Date</th>
                      <th style={{ padding: '6px 10px', textAlign: 'right', color: '#94a3b8', fontWeight: 600 }}>Volume (L)</th>
                      <th style={{ padding: '6px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailySales.map((d, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '5px 10px', color: '#cbd5e1' }}>{d.date}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 700, color: d.volume_l > product.avgDailyDemand * 1.5 ? '#f59e0b' : '#60a5fa' }}>
                          {d.volume_l.toFixed(2)} L
                        </td>
                        <td style={{ padding: '5px 10px', color: '#94a3b8', fontSize: 11 }}>{d.type}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: 'rgba(255,255,255,0.05)', fontWeight: 700 }}>
                      <td style={{ padding: '6px 10px', color: '#e2e8f0' }}>Total ({dailySales.length} days)</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#93c5fd' }}>
                        {dailySales.reduce((s, d) => s + d.volume_l, 0).toFixed(2)} L
                      </td>
                      <td style={{ padding: '6px 10px', color: '#e2e8f0' }} title="Projected demand rate: 30-day retail average + daily B2B forecast">Rate: {product.avgDailyDemand} L/d</td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Supplier Management Modal ────────────────────────────────────────────────
function SupplierModal({ suppliers, onClose, onSaved }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [list, setList] = useState(suppliers.map(s => ({ ...s, editing: false, newLeadTime: s.lead_time, newName: s.name, newNotes: s.notes || '' })));
  const [newName, setNewName] = useState('');
  const [newLeadTime, setNewLeadTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async (supplier) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/suppliers/${supplier.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: supplier.newName, lead_time: parseInt(supplier.newLeadTime), notes: supplier.newNotes })
      });
      if (!res.ok) throw new Error('Save failed');
      setList(l => l.map(s => s.id === supplier.id ? { ...s, name: supplier.newName, lead_time: parseInt(supplier.newLeadTime), notes: supplier.newNotes, editing: false } : s));
      setMsg({ type: 'success', text: 'Saved!' });
      onSaved();
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setSaving(false); }
  };

  const del = async (id) => {
    setConfirmState({ message: 'Delete this supplier?', onConfirm: async () => {
      setConfirmState(null);
      try {
        await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
        setList(l => l.filter(s => s.id !== id));
        onSaved();
      } catch (e) { showToast(e.message, 'error'); }
    }});
  };

  const add = async () => {
    if (!newName.trim() || !newLeadTime) { showToast('Name and lead time required', 'warning'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), lead_time: parseInt(newLeadTime) })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setList(l => [...l, { ...json, editing: false, newLeadTime: json.lead_time, newName: json.name, newNotes: json.notes || '' }]);
      setNewName(''); setNewLeadTime('');
      setMsg({ type: 'success', text: `${json.name} added!` });
      onSaved();
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#0e0e1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: 32, width: 560, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 18, margin: 0, color: '#e2e8f0' }}>🏭 Supplier Lead Times</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}>✕</button>
        </div>
        <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 20, background: 'rgba(22,163,74,0.08)', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(22,163,74,0.25)' }}>
          Lead times are automatically applied to all products by supplier name. No manual override needed per product.
        </p>
        {msg && (
          <div style={{ padding: '8px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, background: msg.type === 'success' ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', color: msg.type === 'success' ? '#4ade80' : '#f87171' }}>
            {msg.text}
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 24 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.45)', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>Supplier Name</th>
              <th style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.45)', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>Lead Time (days)</th>
              <th style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'rgba(232,234,242,0.45)', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                <td style={{ padding: '8px 8px' }}>
                  {s.editing
                    ? <input value={s.newName} onChange={e => setList(l => l.map(x => x.id === s.id ? { ...x, newName: e.target.value } : x))} style={{ border: '1px solid rgba(37,99,235,0.4)', borderRadius: 6, padding: '4px 8px', width: '100%', fontSize: 13, background: 'rgba(255,255,255,0.07)', color: '#e2e8f0' }} />
                    : <span style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0' }}>{s.name}</span>
                  }
                </td>
                <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                  {s.editing
                    ? <input type="number" value={s.newLeadTime} onChange={e => setList(l => l.map(x => x.id === s.id ? { ...x, newLeadTime: e.target.value } : x))} style={{ border: '1px solid rgba(37,99,235,0.4)', borderRadius: 6, padding: '4px 8px', width: 70, fontSize: 13, textAlign: 'center', background: 'rgba(255,255,255,0.07)', color: '#e2e8f0' }} />
                    : <span style={{ fontWeight: 700, fontSize: 14, color: s.lead_time > 30 ? '#d97706' : '#16a34a' }}>{s.lead_time}d</span>
                  }
                </td>
                <td style={{ padding: '8px 8px', textAlign: 'center', display: 'flex', gap: 6, justifyContent: 'center' }}>
                  {s.editing ? (
                    <>
                      <button onClick={() => save(s)} disabled={saving} style={{ padding: '4px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save</button>
                      <button onClick={() => setList(l => l.map(x => x.id === s.id ? { ...x, editing: false } : x))} style={{ padding: '4px 10px', background: 'rgba(255,255,255,0.08)', color: '#cbd5e1', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setList(l => l.map(x => x.id === s.id ? { ...x, editing: true } : x))} style={{ padding: '4px 12px', background: 'rgba(37,99,235,0.12)', color: '#60a5fa', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Edit</button>
                      <button onClick={() => del(s.id)} style={{ padding: '4px 10px', background: 'rgba(220,38,38,0.1)', color: '#f87171', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', marginBottom: 10 }}>Add New Supplier</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Supplier name" style={{ flex: 1, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px', fontSize: 13, background: 'rgba(255,255,255,0.06)', color: '#e2e8f0' }} />
            <input type="number" value={newLeadTime} onChange={e => setNewLeadTime(e.target.value)} placeholder="Days" style={{ width: 80, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px', fontSize: 13, textAlign: 'center', background: 'rgba(255,255,255,0.06)', color: '#e2e8f0' }} />
            <button onClick={add} disabled={saving} style={{ padding: '8px 18px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Add</button>
          </div>
        </div>
      </div>
      {confirmState && (
        <ConfirmModal
          message={confirmState.message}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  );
}

export default function ReplenishmentDashboard() {
  const showToast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productDetail, setProductDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importedBy, setImportedBy] = useState('');
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const fileInputRef = useRef();
  const [pendingOrders, setPendingOrders] = useState([]);
  const [pendingOrdersEnabled, setPendingOrdersEnabled] = useState(false);
  const [pendingOrdersLoading, setPendingOrdersLoading] = useState(false);
  const [showPendingOrders, setShowPendingOrders] = useState(false);

  const fetchPendingOrders = async () => {
    setPendingOrdersLoading(true);
    try {
      const res = await fetch('/api/shopify/pending-orders');
      const json = await res.json();
      setPendingOrdersEnabled(json.enabled);
      setPendingOrders(json.orders || []);
    } catch (e) { /* silent */ }
    finally { setPendingOrdersLoading(false); }
  };

  const fetchData = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/dashboard/replenishment');
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    fetchData();
    fetchPendingOrders();
    const saved = localStorage.getItem('replenishment_imported_by');
    if (saved) setImportedBy(saved);
  }, []);

  // Migration runs once at server startup — no need to call from frontend

  const openProductDetail = async (product) => {
    setSelectedProduct(product);
    setProductDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/products/${product.id}/transactions?days=30`);
      const txData = await res.json();
      setProductDetail(txData);
    } catch (e) {
      setProductDetail({ error: true, dailySales: [] });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!importedBy.trim()) { showToast('Please enter your name before uploading.', 'warning'); e.target.value = ''; return; }
    setImporting(true); setImportResult(null);
    localStorage.setItem('replenishment_imported_by', importedBy);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('imported_by', importedBy);
    try {
      const res = await fetch('/api/forecast/import', { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Import failed');
      setImportResult({ type: 'success', message: `✅ Imported ${json.inserted} products (${json.skipped} skipped). Date: ${new Date(json.importDate).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })}` });
      await fetchData();
    } catch (err) { setImportResult({ type: 'error', message: `❌ ${err.message}` }); }
    finally { setImporting(false); e.target.value = ''; }
  };

  const handleExportPrevious = async () => {
    try {
      const res = await fetch('/api/forecast/last');
      if (!res.ok) { showToast((await res.json()).error || 'No previous forecast', 'error'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `forecast_backup_${new Date().toISOString().split('T')[0]}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
  };

  // ── Export full replenishment report as professional Excel
  const handleExportReport = () => {
    if (!data?.products?.length) { showToast('No data to export', 'warning'); return; }

    try {
      const allProducts = data.products;
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      const filterInfo = [
        filterStatus !== 'ALL' ? `Status: ${filterStatus}` : null,
        search ? `Search: "${search}"` : null,
      ].filter(Boolean).join(' | ') || 'All Products';

      const wb = XLSX.utils.book_new();

      // Reusable sheet builder
      const buildSheet = (rows, title, subtitle) => {
        const ws = XLSX.utils.aoa_to_sheet([
          [title],
          [subtitle],
          [`Generated: ${dateStr} ${timeStr}   |   Products: ${rows.length}   |   Critical: ${rows.filter(p => p.safetyStatus === 'Critical').length}   |   Attention: ${rows.filter(p => p.safetyStatus === 'Attention').length}   |   Safe: ${rows.filter(p => p.safetyStatus === 'Safe').length}`],
          [],
          ['Product Code', 'Product Name', 'Category', 'Supplier', 'Real Stock (L)', 'Safety Stock (L)', 'Avg Daily (L/d)', 'Sold 30d (L)', 'Forecast 120d (L)', 'Forecast Daily (L/d)', 'Projected Daily (L/d)', 'Projected Days', 'Days of Stock', 'Gap (d)', 'Safety Status', 'Order Qty', 'Lead Time (d)'],
          ...rows.map(p => [
            p.productCode || '',
            p.name || '',
            p.category || '',
            p.supplier || '',
            p.realStock ?? 0,
            p.safetyStockLevel ?? 0,
            parseFloat((p.avgDailyDemand ?? 0).toFixed(3)),
            p.totalSold30d ?? 0,
            p.hasForecast ? (p.forecast120Days ?? '') : '',
            p.hasForecast ? (p.forecastDaily ?? '') : '',
            parseFloat((p.projectedDaily ?? 0).toFixed(3)),
            p.projectedDaysOfStock >= 9990 ? parseFloat((p.realStock / Math.max(p.projectedDaily, 0.001)).toFixed(1)) : parseFloat((p.projectedDaysOfStock ?? 0).toFixed(1)),
            p.daysOfStockActual >= 9990 ? parseFloat((p.realStock / Math.max(p.avgDailyDemand, 0.001)).toFixed(1)) : parseFloat((p.daysOfStockActual ?? 0).toFixed(1)),
            p.hasForecast ? (p.gap >= 9990 ? 0 : parseFloat((p.gap ?? 0).toFixed(1))) : '',
            p.safetyStatus || '',
            p.safetyStatus !== 'Safe' && p.suggestedOrder > 0 ? p.suggestedOrder : '',
            p.leadTime ?? 30,
          ])
        ]);
        // 17 columns — one entry per header
        ws['!cols'] = [{ wch: 14 }, { wch: 36 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 15 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 15 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 13 }, { wch: 14 }];
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 16 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 16 } }, { s: { r: 2, c: 0 }, e: { r: 2, c: 16 } }];
        return ws;
      };

      // Sheet 1: Current view (respects active filters)
      XLSX.utils.book_append_sheet(wb, buildSheet(filtered, 'SCENT STOCK MANAGER — Replenishment Report', `Current View — ${filterInfo}`), 'Current View');

      // Sheet 2: Critical
      const criticalAll = allProducts.filter(p => p.safetyStatus === 'Critical');
      if (criticalAll.length > 0) XLSX.utils.book_append_sheet(wb, buildSheet(criticalAll, 'CRITICAL PRODUCTS — Action Required', `${criticalAll.length} products with Days of Stock < 45 days`), 'Critical');

      // Sheet 3: Attention
      const attentionAll = allProducts.filter(p => p.safetyStatus === 'Attention');
      if (attentionAll.length > 0) XLSX.utils.book_append_sheet(wb, buildSheet(attentionAll, 'ATTENTION — Monitor Closely', `${attentionAll.length} products with Days of Stock 45–90 days`), 'Attention');

      // Sheet 4: Full report
      XLSX.utils.book_append_sheet(wb, buildSheet(allProducts, 'SCENT STOCK MANAGER — Full Report', `All ${allProducts.length} products`), 'All Products');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Replenishment_Report_${now.toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Report exported — ${allProducts.length} products`, 'success');
    } catch (err) {
      console.error('Export error:', err);
      showToast('Export failed: ' + err.message, 'error');
    }
  };

  // Oils only — Scent Machines have their own dedicated page/calculation
  const oilsOnly = (data?.products || []).filter(p => p.category === 'OILS');

  const filtered = oilsOnly.filter(p => {
    const matchStatus = filterStatus === 'ALL' || p.safetyStatus === filterStatus;
    const q = search.toLowerCase();
    const matchSearch = !q || p.productCode?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q) || p.supplier?.toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  const thStyle = { padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94a3b8', background: 'rgba(14,14,26,0.95)', borderBottom: '2px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 10 };
  const tdStyle = { padding: '10px 12px', fontSize: 12, color: '#cbd5e1', borderBottom: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap' };
  const rowBg = (p) => p.safetyStatus === 'Critical' ? 'rgba(220,38,38,0.07)' : p.safetyStatus === 'Attention' ? 'rgba(217,119,6,0.07)' : 'transparent';
  const rowBorderLeft = (p) => {
    if (p.safetyStatus === 'Critical') return '3px solid #dc2626';
    if (p.projectedDaysOfStock < 45) return '3px solid #f97316';
    if (p.safetyStatus === 'Attention') return '3px solid #f59e0b';
    return '3px solid transparent';
  };

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 48 }}>📊</div>
      <p style={{ color: 'rgba(232,234,242,0.45)' }}>Calculating replenishment data...</p>
    </div>
  );

  if (error) return (
    <div style={{ padding: 32 }}>
      <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 12, padding: 24, color: '#f87171' }}>
        <strong>Error loading data:</strong> {error}<br /><br />
        <button onClick={fetchData} style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Retry</button>
        <span style={{ marginLeft: 12, fontSize: 12, color: 'rgba(232,234,242,0.45)' }}>
          First time? Run: <a href="/api/migrate-replenishment" target="_blank" style={{ color: '#93c5fd' }}>/api/migrate-replenishment</a>
        </span>
      </div>
    </div>
  );

  const meta = data?.meta || {};
  const suppliers = meta.suppliers || [];
  const filteredForStats = oilsOnly;

  return (
    // FIX 3: full width — no maxWidth constraint
    <div style={{ padding: '24px 32px' }}>

      {showSupplierModal && (
        <SupplierModal suppliers={suppliers} onClose={() => setShowSupplierModal(false)} onSaved={fetchData} />
      )}

      {/* ── Header ── */}
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontFamily: 'Archivo Black, sans-serif', color: '#e2e8f0', marginBottom: 4 }}>
            Demand Planning
          </h1>
          <p style={{ color: 'rgba(232,234,242,0.45)', fontSize: 13 }}>
            Retail (Shopify) + B2B (Salesforce) — 3 scenarios: Conservative · Expected · Optimistic
            {meta.calculatedAt && <span style={{ marginLeft: 12, color: '#94a3b8' }}>Updated: {new Date(meta.calculatedAt).toLocaleTimeString()}</span>}
          </p>
        </div>
        <button onClick={() => setShowSupplierModal(true)}
          style={{ padding: '10px 20px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 8 }}>
          🏭 Manage Suppliers & Lead Times
        </button>
      </div>

      {/* ── Supplier pills ── */}
      {suppliers.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {suppliers.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: '4px 14px', fontSize: 12 }}>
              <span style={{ fontWeight: 600, color: '#cbd5e1' }}>{s.name}</span>
              <span style={{ fontWeight: 700, color: s.lead_time > 30 ? '#d97706' : '#16a34a' }}>{s.lead_time}d</span>
            </div>
          ))}
          <button onClick={() => setShowSupplierModal(true)} style={{ background: 'none', border: '1px dashed rgba(255,255,255,0.12)', borderRadius: 20, padding: '4px 14px', fontSize: 12, color: 'rgba(232,234,242,0.3)', cursor: 'pointer' }}>+ Edit</button>
        </div>
      )}

      {/* ── Stat cards ── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <StatCard label="Total Oils" value={filteredForStats.length} color="blue" icon="📋" />
        <StatCard label="Critical (<45d)" value={filteredForStats.filter(d => d.safetyStatus === 'Critical').length} color="red" icon="🔴" />
        <StatCard label="Attention (45–90d)" value={filteredForStats.filter(d => d.safetyStatus === 'Attention').length} color="yellow" icon="🟡" />
        <StatCard label="Safe (>90d)" value={filteredForStats.filter(d => d.safetyStatus === 'Safe').length} color="green" icon="🟢" />
        {meta.lastForecastImport && (
          <div style={{ background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.3)', borderRadius: 12, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 22 }}>📁</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa' }}>Last Forecast Import</span>
            <span style={{ fontSize: 11, color: '#93c5fd' }}>{new Date(meta.lastForecastImport.import_date).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })} by {meta.lastForecastImport.imported_by}</span>
          </div>
        )}
      </div>

      {/* ── Import panel ── */}
      <div style={{ background: 'rgba(14,14,26,0.7)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 20, marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Your name (Imported by)</label>
          <input type="text" value={importedBy} onChange={e => setImportedBy(e.target.value)} placeholder="e.g. John Smith"
            style={{ border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: 200, background: 'rgba(255,255,255,0.06)', color: '#e2e8f0' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Salesforce Forecast (.xlsx)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => fileInputRef.current?.click()} disabled={importing}
              style={{ padding: '9px 18px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: importing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: importing ? 0.7 : 1 }}>
              {importing ? '⏳ Importing...' : '⬆️ Import Forecast'}
            </button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileSelect} style={{ display: 'none' }} />
            <button onClick={handleExportPrevious}
              style={{ padding: '9px 18px', background: 'rgba(255,255,255,0.08)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              ⬇️ Export Previous
            </button>
          </div>
        </div>
        <button onClick={fetchData}
          style={{ padding: '9px 18px', background: 'rgba(22,163,74,0.1)', color: '#4ade80', border: '1px solid rgba(22,163,74,0.3)', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          🔄 Refresh
        </button>

        {/* Export Report button */}
        <button
          onClick={handleExportReport}
          disabled={!data?.products?.length}
          style={{ padding: '9px 18px', background: 'rgba(22,163,74,0.1)', color: '#4ade80', border: '1px solid rgba(22,163,74,0.3)', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          📊 Export Report (.xlsx)
        </button>
        {importResult && (
          <div style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, background: importResult.type === 'success' ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', color: importResult.type === 'success' ? '#4ade80' : '#f87171', border: `1px solid ${importResult.type === 'success' ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}` }}>
            {importResult.message}
          </div>
        )}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Status filter */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(232,234,242,0.45)' }}>Status:</span>
          {['ALL', 'Critical', 'Attention', 'Safe'].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)} style={{
              padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: filterStatus === s ? 'none' : '1px solid rgba(255,255,255,0.1)',
              background: filterStatus === s ? (s === 'Critical' ? '#dc2626' : s === 'Attention' ? '#d97706' : s === 'Safe' ? '#16a34a' : '#2563eb') : 'rgba(255,255,255,0.05)',
              color: filterStatus === s ? 'white' : '#94a3b8'
            }}>{s}</button>
          ))}
        </div>

        <input type="text" placeholder="Search product, code or supplier..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 14px', fontSize: 13, width: 280, background: 'rgba(255,255,255,0.06)', color: '#e2e8f0' }} />

        <span style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)' }}>Showing {filtered.length} of {(data?.products || []).length} products</span>
      </div>

      {/* ── Legend ── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 11, color: 'rgba(232,234,242,0.45)', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: 'rgba(220,38,38,0.3)', border: '1px solid rgba(220,38,38,0.5)', display: 'inline-block', borderRadius: 2 }}></span>Critical &lt;45d</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: 'rgba(217,119,6,0.3)', border: '1px solid rgba(217,119,6,0.5)', display: 'inline-block', borderRadius: 2 }}></span>Attention 45–90d</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: 'rgba(22,163,74,0.3)', border: '1px solid rgba(22,163,74,0.5)', display: 'inline-block', borderRadius: 2 }}></span>Safe &gt;90d</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: 'transparent', border: '3px solid #f97316', display: 'inline-block', borderRadius: 2 }}></span>Projected risk</span>
        <span style={{ color: '#94a3b8' }}>Lead time = automatic from supplier settings</span>
        <span style={{ color: '#94a3b8' }}>Status = driven by Conservative scenario (worst-case protection)</span>
        <span style={{ color: '#94a3b8' }}>Conservative = peak retail + 100% B2B | Expected = avg retail + 100% B2B | Optimistic = min retail + 70% B2B</span>
        <span style={{ color: '#94a3b8' }}>Order Exp. = buy for normal planning | Order Safe = buy to never run out</span>
      </div>

      {/* ── Table ── */}
      <div className="table-scroll" style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'transparent' }}>
          <thead>
            <tr>
              <th style={thStyle}>Product Code</th>
              <th style={thStyle}>Product Name</th>
              <th style={{ ...thStyle, textAlign: 'right' }}><Tooltip text="Current physical stock. Oils in L, machines/materials in units.">Real Stock</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', color: '#60a5fa' }}><Tooltip text="Average daily retail consumption from transaction history (Shopify sales).">Retail/day</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', color: '#a78bfa' }}><Tooltip text="Daily B2B demand from Salesforce forecast (120d ÷ 120).">B2B/day</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', background: 'rgba(220,38,38,0.06)', color: '#f87171' }}><Tooltip text="Conservative: peak retail + 100% B2B forecast. Use this for buy-safe decisions.">Cons. Days</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', background: 'rgba(217,119,6,0.06)', color: '#fbbf24' }}><Tooltip text="Expected: avg retail + 100% B2B forecast. Use for normal purchase planning.">Exp. Days</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', background: 'rgba(22,163,74,0.06)', color: '#4ade80' }}><Tooltip text="Optimistic: min retail + 70% B2B forecast. Best-case scenario.">Opt. Days</Tooltip></th>
              <th style={thStyle}><Tooltip text="Status based on Conservative scenario. Critical = Cons.Days &lt; LeadTime+10d | Attention = &lt; LeadTime+45d | Safe = ≥ LeadTime+45d">Status</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', background: 'rgba(22,163,74,0.08)' }}><Tooltip text="Order (Expected): based on avg demand scenario — normal purchase quantity.">Order Exp.</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right', background: 'rgba(251,191,36,0.06)' }}><Tooltip text="Order (Safe): based on conservative scenario — buy this to never run out.">Order Safe</Tooltip></th>
              <th style={{ ...thStyle, textAlign: 'right' }}><Tooltip text="Lead time in days from supplier settings.">Lead (d)</Tooltip></th>
              <th style={thStyle}>Supplier</th>
              <th style={thStyle}><Tooltip text="Confidence based on retail history depth. High = 25+ days. Hover for detail.">Confidence</Tooltip></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={15} style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>No products found for the selected filters.</td></tr>
            ) : (
              filtered.map(p => (
                <tr key={p.id} style={{ background: rowBg(p), borderLeft: rowBorderLeft(p) }}>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11, color: 'rgba(232,234,242,0.45)' }}>{p.productCode}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span onClick={() => openProductDetail(p)} style={{ cursor: 'pointer', color: '#93c5fd', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }} title="Click to see consumption detail">
                      {p.name}
                    </span>
                    {p.noSalesData && <span title="No retail sales in last 30 days" style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>(no retail)</span>}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                    {fmt(p.realStock, 1)} <span style={{fontSize:10,color:'rgba(232,234,242,0.3)'}}>{p.unit}</span>
                    {p.incomingStock > 0 && (
                      <span title="Quantity in transit (pending PO)" style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: '#4ade80', background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: 8, padding: '1px 6px' }}>
                        +{fmt(p.incomingStock, 1)}
                      </span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: '#60a5fa' }}>{p.retailDailyAvg > 0 ? fmt(p.retailDailyAvg, 3) : <span style={{color:'rgba(232,234,242,0.25)'}}>—</span>}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: p.hasForecast ? '#a78bfa' : 'rgba(232,234,242,0.25)' }}>{p.hasForecast ? fmt(p.b2bDaily, 3) : '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, background: 'rgba(220,38,38,0.04)', color: p.daysConservative < 45 ? '#f87171' : p.daysConservative < 90 ? '#fbbf24' : '#4ade80' }}>
                    {p.daysConservative >= 9999 ? '∞' : fmtDays(p.daysConservative)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, background: 'rgba(217,119,6,0.04)', color: p.daysExpected < 45 ? '#f87171' : p.daysExpected < 90 ? '#fbbf24' : '#4ade80' }}>
                    {p.daysExpected >= 9999 ? '∞' : fmtDays(p.daysExpected)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, background: 'rgba(22,163,74,0.04)', color: p.daysOptimistic < 45 ? '#f87171' : p.daysOptimistic < 90 ? '#fbbf24' : '#4ade80' }}>
                    {p.daysOptimistic >= 9999 ? '∞' : fmtDays(p.daysOptimistic)}
                  </td>
                  <td style={tdStyle}><StatusBadge status={p.safetyStatus} /></td>
                  <td style={{ ...tdStyle, textAlign: 'right', background: p.safetyStatus !== 'Safe' ? 'rgba(22,163,74,0.06)' : 'transparent' }}>
                    {p.safetyStatus !== 'Safe' && p.suggestedOrder > 0
                      ? <span style={{ fontWeight: 800, color: '#4ade80', fontSize: 12 }}>{p.suggestedOrder.toLocaleString()} {p.unit}</span>
                      : <span style={{ color: 'rgba(232,234,242,0.25)' }}>—</span>}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', background: p.safetyStatus !== 'Safe' ? 'rgba(251,191,36,0.04)' : 'transparent' }}>
                    {p.safetyStatus !== 'Safe' && p.safeOrder > 0
                      ? <span style={{ fontWeight: 800, color: '#fbbf24', fontSize: 12 }}>{p.safeOrder.toLocaleString()} {p.unit}</span>
                      : <span style={{ color: 'rgba(232,234,242,0.25)' }}>—</span>}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, color: '#cbd5e1' }}>{p.leadTime}</td>
                  <td style={{ ...tdStyle, color: 'rgba(232,234,242,0.45)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.supplier || '—'}</td>
                  <td style={tdStyle}>
                    <ConfidenceBadge confidence={p.dataConfidence} spikesRemoved={p.spikesRemoved || 0} cleanDays={p.cleanDays || 0} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 12, fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>
        Retail = last 30 days of Shopify/transaction history. B2B = Salesforce forecast ÷ 120. Status based on Conservative scenario. Click product name to see consumption detail.
      </p>

      {/* Live Shopify Pending Orders */}
      <div style={{ marginTop: 32 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.25)', borderRadius: 12, marginBottom: showPendingOrders ? 0 : 0 }}
          onClick={() => { setShowPendingOrders(p => !p); if (!showPendingOrders) fetchPendingOrders(); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🛒</span>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#93c5fd' }}>Live Shopify Pending Orders</span>
            {pendingOrders.length > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}>
                {pendingOrders.length} unfulfilled
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {pendingOrdersLoading && <span style={{ fontSize: 11, color: '#93c5fd' }}>Loading...</span>}
            <button
              onClick={e => { e.stopPropagation(); fetchPendingOrders(); }}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(37,99,235,0.4)', background: 'transparent', color: '#93c5fd', cursor: 'pointer' }}
            >↻ Refresh</button>
            <span style={{ color: '#93c5fd', fontSize: 18 }}>{showPendingOrders ? '▲' : '▼'}</span>
          </div>
        </div>

        {showPendingOrders && (
          <div style={{ border: '1px solid rgba(37,99,235,0.25)', borderTop: 'none', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
            {!pendingOrdersEnabled ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>
                Shopify not connected. Set SHOPIFY_ACCESS_TOKEN and SHOPIFY_STORE_NAME in environment.
              </div>
            ) : pendingOrders.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'rgba(232,234,242,0.4)', fontSize: 13 }}>
                No unfulfilled orders in Shopify right now.
              </div>
            ) : (
              <div className="table-scroll" style={{ overflowX: 'auto' }}>
                <table className="table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th style={{ fontSize: 11 }}>Order #</th>
                      <th style={{ fontSize: 11 }}>Date</th>
                      <th style={{ fontSize: 11 }}>Customer</th>
                      <th style={{ fontSize: 11 }}>SKU</th>
                      <th style={{ fontSize: 11 }}>Product</th>
                      <th style={{ fontSize: 11, textAlign: 'right' }}>Qty</th>
                      <th style={{ fontSize: 11 }}>Matched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingOrders.flatMap(order =>
                      order.lineItems.map((item, idx) => (
                        <tr key={`${order.shopifyOrderId}_${idx}`}>
                          {idx === 0 && (
                            <>
                              <td rowSpan={order.lineItems.length} style={{ fontWeight: 700, color: '#60a5fa', fontSize: 12 }}>
                                #{order.orderNumber}
                              </td>
                              <td rowSpan={order.lineItems.length} style={{ fontSize: 11, color: 'rgba(232,234,242,0.45)' }}>
                                {new Date(order.createdAt).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                              </td>
                              <td rowSpan={order.lineItems.length} style={{ fontSize: 12 }}>{order.customer}</td>
                            </>
                          )}
                          <td style={{ fontFamily: 'monospace', fontSize: 11, color: '#93c5fd' }}>{item.sku || '—'}</td>
                          <td style={{ fontSize: 12 }}>{item.title}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 12 }}>{item.quantity}</td>
                          <td>
                            {item.localProduct ? (
                              <span style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}>
                                ✓ {item.localProduct.productCode}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'rgba(232,234,242,0.3)' }}>No match</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Product Detail Modal */}
      {selectedProduct && (
        <ProductDetailModal
          product={selectedProduct}
          detail={productDetail}
          loading={detailLoading}
          onClose={() => { setSelectedProduct(null); setProductDetail(null); }}
        />
      )}
    </div>
  );
}
