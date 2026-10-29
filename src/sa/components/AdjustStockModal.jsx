import { useEffect, useState } from 'react';
import { SECTORS, MUSE_STOCKS, sectorLabel } from '../../../shared/sectors.js';
import { reasonsFor } from '../../../shared/stock-reasons.js';
import { displayStock } from '../utils/unitConversion';
import MlHelper from './MlHelper';
import OperatorPicker from './OperatorPicker';
import ConfirmModal from './ConfirmModal';

// Adjust stock (PRD_H2_STOCK_MANAGEMENT.md §2.2, §2.4). The server applies the
// rule (sectors.js adjustStock); this window shows the balance first and warns
// as soon as a number breaks it, so a refusal is rarely the first anyone hears
// of it (D2).
//   A non-oil product (Stock Management): what the Stock and Raw Materials
//   pages did — add or remove, the reason, who did it.
//   An oil (Fragrance Library, decision O1): ONE stock of it. It replaces the
//   old Stock page's oil adjustment (always SA) and the Transfers page's Count
//   and Use (D3).
//     SA: may go negative (S3).
//     MUSE add: a count. MUSE remove "Used in production": a use, with the
//     order number, from the stock, then MUSE (shared), then SA (S4, S9).
//     Any other MUSE removal stops at zero (A7).
//   The main store is not offered (D4): a wrong receipt is corrected on it.
export default function AdjustStockModal({ product, onClose, onDone, showToast }) {
  const oil = product.category === 'OILS';
  const regs = product.registrations || {};
  const stocks = oil ? SECTORS.filter((s) => s.key !== 'MAIN' && regs[s.company]?.active) : [];
  const [stock, setStock] = useState(stocks[0]?.key || 'SA');
  const [type, setType] = useState('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [operators, setOperators] = useState([]);
  const [operatorIds, setOperatorIds] = useState([]);
  const [operatorText, setOperatorText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // Fails softly, as on the Stock page: the picker offers a name field instead.
  useEffect(() => {
    fetch('/api/warehouse-operators')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setOperators(Array.isArray(d) ? d : []))
      .catch(() => setOperators([]));
  }, []);

  const muse = oil && MUSE_STOCKS.includes(stock);
  const reasons = reasonsFor(type, { muse });
  // A reason that is not on the new list (Technician, then MUSE) is cleared.
  useEffect(() => { if (reason && !reasons.some((r) => r.id === reason)) setReason(''); }, [stock, type]);

  const bal = (k) => (!oil ? product.currentStock
    : product.sectors?.[k] ?? (k === 'SA' ? (product.saStock ?? product.currentStock) : 0));
  const qty = parseFloat(quantity) || 0;
  const use = muse && type === 'remove' && reason === 'production';
  const held = Math.max(bal(stock), 0);
  // A7: blocked here as on the server, with both figures and the right path.
  const belowZero = muse && type === 'remove' && !use && qty > held + 0.001;
  const label = oil ? sectorLabel(stock) : product.name;
  const unitWord = oil ? 'mL' : (product.unit || 'units');

  const submit = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const body = { productId: product.id, type, quantity: qty, reason, note: notes, operatorIds, ...(oil && { stock, reference }) };
      const res = await fetch(oil ? '/api/sectors/adjust' : '/api/stock/adjust', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setRefused(data.error || 'Could not adjust the stock'); return; }
      showToast(oil ? `${type === 'add' ? 'Added to' : 'Removed from'} ${label}` : `Stock ${type === 'add' ? 'added' : 'removed'}`, 'success');
      onDone(oil ? data : { total: data.newStock });
    } catch (err) {
      setRefused('Could not adjust the stock: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (belowZero) return;
    // Removing is confirmed first, as on the Stock page.
    if (type === 'remove') setConfirming(true);
    else submit();
  };

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="modal-header">
          <h2>Adjust stock: {product.name}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={onSubmit}>
          {oil ? (
            <div className="form-group">
              <label>Stock</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stocks.map((s) => (
                  <button key={s.key} type="button" onClick={() => { setStock(s.key); setRefused(null); }}
                    aria-pressed={stock === s.key}
                    className={stock === s.key ? 'btn btn-primary' : 'btn btn-secondary'}
                    style={{ fontSize: 12, padding: '6px 12px' }}>
                    {s.label}
                    <span style={{ marginLeft: 6, fontWeight: 700, color: stock === s.key ? 'inherit' : bal(s.key) < 0 ? '#f87171' : 'var(--text-secondary)' }}>
                      {displayStock(bal(s.key), product.unit)}
                    </span>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>
                {stocks.length ? 'Only the companies this oil is registered in.' : 'This oil is not registered in any company: register it first.'}
                {' '}The main store is corrected on its receipt, not here.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Current stock: <strong style={{ color: 'var(--text-primary)' }}>{displayStock(product.currentStock, product.unit)}</strong>
              {product.unitPerBox > 1 && ` (${product.stockBoxes} boxes of ${product.unitPerBox})`}
            </div>
          )}

          <div className="form-group">
            <label>Type</label>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" className={`btn ${type === 'add' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setType('add')} style={{ flex: 1 }}>➕ Add</button>
              <button type="button" className={`btn ${type === 'remove' ? 'btn-danger' : 'btn-secondary'}`} onClick={() => setType('remove')} style={{ flex: 1 }}>➖ Remove</button>
            </div>
          </div>

          <div className="form-group">
            <label>Quantity ({unitWord})</label>
            <input type="number" className="input" value={quantity} onChange={(e) => setQuantity(e.target.value)}
              placeholder={oil ? 'e.g. 10000 = 10 L' : `Enter quantity in ${unitWord}`} required min="1" step="any" />
            {oil && <MlHelper value={quantity} unit={product.unit} />}
          </div>

          <div className="form-group">
            <label>Why *</label>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)} required>
              <option value="">Choose a reason…</option>
              {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>

          {use && (
            <div className="form-group">
              <label>Order number *</label>
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. #1050" required />
            </div>
          )}

          <OperatorPicker operators={operators} selected={operatorIds} onChange={setOperatorIds} label="Who did it"
            fallbackValue={operatorText} onFallbackChange={setOperatorText} />

          <div className="form-group">
            <label>Notes{reason === 'other' ? ' *' : ' (optional)'}</label>
            <textarea className="input" rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} required={reason === 'other'} />
          </div>

          {belowZero && (
            <div role="alert" style={{ color: '#f87171', fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>
              {label} holds {displayStock(held, product.unit)}. A removal can bring it to zero, not below.
              If {label} used oil from SA's shelf, choose "Used in production" with the order number.
            </div>
          )}
          {use && qty > held + 0.001 && (
            <div style={{ color: '#fbbf24', fontSize: 12, marginBottom: 10 }}>
              {label} holds {displayStock(held, product.unit)}. The rest is taken from {stock === 'MUSE' ? 'SA' : 'MUSE (shared), then SA'}, recorded as used for {label}.
            </div>
          )}
          {(!oil || stock === 'SA') && type === 'remove' && qty > bal('SA') + 0.001 && (
            <div style={{ color: '#fbbf24', fontSize: 12, marginBottom: 10 }}>
              {oil ? 'SA' : 'It'} holds {displayStock(bal('SA'), product.unit)}. It will show as negative.
            </div>
          )}
          {refused && (
            <div role="alert" style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171' }}>
              {refused}
            </div>
          )}

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || belowZero || (oil && !stocks.length)}>
              {busy ? 'Saving…' : 'Confirm adjustment'}
            </button>
          </div>
        </form>
      </div>
    </div>
    {/* Outside the overlay, so a click on it does not close the window too. */}
    {confirming && (
      <ConfirmModal
        message={`Remove ${displayStock(qty, product.unit)} from ${oil ? `${label} for "${product.name}"` : `"${product.name}"`}? This adjusts live stock and writes a ledger entry.`}
        onConfirm={() => { setConfirming(false); submit(); }}
        onCancel={() => setConfirming(false)}
      />
    )}
    </>
  );
}
