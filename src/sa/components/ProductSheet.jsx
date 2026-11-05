import { useEffect, useState } from 'react';
import { SECTORS } from '../../../shared/sectors.js';
import { displayStock } from '../utils/unitConversion';
import { effectiveMin } from '../utils/stockStatus';

// The product sheet (PRD_H2_STOCK_MANAGEMENT.md §2.3, the owner's sketch in
// HYPER_UPDATE_BACKLOG.md §2.2): image, details, three stock cards, Shopify
// SKUs and the actions. ONE window for three places:
//   place 'stock'   — Stock Management: the product's stock, its typed minimum
//   place 'library' — Fragrance Library: the total and each company's balance,
//                     no minimum (owner, 27 Oct: the central store has none)
//   place 'sa'      — SA Fragrances: SA's balance and SA's automatic minimum
// Everything here is read-only; it changes through the actions (Edit, Adjust…),
// which the page passes in with its own permission already applied.
// The image is read live from the SA Shopify store and never stored (A11); no
// image, or Shopify down, leaves an empty frame and the sheet opens anyway.

const CATEGORY = {
  OILS: 'Fragrance oil', SCENT_MACHINES: 'Diffuser', MACHINES_SPARES: 'Spare part',
  RAW_MATERIALS: 'Raw material', SA_SCENTED_PRODUCTS: 'Scented product',
};
export const categoryLabel = (c) => CATEGORY[c] || c;

// The colours the diffusers carry today (Black, White, Grey); any other name
// still shows, as text beside a neutral swatch.
export const SWATCH = { black: '#111318', white: '#f4f4f5', grey: '#9ca3af', gray: '#9ca3af' };
export function Swatch({ color, size = 14 }) {
  if (!color) return null;
  const fill = SWATCH[String(color).toLowerCase()];
  return (
    <span title={color} aria-label={color} style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%', verticalAlign: 'middle',
      // A ring light enough to show Black on the dark theme and White on the light one.
      background: fill || 'transparent', border: `1.5px solid ${fill ? 'rgba(148,163,184,0.85)' : 'var(--border)'}`,
      boxShadow: fill ? 'inset 0 0 0 1px rgba(255,255,255,0.08)' : 'none',
    }} />
  );
}

const openIncoming = (p) => (p.incomingOrders || []).filter((o) => (o.status || 'pending') !== 'received')
  .reduce((t, o) => t + Math.max((parseFloat(o.quantity) || 0) - (parseFloat(o.quantityReceived) || 0), 0), 0);

function Card({ title, children }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>{title}</div>
      {children}
    </div>
  );
}

export default function ProductSheet({ product, place = 'stock', actions = [], onClose }) {
  const [shopify, setShopify] = useState(null);   // null = still asking
  const [aliases, setAliases] = useState([]);

  useEffect(() => {
    let live = true;
    fetch(`/api/products/${encodeURIComponent(product.id)}/shopify`)
      .then((r) => (r.ok ? r.json() : { image: null, variants: [] }))
      .then((d) => live && setShopify(d))
      .catch(() => live && setShopify({ image: null, variants: [] }));
    fetch(`/api/products/${encodeURIComponent(product.id)}/aliases`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => live && setAliases(Array.isArray(d) ? d : []))
      .catch(() => {});
    return () => { live = false; };
  }, [product.id]);

  const unit = product.unit;
  const val = (k) => product.sectors?.[k] || 0;
  const skus = Object.entries(product.shopifySkus || {}).filter(([, v]) => v);
  const statusOf = (sku) => shopify?.variants?.find((v) => v.sku === sku)?.status || null;
  const incoming = openIncoming(product);

  const stockCard = () => {
    if (place === 'sa') return <div style={{ fontSize: 22, fontWeight: 800 }}>{displayStock(product.saStock ?? product.currentStock, unit)}</div>;
    if (place === 'library') {
      const museParts = SECTORS.filter((s) => s.company === 'MUSE' && Math.abs(val(s.key)) > 0.0005);
      const line = (label, v, sub) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, paddingLeft: sub ? 10 : 0,
          color: v < 0 ? '#f87171' : sub ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
          <span>{label}</span><span style={{ fontWeight: 700 }}>{displayStock(v, unit)}</span>
        </div>
      );
      return (
        <>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{displayStock(product.currentStock, unit)}</div>
          {Math.abs(val('MAIN')) > 0.0005 && line('Main store', val('MAIN'))}
          {line('SA', val('SA'))}
          {museParts.length > 0 && line('MUSE total', museParts.reduce((t, s) => t + val(s.key), 0))}
          {museParts.map((s) => line(s.key === 'MUSE' ? 'Shared' : s.short, val(s.key), true))}
        </>
      );
    }
    return (
      <>
        <div style={{ fontSize: 22, fontWeight: 800, color: product.currentStock < 0 ? '#f87171' : 'var(--text-primary)' }}>
          {displayStock(product.currentStock, unit)}
        </div>
        {product.unitPerBox > 1 && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{product.stockBoxes} boxes of {product.unitPerBox}</div>}
      </>
    );
  };

  const minCard = () => {
    if (place === 'library') return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>None here: each company's minimum lives on its own page.</div>;
    const auto = place === 'sa' && product.minStockAuto != null;
    return (
      <div style={{ fontSize: 22, fontWeight: 800 }}>
        {displayStock(place === 'sa' ? effectiveMin(product) : (product.minStockLevel || 0), unit)}
        {auto && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}> auto</span>}
      </div>
    );
  };

  const detail = (label, value) => (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{value || '—'}</div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 820, width: '94vw' }} role="dialog" aria-label={`Product sheet: ${product.name}`}>
        <div className="modal-header">
          <h2 style={{ fontSize: 18 }}>{product.name}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 18, marginBottom: 16 }}>
          <div style={{ aspectRatio: '1 / 1', borderRadius: 12, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {shopify?.image?.url ? (
              <img src={shopify.image.url} alt={shopify.image.alt || product.name} loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>
                {shopify === null ? 'Asking Shopify…' : 'No image in Shopify'}
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, alignContent: 'start' }}>
            {detail('Product code', <span style={{ fontFamily: 'monospace' }}>{product.productCode}</span>)}
            {detail('Category', [categoryLabel(product.category), product.sub_category].filter(Boolean).join(' · '))}
            {detail('Bin location', product.bin_location)}
            {detail('Colour', product.color && <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Swatch color={product.color} />{product.color}</span>)}
            {detail('Supplier', product.supplier)}
            {detail('Supplier code', product.supplier_code && <span style={{ fontFamily: 'monospace' }}>{product.supplier_code}</span>)}
            {(product.status || 'active') === 'inactive' && detail('Status', <span style={{ color: '#94a3b8' }}>Inactive</span>)}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
          <Card title={place === 'library' ? 'Total stock' : place === 'sa' ? "SA's stock" : 'Current stock'}>{stockCard()}</Card>
          <Card title="Min. level">{minCard()}</Card>
          <Card title="Incoming">
            <div style={{ fontSize: 22, fontWeight: 800, color: incoming > 0 ? '#fbbf24' : 'var(--text-primary)' }}>{displayStock(incoming, unit)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {(product.incomingOrders || []).filter((o) => (o.status || 'pending') !== 'received').length} open order(s)
            </div>
          </Card>
        </div>

        <div style={{ borderRadius: 10, border: '1px solid var(--border)', padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Shopify SKUs</div>
            <a href="/sa/sku-mapping" style={{ fontSize: 12, color: '#60a5fa' }}>Edit in SKU Mapping →</a>
          </div>
          {skus.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>No Shopify SKU mapped.</div>
          ) : (
            <table className="table" style={{ fontSize: 12.5 }}>
              <thead><tr><th>Variant</th><th>SKU</th><th>Counts as</th><th>In Shopify</th></tr></thead>
              <tbody>
                {skus.map(([variant, sku]) => (
                  <tr key={variant}>
                    <td>{variant}</td>
                    <td style={{ fontFamily: 'monospace' }}>{sku}</td>
                    <td>{product.skuMultipliers?.[variant] ? `× ${product.skuMultipliers[variant]}` : '× 1'}</td>
                    <td style={{ color: statusOf(sku) === 'active' ? '#22c55e' : 'var(--text-secondary)' }}>
                      {shopify === null ? '…' : !shopify.enabled ? 'Cannot ask Shopify now' : statusOf(sku) || 'Not found'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {aliases.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
              Also known as: {aliases.map((a) => a.alias_name || a.aliasName || a.name).filter(Boolean).join(' · ')}
            </div>
          )}
        </div>

        {actions.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {actions.map((a) => (
              <button key={a.key} type="button" className={a.danger ? 'btn btn-danger' : a.primary ? 'btn btn-primary' : 'btn btn-secondary'}
                onClick={a.onClick} title={a.title || a.label} style={{ fontSize: 12.5, padding: '7px 14px' }}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
