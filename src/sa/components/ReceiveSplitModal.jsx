import { useState } from 'react';
import { SECTORS, destinationByStock } from '../../../shared/sectors.js';
import { displayStock, displayUnit } from '../utils/unitConversion';
import RegisterFragranceModal from './RegisterFragranceModal';

// Receive a fragrance purchase order and split it between the stocks
// (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.3, S7–S8): one line per destination —
// the main store, SA and the four MUSE stocks. The lines must add up to what
// arrived (a typing error is refused, here and by the server, in the same
// words); a part receipt is allowed — type less than is left on the order.
// It opens with the whole delivery on SA's line, so one click receives it as
// before Stage 1. Anything that is not an oil (H4 D1: machines, spare parts,
// raw materials) is SA's and is not split: the window asks only what arrived.
// A Shopify PO names its company by its destination (P6, `destinationStock`):
// then only that company's stocks are offered and the delivery starts on its
// stock. If the server still refuses (another tab, an old screen), a pop-up
// says what to check and how to put it right; the attempt is recorded.
export default function ReceiveSplitModal({ poId, orderNumber, remaining, product, destinationStock = null, user, onClose, onDone, onRegistered, showToast }) {
  const isMl = product.unit === 'mL';
  const isOil = !product.category || product.category === 'OILS';
  const unitWord = displayUnit(product.unit);
  const toUnit = (v) => (isMl ? Math.round(parseFloat(v) * 1000 * 1000) / 1000 : parseFloat(v));
  const fromUnit = (v) => (isMl ? v / 1000 : v);
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const startQty = String(round3(fromUnit(Math.max(0, remaining))));
  const dest = destinationByStock(destinationStock);
  const firstStock = dest?.stock || 'SA';
  const stocks = dest ? SECTORS.filter((s) => dest.receiveInto.includes(s.key)) : SECTORS;

  const [arrived, setArrived] = useState(startQty);
  const [lines, setLines] = useState({ [firstStock]: startQty });
  const [wrongStock, setWrongStock] = useState(null); // { error, fix } — the pop-up
  // Until a line is typed in, SA's line follows "Arrived" (a part receipt
  // still goes to SA in one click).
  const [linesTouched, setLinesTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null); // { error, code, company, productId }
  const [registerFor, setRegisterFor] = useState(null); // { company, productId }
  // Unknown (the purchase orders page) stays undefined: the Register window then reads them itself (S4).
  const [registrations, setRegistrations] = useState(product.registrations);

  const arrivedQty = parseFloat(arrived) || 0;
  const linesTotal = round3(Object.values(lines).reduce((s, v) => s + (parseFloat(v) || 0), 0));
  const mismatch = isOil && Math.abs(linesTotal - arrivedQty) > 0.0005;
  const overOrder = toUnit(arrivedQty || 0) > remaining + 0.001;

  const changeArrived = (v) => {
    setArrived(v);
    if (!linesTouched) setLines({ [firstStock]: v });
  };
  const changeLine = (key, v) => {
    setLinesTouched(true);
    setLines((l) => ({ ...l, [key]: v }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!(arrivedQty > 0)) return showToast('Enter how much arrived', 'warning');
    if (mismatch) return;
    setBusy(true);
    setRefused(null);
    const qty = toUnit(arrivedQty);
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantityReceived: qty,
          ...(isOil && { lines: stocks.filter((s) => parseFloat(lines[s.key]) > 0).map((s) => ({ to: s.key, quantity: toUnit(lines[s.key]) })) }),
          notes: notes || (qty >= remaining - 0.001 ? 'Full quantity received' : `Partial quantity received: ${qty} of ${remaining}`),
          receivedBy: user?.username || user?.name || 'admin',
          userId: user?.id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Into a stock outside the PO's company (P6): blocked, recorded, and a
        // pop-up in the middle of the screen says what to check and how to fix it.
        if (data.code === 'WRONG_STOCK') { setWrongStock({ error: data.error, fix: data.fix }); return; }
        // Kept on screen, not only toasted: a NOT_REGISTERED refusal carries the
        // Register now button, and the person has to read which company.
        setRefused({ error: data.error || 'Could not receive the order', code: data.code, company: data.company, productId: data.productId });
        return;
      }
      showToast(`${orderNumber} received — ${displayStock(qty, product.unit)} of ${product.name}`, 'success');
      onDone(data);
    } catch (err) {
      showToast('Could not receive the order: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Receive {orderNumber} — {product.name}</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>

          <form onSubmit={submit}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Still to arrive on this order: <strong style={{ color: 'var(--text-primary)' }}>{displayStock(remaining, product.unit)}</strong>
            </div>

            <div className="form-group">
              <label>Arrived ({unitWord}) *</label>
              <input className="input" type="number" min="0" step="any" value={arrived}
                onChange={(e) => changeArrived(e.target.value)} required />
              {overOrder && (
                <small style={{ color: '#fbbf24', display: 'block', marginTop: 4 }}>
                  More than is left on the order — it will be refused.
                </small>
              )}
            </div>

            {isOil && <div className="form-group">
              <label>Where it goes ({unitWord})</label>
              {dest && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  This purchase order is for <strong style={{ color: 'var(--text-primary)' }}>{dest.label}</strong>, so it is
                  received into {stocks.map((s) => s.label).join(', ')} only.
                </div>
              )}
              {/* Two columns: six lines stacked pushed Confirm below the fold at 1366×768. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px 14px' }}>
                {stocks.map((s) => (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 112, fontSize: 12.5, flexShrink: 0 }}>{s.label}</span>
                    <input className="input" type="number" min="0" step="any" placeholder="0"
                      value={lines[s.key] || ''} onChange={(e) => changeLine(s.key, e.target.value)} />
                  </div>
                ))}
              </div>
              <small style={{ display: 'block', marginTop: 4, color: mismatch ? '#f87171' : 'var(--text-secondary)', fontWeight: mismatch ? 700 : 400 }}>
                {mismatch
                  ? `The lines add up to ${linesTotal} ${unitWord}; ${round3(arrivedQty)} ${unitWord} arrived.`
                  : `Lines: ${linesTotal} ${unitWord} of ${round3(arrivedQty)} ${unitWord} arrived.`}
              </small>
            </div>}

            <div className="form-group">
              <label>Notes (optional)</label>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Received in good condition" />
            </div>

            {refused && (
              <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span>{refused.error}</span>
                {refused.code === 'NOT_REGISTERED' && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => setRegisterFor({ company: refused.company || 'SA', productId: refused.productId || product.id })}>
                    Register now
                  </button>
                )}
              </div>
            )}

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || mismatch}
                style={{ background: '#10b981', borderColor: '#10b981' }}>
                {busy ? 'Saving…' : 'Confirm & Update Stock'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* The pop-up of a refused receipt (P6, owner 30 Oct): in the middle of
          the screen, above the receive window, with what happened and the fix. */}
      {wrongStock && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="wrong-stock-title" style={{
          position: 'fixed', inset: 0, zIndex: 99998, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg, #151c2c)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 14,
            padding: '26px 30px', maxWidth: 480, width: '92%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <h3 id="wrong-stock-title" style={{ margin: '0 0 12px', fontSize: 17, color: '#f87171' }}>Check this receipt — nothing was saved</h3>
            <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary, #e2e8f0)' }}>{wrongStock.error}</p>
            {wrongStock.fix && (
              <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-secondary, #94a3b8)' }}>
                <strong style={{ color: 'var(--text-primary, #e2e8f0)' }}>How to fix it: </strong>{wrongStock.fix}
              </p>
            )}
            <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text-muted, #64748b)' }}>
              This attempt was recorded in Activity.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" autoFocus onClick={() => setWrongStock(null)}>Review the receipt</button>
            </div>
          </div>
        </div>
      )}

      {/* A sibling, not a child: inside the .modal above it would be trapped in its box. */}
      {registerFor && (
        <RegisterFragranceModal
          product={{ ...product, id: registerFor.productId, registrations }}
          company={registerFor.company}
          fromRefusal
          showToast={showToast}
          onClose={() => setRegisterFor(null)}
          onDone={(regs, active) => {
            setRegistrations(regs);
            setRegisterFor(null);
            onRegistered?.(registerFor.productId, regs);
            // Only an active registration lifts the refusal (S3).
            if (active) { setRefused(null); showToast('Registered — press Confirm again', 'info'); }
          }}
        />
      )}
    </>
  );
}
