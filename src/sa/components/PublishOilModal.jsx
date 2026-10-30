import { useState } from 'react';
import { OIL_PATTERN, OIL_SIZES, oilTitle, oilTag, oilSkus, variantTitle, variantCost, variantPrice, oilWarnings } from '../../../shared/shopify-product-pattern.js';

// Publish an oil to the SA Shopify store in the owner's pattern
// (HYPER_UPDATE_BACKLOG.md P7): ONE main product, the five sizes as variants,
// priced, costed from ONE number — the supplier's cost per litre — and on
// Point of Sale only. `mode` 'add' adds the sizes its main product lacks.
// Everything Shopify will receive is previewed here first; the server builds
// the same thing from the same shared file.
export default function PublishOilModal({ product, mode = 'publish', missingSkus = null, onClose, onDone, showToast }) {
  const all = oilSkus(product);
  const sizes = mode === 'add' && missingSkus ? all.filter(([, sku]) => missingSkus.includes(sku)) : all;
  const [costPerLitre, setCostPerLitre] = useState('');
  const [prices, setPrices] = useState(() => Object.fromEntries(sizes.map(([k]) => [k, String(OIL_SIZES[k].price)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const warnings = oilWarnings(product, costPerLitre);
  const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shopify/${mode === 'add' ? 'add-missing-variants' : 'publish'}/${product.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costPerLitre: costPerLitre === '' ? null : Number(costPerLitre), prices }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Shopify did not accept it'); return; }
      setResult(data);
      showToast(mode === 'add' ? `${data.added} size(s) added to "${data.productTitle}"` : `"${data.title}" created in Shopify`, 'success');
      onDone?.(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const row = (label, value) => (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
      <span style={{ width: 120, color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)' }}>{value || '—'}</span>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h2>{mode === 'add' ? 'Add the missing sizes' : 'Publish to Shopify'}: {product.name}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {result ? (
          <div>
            <div style={{ padding: '12px 14px', borderRadius: 8, marginBottom: 12, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', fontSize: 13 }}>
              {mode === 'add'
                ? <>Added {result.added} size(s) to <strong>{result.productTitle}</strong>{result.skus?.length ? `: ${result.skus.join(', ')}` : ''}.</>
                : <>Created <strong>{result.title}</strong> with {result.skus?.length} sizes: {result.skus?.join(', ')}.</>}
            </div>
            {mode !== 'add' && (result.posPublished ? (
              <div style={{ fontSize: 13, color: '#34d399', marginBottom: 10 }}>On Point of Sale, and no other channel.</div>
            ) : (
              <div role="alert" style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', color: '#fbbf24' }}>
                Created, but not on Point of Sale yet: {result.posError}
              </div>
            ))}
            {result.oldListings?.length > 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
                These SKUs are also on {result.oldListings.length} older listing(s) — archive them in Shopify once the new product is right:
                <ul style={{ margin: '6px 0 0 18px' }}>{result.oldListings.map((t) => <li key={t}>{t}</li>)}</ul>
              </div>
            )}
            {result.warnings?.length > 0 && <div style={{ fontSize: 12, color: '#fbbf24' }}>{result.warnings.join(' ')}</div>}
            <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Close</button></div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 12 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Supplier's cost per litre (AUD, ex GST)</label>
                <input className="input" type="number" min="0" step="0.01" value={costPerLitre} onChange={(e) => setCostPerLitre(e.target.value)} placeholder="e.g. 42.40" />
                <small style={{ color: 'var(--text-secondary)' }}>The cost per item of each size is worked out from it.</small>
              </div>
              <div style={{ fontSize: 12.5 }}>
                {row('Title', oilTitle(product))}
                {row('Type', OIL_PATTERN.productType)}
                {row('Vendor', OIL_PATTERN.vendor)}
                {row('Tag', oilTag(product))}
                {row('Category', 'Perfume Oils')}
                {row('Description', [product.supplier && `Supplier: ${product.supplier}`, product.supplier_code && `Supplier code: ${String(product.supplier_code).toUpperCase()}`].filter(Boolean).join(' · '))}
                {row('Status', 'Active')}
                {row('Channels', 'Point of Sale only')}
              </div>
            </div>

            <table className="table" style={{ fontSize: 12.5 }}>
              <thead><tr><th>Size</th><th>SKU</th><th>Price</th><th>Cost per item</th><th>Weight</th></tr></thead>
              <tbody>
                {sizes.map(([k, sku]) => (
                  <tr key={k}>
                    <td>{variantTitle(product, k)}</td>
                    <td style={{ fontFamily: 'monospace' }}>{sku}</td>
                    <td style={{ width: 110 }}>
                      <input className="input" type="number" min="0" step="0.01" value={prices[k]} aria-label={`Price ${sku}`}
                        onChange={(e) => setPrices((p) => ({ ...p, [k]: e.target.value }))} style={{ padding: '4px 8px' }} />
                    </td>
                    <td>{money(variantCost(costPerLitre, OIL_SIZES[k].volumeMl))}</td>
                    <td>{OIL_SIZES[k].weightG} g</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', margin: '6px 0 10px' }}>
              Every size: charge tax on, physical product, inventory tracked, sold when Shopify shows 0 (the platform keeps the stock).
              {sizes.some(([k]) => variantPrice(k, prices) !== OIL_SIZES[k].price) && ' Prices changed from the standard ones are sent as typed.'}
            </div>

            {warnings.length > 0 && (
              <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 10, fontSize: 12.5, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: '#fbbf24' }}>
                {warnings.map((w) => <div key={w}>{w}</div>)}
              </div>
            )}
            {error && (
              <div role="alert" style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171' }}>
                {error}
              </div>
            )}

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !sizes.length}>
                {busy ? 'Sending to Shopify…' : mode === 'add' ? `Add ${sizes.length} size(s) to Shopify` : 'Create in Shopify'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
