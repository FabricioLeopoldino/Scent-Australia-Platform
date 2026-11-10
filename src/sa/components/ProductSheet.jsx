import { useEffect, useState } from 'react';
import { displayStock } from '../utils/unitConversion';
import { effectiveMin } from '../utils/stockStatus';
import { useToast } from './Toast';
import PublishOilModal from './PublishOilModal';
import StockBreakdown from './StockBreakdown';

// The product sheet (PRD_H2_STOCK_MANAGEMENT.md §2.3, the owner's sketch in
// HYPER_UPDATE_BACKLOG.md §2.2): image, details, three stock cards, Shopify
// SKUs and the actions. ONE window for three places:
//   place 'stock'   — Stock Management: the product's stock, its typed minimum
//   place 'library' — Fragrance Library: the total and each company's balance,
//                     no minimum (owner, 27 Oct: the central store has none)
//   place 'sa'      — SA Fragrances: SA's balance and SA's automatic minimum
// Everything here is read-only; it changes through the actions (Edit, Adjust…),
// which the page passes in with its own permission already applied.
// canPublish (admin/root): an oil's Publish to Shopify and Add missing sizes
// (P7) live here since SKU Mapping was removed (owner, 6 Nov 2026).
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

export default function ProductSheet({ product, place = 'stock', actions = [], canPublish = false, onClose }) {
  const showToast = useToast();
  const [shopify, setShopify] = useState(null);   // null = still asking
  const [publishFor, setPublishFor] = useState(null); // { mode, missingSkus }
  const [reread, setReread] = useState(0);         // asks Shopify again after a publish
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
  }, [product.id, reread]);

  const unit = product.unit;
  const skus = Object.entries(product.shopifySkus || {}).filter(([, v]) => v);
  // A SKU on both an old one-per-size listing and the main product shows the main one.
  const variantOf = (sku) => {
    const all = (shopify?.variants || []).filter((v) => v.sku === sku);
    return all.find((v) => v.main) || all[0] || null;
  };
  const statusOf = (sku) => variantOf(sku)?.status || null;
  // P7, the same rule as the server's publishOil / addMissingOilSizes: no main
  // product yet → Publish (old listings may exist); a main product lacking
  // sizes → Add missing sizes. Unknown until Shopify has answered.
  const oilPublish = (() => {
    if (!canPublish || product.category !== 'OILS' || !shopify?.enabled || !skus.length) return null;
    const missing = skus.map(([, sku]) => sku).filter((sku) => !variantOf(sku)?.main);
    if (missing.length === skus.length) return { mode: 'publish', label: '↑ Publish to Shopify' };
    if (missing.length) return { mode: 'add', missingSkus: missing, label: `+ Add missing sizes (${missing.length})` };
    return null;
  })();
  const incoming = openIncoming(product);

  const stockCard = () => {
    if (place === 'sa') return <div style={{ fontSize: 22, fontWeight: 800 }}>{displayStock(product.saStock ?? product.currentStock, unit)}</div>;
    if (place === 'library') {
      return (
        <>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{displayStock(product.currentStock, unit)}</div>
          <StockBreakdown sectors={product.sectors} unit={unit} size={12} fill />
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

  return (<>
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
            {oilPublish && (
              <button type="button" className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }}
                onClick={() => setPublishFor(oilPublish)}>
                {oilPublish.label}
              </button>
            )}
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
    {/* After the sheet, so it sits on top of it. */}
    {publishFor && (
      <PublishOilModal
        product={product}
        mode={publishFor.mode}
        missingSkus={publishFor.missingSkus}
        showToast={showToast}
        onClose={() => setPublishFor(null)}
        onDone={() => setReread((n) => n + 1)}
      />
    )}
  </>);
}
